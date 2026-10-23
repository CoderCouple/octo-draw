import { parseOcto, printOcto, type DiagramIR, type IREdge, type IRNode, type Point } from '@octo-draw/core'
import { makeSelection, pushHistory, selectedIds, selectedKeys, snapshot, uid, useStore, type FreeShape } from '../store'
import { translateShape } from '../canvas/freehand'
import { deleteSelection } from './actions'
import { parsePage, splitPages } from './drillCore'
import { currentPins } from './view'
import { withPagePins } from './pages'

/** What we put on the clipboard: octo DSL for nodes (plain text, round-trips through chat apps) + free shapes. */
export interface ClipPayload {
	v: 1
	dsl: string
	shapes: FreeShape[]
	/** top-left of copied pinned nodes, so a paste lands next to the original */
	positions: Record<string, Point>
}

const MARK = 'data-octo-draw'
const DIRECTIVE = /^\s*(title|direction|colorMode|styleMode|typeface)\b/

let memory: ClipPayload | null = null
let pasteCount = 0

/** Builds a payload from the current selection (null when nothing is selected). */
export function selectionPayload(): ClipPayload | null {
	const s = useStore.getState()
	const ids = new Set(selectedIds(s.selection))
	const keys = selectedKeys(s.selection).filter((k) => !k.startsWith('ghost:'))
	const shapes = s.shapes.filter((x) => ids.has(x.id))
	let dsl = ''
	const positions: Record<string, Point> = {}
	if (keys.length && s.ir) {
		const ir = s.pageIR ?? s.ir
		// selected nodes plus everything inside selected groups
		const take = new Set(keys)
		let grew = true
		while (grew) {
			grew = false
			for (const n of ir.nodes) if (n.parent && take.has(n.parent) && !take.has(n.key)) take.add(n.key), (grew = true)
		}
		const nodes: IRNode[] = ir.nodes.filter((n) => take.has(n.key)).map((n) => ({ ...n, parent: n.parent && take.has(n.parent) ? n.parent : undefined, span: undefined }))
		const edges = ir.edges.filter((e) => take.has(e.from) && take.has(e.to))
		dsl = printFragment({ ...ir, title: undefined, nodes, edges })
		const pins = currentPins(s)
		// only hand-placed (pinned) nodes keep a position; the rest is auto-laid out next to the diagram
		for (const k of take) {
			const n = s.layout?.nodes[k]
			if (n && pins[k]) positions[k] = { x: n.x, y: n.y }
		}
	}
	if (!dsl && !shapes.length) return null
	return { v: 1, dsl, shapes, positions }
}

/** printOcto without the header directives, edge keys re-derived (no stray ids). */
function printFragment(ir: DiagramIR): string {
	const counts = new Map<string, number>()
	const edges = ir.edges.map((e): IREdge => {
		const pair = `${e.from}->${e.to}`
		const n = counts.get(pair) ?? 0
		counts.set(pair, n + 1)
		return { ...e, key: `${pair}#${n}` }
	})
	return printOcto({ ...ir, edges, kind: 'flowchart' })
		.split('\n')
		.filter((l) => !DIRECTIVE.test(l))
		.join('\n')
		.trim()
}

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function plainText(p: ClipPayload): string {
	if (p.dsl) return p.dsl + '\n'
	return p.shapes
		.map((x) => x.text ?? '')
		.filter(Boolean)
		.join('\n')
}

/** `copy` / `cut` handler: writes octo DSL as text/plain and the full payload in text/html. */
export function handleCopy(e: ClipboardEvent, cut = false) {
	if (isTypingTarget(e.target) || hasTextSelection()) return
	const p = selectionPayload()
	if (!p || !e.clipboardData) return
	e.preventDefault()
	memory = p
	pasteCount = 0
	const text = plainText(p)
	e.clipboardData.setData('text/plain', text)
	e.clipboardData.setData('text/html', `<pre ${MARK}="${encodeURIComponent(JSON.stringify(p))}">${escapeHtml(text)}</pre>`)
	if (cut) deleteSelection()
}

/** Our own payload from a paste event's html, if present. */
export function payloadFromClipboard(dt: DataTransfer): ClipPayload | null {
	const html = dt.getData('text/html')
	const m = html && new RegExp(`${MARK}="([^"]*)"`).exec(html)
	if (m) {
		try {
			const p = JSON.parse(decodeURIComponent(m[1])) as ClipPayload
			if (p && p.v === 1) return p
		} catch {
			// not ours
		}
	}
	// same tab, clipboard stripped of html: match by text
	const text = dt.getData('text/plain')
	if (memory && text && text.trim() === plainText(memory).trim()) return memory
	return null
}

/** Pastes a payload: shapes get new ids, nodes that already exist get fresh keys (`API 2`). One undo step. */
export function pastePayload(p: ClipPayload, offset?: number) {
	pasteCount++
	const d = offset ?? 24 * pasteCount
	const s = useStore.getState()
	pushHistory(snapshot())
	const shapes = p.shapes.map((x) => ({ ...translateShape(x, d, d), id: uid() }))
	let code = s.code
	const pins = currentPins(s)
	const newKeys: string[] = []
	if (p.dsl.trim()) {
		const { ir } = parseOcto(p.dsl)
		const taken = new Set((s.ir?.nodes ?? []).map((n) => n.key))
		for (const n of parsePage(s.code, s.page)?.ir.nodes ?? []) taken.add(n.key)
		const rename = new Map<string, string>()
		for (const n of ir.nodes) {
			if (!taken.has(n.key)) {
				rename.set(n.key, n.key)
				taken.add(n.key)
				continue
			}
			const base = n.key.replace(/ \d+$/, '')
			let i = 2
			while (taken.has(`${base} ${i}`)) i++
			rename.set(n.key, `${base} ${i}`)
			taken.add(`${base} ${i}`)
		}
		const r = (k: string) => rename.get(k) ?? k
		const frag = printFragment({
			...ir,
			nodes: ir.nodes.map((n) => ({ ...n, key: r(n.key), parent: n.parent && r(n.parent) })),
			edges: ir.edges.map((e) => ({ ...e, from: r(e.from), to: r(e.to) })),
		})
		// into the current page's section
		const page = splitPages(code).find((x) => x.name === s.page)
		const end = page ? page.to : code.length
		const head = code.slice(0, end).replace(/\s*$/, '')
		const tail = code.slice(end)
		code = `${head}\n\n${frag}\n${tail ? '\n' + tail : ''}`
		for (const n of ir.nodes) {
			newKeys.push(r(n.key))
			const pos = p.positions[n.key]
			if (pos && !n.parent) pins[r(n.key)] = { x: Math.round(pos.x + d), y: Math.round(pos.y + d) }
		}
	}
	useStore.setState({
		code,
		pins: withPagePins(s.pins, s.page, pins, s.pageNames),
		shapes: shapes.length ? [...s.shapes, ...shapes] : s.shapes,
		selection: makeSelection(
			shapes.map((x) => x.id),
			newKeys,
		),
		tool: 'select',
	})
}

/** Cmd+D: duplicate the selection in place (offset), without touching the system clipboard. */
export function duplicateSelection() {
	const p = selectionPayload()
	if (p) pastePayload(p, 24)
}

/** Cmd+A: every free shape and diagram node. */
export function selectAll() {
	const s = useStore.getState()
	useStore.setState({
		selection: makeSelection(
			s.shapes.map((x) => x.id),
			Object.keys(s.layout?.nodes ?? {}),
		),
		tool: 'select',
	})
}

export function isTypingTarget(t: EventTarget | null) {
	const el = t as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || !!el.isContentEditable || !!el.closest?.('.cm-editor'))
}

function hasTextSelection() {
	const sel = window.getSelection()
	return !!sel && !sel.isCollapsed && sel.toString().length > 0
}
