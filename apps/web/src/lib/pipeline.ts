import type { DiagramIR, DiagramLayout } from '@octo-draw/core'
import { applyPins } from '@octo-draw/core/src/layout/pins'
import { useStore } from '../store'
import { layoutInWorker } from './layoutClient'
import { collapseGroups, drillTargets, focusGroup } from './drillCore'
import { pageTree } from './coreV2'
import { parsedDoc } from './docModel'
import { pruneStack } from './pages'
import { currentPins, takeViewFit } from './view'

let base: DiagramLayout | null = null
let baseIR: DiagramIR | null = null
let run = 0
let timer: ReturnType<typeof setTimeout> | undefined
let firstLayout = true
/** the view (page + focus) the last good layout was for */
let baseView = ''
let treeSrc: string | null = null

type Parsed = ReturnType<typeof parsedDoc>
interface View {
	ir: DiagramIR
	focusIR: DiagramIR
	drill: Record<string, string>
	expandable: Record<string, 'src' | 'ai'>
	layout?: DiagramLayout
}
/**
 * Per parse result (so per code text): the derived view of each page / focus
 * / collapse combination and its ELK layout. Going back to a page you just
 * saw is instant: no re-parse, no re-layout.
 */
const views = new WeakMap<Parsed, Map<string, View>>()
const VIEW_CACHE = 40

const viewId = (s = useStore.getState()) => {
	const top = s.crumbs[s.crumbs.length - 1]
	return `${top.page}\u0000${top.focus ?? ''}`
}

/** Focus → collapse → drill targets / expandable nodes for one view of a page. */
export function deriveView(pageIR: DiagramIR, page: string, focus: string | undefined, collapsed: string[], pageNames: string[]): Omit<View, 'layout'> {
	const focusIR = focus ? focusGroup(pageIR, focus) : pageIR
	let ir = collapseGroups(focusIR, collapsed.filter((k) => k !== focus))
	// collapsed groups also show how many direct children they hold
	if (ir.nodes.some((n) => n.ext?.collapsed !== undefined)) {
		const direct = new Map<string, number>()
		for (const n of pageIR.nodes) if (n.parent) direct.set(n.parent, (direct.get(n.parent) ?? 0) + 1)
		ir = { ...ir, nodes: ir.nodes.map((n) => (n.ext?.collapsed !== undefined && n.ext.children === undefined ? { ...n, ext: { ...n.ext, children: String(direct.get(n.key) ?? 0) } } : n)) }
	}
	const drill = drillTargets(ir, pageNames, page)
	const expandable: Record<string, 'src' | 'ai'> = {}
	for (const n of ir.nodes) {
		if (n.ext?.ghost === 'true') {
			delete drill[n.key]
			continue
		}
		if (ir.kind !== 'flowchart' || drill[n.key] !== undefined || n.isContainer || n.ext?.collapsed !== undefined) continue
		expandable[n.key] = n.ext?.src ? 'src' : 'ai'
	}
	return { ir, focusIR, drill, expandable }
}

/**
 * Code → parse (memoized per code text) → focus/collapse → ELK layout
 * (debounced, cached per view), pins applied on top. Keeps the last good
 * layout on errors.
 */
export function startPipeline() {
	const relayout = async () => {
		const s = useStore.getState()
		const id = ++run
		let src = s.code
		// while the AI streams, ignore the trailing partial line
		if (s.aiBusy && !src.endsWith('\n')) src = src.slice(0, src.lastIndexOf('\n') + 1)
		const parsed = parsedDoc(src)
		const pageNames = parsed.pages.map((p) => p.name)
		const groupsOf = (name: string) => parsed.pages.find((p) => p.name === name)?.ir.nodes.filter((n) => n.isContainer).map((n) => n.key) ?? null
		// the page (or focused group) may have been renamed or deleted
		const crumbs = pruneStack(s.crumbs, pageNames, groupsOf)
		const top = crumbs[crumbs.length - 1]
		const navPatch = crumbs.length !== s.crumbs.length ? { crumbs, page: top.page } : {}
		if (navPatch.crumbs) useStore.setState({ selection: null })
		const page = parsed.pages.find((p) => p.name === top.page) ?? parsed.pages[0]
		const pageErrors = page.diagnostics.some((d) => d.severity === 'error')
		const treePatch = treeSrc !== src ? { tree: pageTree(src) } : {}
		treeSrc = src
		useStore.setState({ ...navPatch, ...treePatch, diagnostics: s.aiBusy ? [] : parsed.diagnostics, rootTitle: parsed.pages[0].ir.title, pageNames: sameList(pageNames, s.pageNames) ? s.pageNames : pageNames })
		const view = viewId()
		if (pageErrors && base && view === baseView) {
			useStore.setState({ layoutPending: false })
			return
		}
		const st = useStore.getState()
		const collapsed = st.collapsed[top.page] ?? []
		const key = `${view}\u0000${[...collapsed].sort().join('\u0001')}`
		let cache = views.get(parsed)
		if (!cache) views.set(parsed, (cache = new Map()))
		let v = cache.get(key)
		if (!v) {
			v = deriveView(page.ir, top.page, top.focus, collapsed, pageNames)
			cache.set(key, v)
			if (cache.size > VIEW_CACHE) cache.delete(cache.keys().next().value!)
		}
		try {
			const layout = v.layout ?? (await layoutInWorker(v.ir))
			v.layout = layout
			if (id !== run) return
			base = layout
			baseIR = v.ir
			baseView = view
			useStore.setState({ ir: v.ir, pageIR: page.ir, focusIR: v.focusIR, drill: v.drill, expandable: v.expandable, layout: applyPins(v.ir, layout, currentPins()), layoutPending: false })
			const fit = takeViewFit()
			if (firstLayout || fit) {
				firstLayout = false
				useStore.setState({ fitRequest: useStore.getState().fitRequest + 1, fitStrict: false })
			}
		} catch (err) {
			console.warn('layout failed', err)
			if (id === run) useStore.setState({ layoutPending: false })
		}
	}

	const schedule = (ms: number) => {
		clearTimeout(timer)
		useStore.setState({ layoutPending: true })
		timer = setTimeout(relayout, ms)
	}

	useStore.subscribe((s, prev) => {
		if (s.code !== prev.code || (prev.aiBusy && !s.aiBusy)) schedule(firstLayout ? 0 : 150)
		else if (s.crumbs !== prev.crumbs || s.collapsed !== prev.collapsed) schedule(0)
		else if ((s.pins !== prev.pins || s.page !== prev.page) && base && baseIR) {
			useStore.setState({ layout: applyPins(baseIR, base, currentPins(s)) })
		}
	})
	flush = () => schedule(0)
	schedule(0)
}

let flush: (() => void) | null = null
/** Lays out right away instead of after the typing debounce (structural edits from the canvas). */
export function relayoutNow() {
	flush?.()
}

function sameList(a: string[], b: string[]) {
	return a.length === b.length && a.every((x, i) => x === b[i])
}
