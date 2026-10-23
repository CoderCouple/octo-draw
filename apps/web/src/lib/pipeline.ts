import type { DiagramIR, DiagramLayout } from '@octo-draw/core'
import { applyPins } from '@octo-draw/core/src/layout/pins'
import { useStore } from '../store'
import { layoutInWorker } from './layoutClient'
import { collapseGroups, drillTargets, focusGroup, parseOctoPages } from './drillCore'
import { pruneStack } from './pages'
import { currentPins, takeViewFit } from './view'

let base: DiagramLayout | null = null
let baseIR: DiagramIR | null = null
let run = 0
let timer: ReturnType<typeof setTimeout> | undefined
let firstLayout = true
/** the view (page + focus) the last good layout was for */
let baseView = ''

const viewId = (s = useStore.getState()) => {
	const top = s.crumbs[s.crumbs.length - 1]
	return `${top.page}\u0000${top.focus ?? ''}`
}

/**
 * Code → parse the current page → focus/collapse → ELK layout (debounced), pins
 * applied on top. Keeps the last good layout on errors.
 */
export function startPipeline() {
	const relayout = async () => {
		const s = useStore.getState()
		const id = ++run
		let src = s.code
		// while the AI streams, ignore the trailing partial line
		if (s.aiBusy && !src.endsWith('\n')) src = src.slice(0, src.lastIndexOf('\n') + 1)
		const parsed = parseOctoPages(src)
		const pageNames = parsed.pages.map((p) => p.name)
		const groupsOf = (name: string) => parsed.pages.find((p) => p.name === name)?.ir.nodes.filter((n) => n.isContainer).map((n) => n.key) ?? null
		// the page (or focused group) may have been renamed or deleted
		const crumbs = pruneStack(s.crumbs, pageNames, groupsOf)
		const top = crumbs[crumbs.length - 1]
		const navPatch = crumbs.length !== s.crumbs.length ? { crumbs, page: top.page } : {}
		if (navPatch.crumbs) useStore.setState({ selection: null })
		const page = parsed.pages.find((p) => p.name === top.page) ?? parsed.pages[0]
		const pageErrors = page.diagnostics.some((d) => d.severity === 'error')
		useStore.setState({ ...navPatch, diagnostics: s.aiBusy ? [] : parsed.diagnostics, rootTitle: parsed.pages[0].ir.title, pageNames: sameList(pageNames, s.pageNames) ? s.pageNames : pageNames })
		const view = viewId()
		if (pageErrors && base && view === baseView) {
			useStore.setState({ layoutPending: false })
			return
		}
		const st = useStore.getState()
		let ir = page.ir
		if (top.focus) ir = focusGroup(ir, top.focus)
		ir = collapseGroups(ir, (st.collapsed[top.page] ?? []).filter((k) => k !== top.focus))
		const targets = drillTargets(ir, pageNames, top.page)
		for (const n of ir.nodes) if (n.ext?.ghost === 'true') delete targets[n.key]
		try {
			const layout = await layoutInWorker(ir)
			if (id !== run) return
			base = layout
			baseIR = ir
			baseView = view
			useStore.setState({ ir, pageIR: page.ir, drill: targets, layout: applyPins(ir, layout, currentPins()), layoutPending: false })
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
	schedule(0)
}

function sameList(a: string[], b: string[]) {
	return a.length === b.length && a.every((x, i) => x === b[i])
}
