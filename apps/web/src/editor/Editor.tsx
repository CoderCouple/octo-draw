import { useEffect, useRef } from 'react'
import { Annotation, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, hoverTooltip, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder, type DecorationSet } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { linter, lintGutter, type Diagnostic as CMDiagnostic } from '@codemirror/lint'
import { detectFormat, importText, pageAt, parseOctoPages, printOcto, splitPages, findPage } from '@octo-draw/core'
import { octoHighlight, octoLanguage } from './language'
import { iconPreview, octoCompletions } from './completion'
import { getIcon, iconSvgString, loadIcons } from '../lib/icons'
import { redo, setCode, showToast, undo, useStore } from '../store'
import { bindEditor, localCodeEdit } from '../lib/sync'
import { importMessage, mergeImportPins, warningsAction } from '../lib/importing'
import { setPage } from '../lib/view'

/** The current page's section: header line gets a tab-like mark, body lines a subtle rail. */
const setPageRange = StateEffect.define<{ from: number; to: number; head: boolean } | null>()
const pageField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes)
		for (const e of tr.effects) {
			if (!e.is(setPageRange)) continue
			if (!e.value) {
				deco = Decoration.none
				continue
			}
			const doc = tr.state.doc
			const from = Math.min(e.value.from, doc.length)
			const to = Math.max(from, Math.min(e.value.to, doc.length))
			const ranges = []
			const first = doc.lineAt(from).number
			// `to` is exclusive and sits at the next page's line start
			const last = to > from ? doc.lineAt(Math.max(from, to - 1)).number : first
			for (let n = first; n <= last; n++) {
				const cls = n === first && e.value.head ? 'cm-octo-page-head' : 'cm-octo-page-line'
				ranges.push(Decoration.line({ class: cls }).range(doc.line(n).from))
			}
			deco = Decoration.set(ranges)
		}
		return deco
	},
	provide: (f) => EditorView.decorations.from(f),
})

const External = Annotation.define<boolean>()

const setSelectedLine = StateEffect.define<number | null>()
const selectedLineField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(deco, tr) {
		deco = deco.map(tr.changes)
		for (const e of tr.effects) {
			if (e.is(setSelectedLine)) {
				if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) deco = Decoration.none
				else {
					const line = tr.state.doc.line(e.value)
					deco = Decoration.set([Decoration.line({ class: 'cm-octo-selected' }).range(line.from)])
				}
			}
		}
		return deco
	},
	provide: (f) => EditorView.decorations.from(f),
})

const octoLinter = linter(
	(view) => {
		const src = view.state.doc.toString()
		if (useStore.getState().aiBusy) return []
		const len = src.length
		return parseOctoPages(src).diagnostics.map(
			(d): CMDiagnostic => {
				const from = Math.max(0, Math.min(len, d.from))
				const to = Math.max(from, Math.min(len, d.to))
				return { from, to, severity: d.severity, message: d.message }
			},
		)
	},
	{ delay: 250 },
)

/** Pasting mermaid or ASCII art straight into the editor converts it to octo code. */
const convertingPaste = EditorView.domEventHandlers({
	paste(event, view) {
		const text = event.clipboardData?.getData('text/plain')
		if (!text) return false
		const fmt = detectFormat(text)
		if (fmt !== 'mermaid' && fmt !== 'ascii') return false
		const res = importText(text)
		if (!res || !res.ir.nodes.length) return false
		event.preventDefault()
		const code = printOcto(res.ir)
		const blank = !view.state.doc.toString().trim()
		const sel = view.state.selection.main
		view.dispatch(
			blank
				? { changes: { from: 0, to: view.state.doc.length, insert: code } }
				: { changes: { from: sel.from, to: sel.to, insert: code }, selection: { anchor: sel.from + code.length } },
		)
		// keep the source arrangement: blank editor → just these pins, otherwise override the imported keys
		mergeImportPins(res.pins, blank ? 'replace' : 'append')
		const warnings = res.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message)
		showToast(importMessage(`Converted ${fmt === 'ascii' ? 'ASCII' : fmt} diagram`, { confidence: res.confidence, warnings }), [
			...warningsAction(warnings),
			{
				label: 'Paste raw instead',
				run: () => {
					undo()
					const v = view.state.selection.main
					view.dispatch({ changes: { from: v.from, to: v.to, insert: text } })
				},
			},
		])
		return true
	},
})

/** Hovering an `icon: name` value shows the icon, its label and canonical name. */
const iconHover = hoverTooltip(async (view, pos) => {
	const line = view.state.doc.lineAt(pos)
	const re = /\bicon\s*:\s*("?)([^,\]"]+)\1/g
	for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
		const name = m[2].trim()
		const start = line.from + m.index + m[0].indexOf(m[2])
		const end = start + m[2].length
		if (pos < start || pos > end || !name) continue
		await loadIcons()
		const hit = getIcon(name)
		return {
			pos: start,
			end,
			above: true,
			create: () => {
				const dom = document.createElement('div')
				dom.className = 'cm-octo-icon-tip'
				const svg = iconSvgString(name, 32)
				const glyph = document.createElement('span')
				glyph.className = 'cm-octo-icon-tip-glyph'
				if (svg) glyph.innerHTML = svg
				else glyph.textContent = '?'
				const text = document.createElement('div')
				const title = document.createElement('strong')
				const sub = document.createElement('span')
				if (hit?.kind === 'catalog') {
					title.textContent = hit.icon.label
					sub.textContent = hit.icon.name + (hit.icon.brandColor ? ' · brand logo' : hit.icon.badge ? ` · ${hit.icon.badge} badge` : '')
				} else if (hit) {
					title.textContent = name
					sub.textContent = 'lucide glyph'
				} else {
					title.textContent = 'Unknown icon'
					sub.textContent = 'drawn as a text badge'
				}
				text.append(title, sub)
				dom.append(glyph, text)
				return { dom }
			},
		}
	}
	return null
})

const theme = EditorView.theme({
	'&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--card)', color: 'var(--foreground)' },
	'.cm-scroller': { fontFamily: 'var(--font-family-mono)', lineHeight: '1.65' },
	'.cm-content': { caretColor: 'var(--foreground-strong)', padding: '10px 0' },
	'.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--foreground-subtle)', border: 'none', paddingLeft: '6px' },
	'.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--muted) 60%, transparent)' },
	'.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--muted-foreground)' },
	'.cm-octo-page-line': { boxShadow: 'inset 2px 0 0 var(--border)' },
	'.cm-octo-page-head': { boxShadow: 'inset 2px 0 0 var(--foreground-subtle)', backgroundColor: 'color-mix(in srgb, var(--muted) 70%, transparent)', fontWeight: 600 },
	'.cm-octo-selected': { backgroundColor: 'var(--highlight) !important', boxShadow: 'inset 2px 0 0 var(--foreground-strong)' },
	'&.cm-focused': { outline: 'none' },
	'.cm-cursor': { borderLeftColor: 'var(--foreground-strong)', borderLeftWidth: '2px' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
	'.cm-tooltip': { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
	'.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px' },
	'.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' },
	'.cm-completionDetail': { opacity: 0.6, marginLeft: '8px', fontStyle: 'normal' },
	'.cm-octo-icon-preview': { display: 'inline-flex', width: '16px', height: '16px', marginRight: '8px', verticalAlign: '-3px' },
	'.cm-octo-icon-tip': { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px 8px 10px', fontFamily: 'var(--font-family-sans)', fontSize: '12px' },
	'.cm-octo-icon-tip-glyph': { display: 'inline-flex', width: '32px', height: '32px', alignItems: 'center', justifyContent: 'center', color: 'var(--foreground-strong)' },
	'.cm-octo-icon-tip strong': { display: 'block', fontWeight: 600, color: 'var(--foreground-strong)' },
	'.cm-octo-icon-tip span:not(.cm-octo-icon-tip-glyph)': { color: 'var(--muted-foreground)' },
	'.cm-diagnostic': { padding: '4px 8px' },
	'.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--destructive)', textUnderlineOffset: '3px' },
})

/** Minimal change between two strings (common prefix/suffix), so remote edits keep the cursor. */
function diff(a: string, b: string) {
	let start = 0
	const max = Math.min(a.length, b.length)
	while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++
	let endA = a.length
	let endB = b.length
	while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
		endA--
		endB--
	}
	return { from: start, to: endA, insert: b.slice(start, endB) }
}

/** page the caret last asked for (so a caret switch doesn't scroll the editor) */
let caretPage: string | null = null
function followCaret(view: EditorView) {
	const name = pageAt(view.state.doc.toString(), view.state.selection.main.head)
	if (name === useStore.getState().page) return
	caretPage = name
	if (!setPage(name)) caretPage = null
}

export function Editor() {
	const host = useRef<HTMLDivElement>(null)
	const viewRef = useRef<EditorView | null>(null)

	useEffect(() => {
		const extensions: Extension[] = [
			lineNumbers(),
			highlightActiveLineGutter(),
			highlightActiveLine(),
			drawSelection(),
			indentOnInput(),
			bracketMatching(),
			closeBrackets(),
			octoLanguage,
			octoHighlight,
			octoLinter,
			lintGutter(),
			autocompletion({ override: [octoCompletions], icons: false, addToOptions: [iconPreview] }),
			iconHover,
			selectedLineField,
			pageField,
			convertingPaste,
			placeholder('Describe your diagram in code… e.g.  Users > API > DB'),
			keymap.of([
				{ key: 'Mod-z', run: () => (undo(), true), preventDefault: true },
				{ key: 'Mod-Shift-z', run: () => (redo(), true), preventDefault: true },
				{ key: 'Mod-y', run: () => (redo(), true), preventDefault: true },
				...closeBracketsKeymap,
				...completionKeymap,
				...defaultKeymap,
				indentWithTab,
			]),
			EditorState.tabSize.of(2),
			theme,
			EditorView.lineWrapping,
			EditorView.updateListener.of((u) => {
				// the caret picks the canvas page
				if (u.selectionSet && !u.transactions.some((tr) => tr.annotation(External))) followCaret(u.view)
				if (!u.docChanged || u.transactions.some((tr) => tr.annotation(External))) return
				const text = u.state.doc.toString()
				const changes: { from: number; to: number; insert: string }[] = []
				u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }))
				// live sync gets the transaction's changes (OT), not a whole-text replace
				localCodeEdit(changes, text)
				setCode(text, { tag: 'type', ms: 1000 })
			}),
		]
		const view = new EditorView({
			state: EditorState.create({ doc: useStore.getState().code, extensions }),
			parent: host.current!,
		})
		viewRef.current = view
		// dev-only handle for headless tests
		if (import.meta.env.DEV) (window as unknown as { __octoView?: EditorView }).__octoView = view
		const unbind = bindEditor({
			getText: () => view.state.doc.toString(),
			applyRemote: (changes) => view.dispatch({ changes, annotations: External.of(true) }),
		})

		/** Marks the current page's lines; `scroll` brings its header into view. */
		const markPage = (scroll: boolean) => {
			const s = useStore.getState()
			const pages = splitPages(view.state.doc.toString())
			if (pages.length <= 1) {
				view.dispatch({ effects: setPageRange.of(null) })
				return
			}
			const p = findPage(pages, s.page) ?? pages[0]
			const effects: StateEffect<unknown>[] = [setPageRange.of({ from: p.from, to: p.to, head: p.name !== '' })]
			// don't yank the view away from where the user is typing
			if (scroll && pageAt(view.state.doc.toString(), view.state.selection.main.head) !== p.name) effects.push(EditorView.scrollIntoView(p.from, { y: 'start', yMargin: 8 }))
			view.dispatch({ effects })
		}
		markPage(true)

		const unsub = useStore.subscribe((s, prev) => {
			if (s.page !== prev.page) markPage(caretPage !== s.page)
			else if (s.code !== prev.code || s.pageNames !== prev.pageNames) markPage(false)
			// a page header being typed: follow it once the pipeline knows the new name
			if (s.pageNames !== prev.pageNames && view.hasFocus) followCaret(view)
			if (s.code !== prev.code) {
				const cur = view.state.doc.toString()
				if (cur !== s.code) {
					const change = diff(cur, s.code)
					view.dispatch({ changes: change, annotations: External.of(true) })
				}
			}
			if (s.selection !== prev.selection || s.ir !== prev.ir) {
				const key = s.selection?.kind === 'node' ? s.selection.key : null
				const node = key ? s.ir?.nodes.find((n) => n.key === key) : null
				const line = node?.span?.line ?? null
				const effects: StateEffect<unknown>[] = [setSelectedLine.of(line)]
				if (line && s.selection !== prev.selection && line <= view.state.doc.lines) {
					effects.push(EditorView.scrollIntoView(view.state.doc.line(line).from, { y: 'nearest' }))
				}
				view.dispatch({ effects })
			}
		})
		return () => {
			unsub()
			unbind()
			view.destroy()
		}
	}, [])

	return <div className="editor-host" ref={host} />
}
