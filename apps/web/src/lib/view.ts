import type { Point } from '@octo-draw/core'
import { pushHistory, snapshot, useStore, type HistoryMode } from '../store'
import { drillInto, focusInto, goTo, goUp, jumpTo, pagePins, withPagePins, type Crumb } from './pages'
import { addPage } from './drillCore'

/**
 * Store-level drill-down navigation: the current page, the breadcrumb path,
 * collapsed groups and the per-page view of pins.
 */

const get = useStore.getState
const set = useStore.setState

/** Animation hook installed by the canvas (camera zoom + fade); null → instant. */
type Navigator = (next: Crumb[], how: 'in' | 'out' | 'none', via?: string) => Promise<void>
let navigator: Navigator | null = null
export function setNavigator(fn: Navigator | null) {
	navigator = fn
}

/** Applies a crumb stack right away (the canvas navigator calls this mid-animation). */
export function applyCrumbs(next: Crumb[]) {
	const top = next[next.length - 1]
	set({ crumbs: next, page: top.page, selection: null })
}

async function navigate(next: Crumb[], how: 'in' | 'out' | 'none', via?: string) {
	const s = get()
	const prevTop = s.crumbs[s.crumbs.length - 1]
	const top = next[next.length - 1]
	if (next.length === s.crumbs.length && prevTop.page === top.page && prevTop.focus === top.focus) return
	if (navigator && how !== 'none') await navigator(next, how, via)
	else {
		applyCrumbs(next)
		requestViewFit()
	}
}

let fitAfterLayout = false
/** Fits the view once the next layout lands. */
export function requestViewFit() {
	fitAfterLayout = true
}
export function takeViewFit() {
	const v = fitAfterLayout
	fitAfterLayout = false
	return v
}

export function drillTo(page: string, via?: string) {
	void navigate(drillInto(get().crumbs, page, via), 'in', via)
}

export function focusOn(group: string) {
	void navigate(focusInto(get().crumbs, group), 'in', group)
}

export function goBack() {
	const s = get()
	if (s.crumbs.length <= 1) return false
	const via = s.crumbs[s.crumbs.length - 1].via
	void navigate(goUp(s.crumbs), 'out', via)
	return true
}

export function goToCrumb(index: number) {
	const s = get()
	if (index >= s.crumbs.length - 1) return
	const via = s.crumbs[index + 1]?.via
	void navigate(goTo(s.crumbs, index), 'out', via)
}

/** Page tab / editor caret / agent hook: switch pages without a drill animation. */
export function setPage(name: string, animate = false) {
	const s = get()
	if (!s.pageNames.includes(name)) return false
	const top = s.crumbs[s.crumbs.length - 1]
	if (top.page === name && !top.focus) return true
	void navigate(jumpTo(s.crumbs, name), animate ? 'in' : 'none')
	return true
}

/** Leaves focus mode and selects `key` (a ghost node was clicked). */
export function exitFocusTo(key: string) {
	const s = get()
	let i = s.crumbs.length - 1
	while (i > 0 && s.crumbs[i].focus) i--
	void navigate(goTo(s.crumbs, i), 'out', s.crumbs[i + 1]?.via).then(() => set({ selection: { kind: 'node', key } }))
}

export function toggleCollapsed(key: string) {
	const s = get()
	const cur = s.collapsed[s.page] ?? []
	const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]
	const collapsed = { ...s.collapsed }
	if (next.length) collapsed[s.page] = next
	else delete collapsed[s.page]
	set({ collapsed, selection: { kind: 'node', key } })
}

export function isCollapsed(key: string) {
	const s = get()
	return (s.collapsed[s.page] ?? []).includes(key)
}

export function newPage() {
	const s = get()
	let n = s.pageNames.length + 1
	let name = `Page ${n}`
	while (s.pageNames.some((p) => p.toLowerCase() === name.toLowerCase())) name = `Page ${++n}`
	pushHistory()
	set({ code: addPage(s.code, name, 'Start > Next\n') })
	// the pipeline learns the page name on the next parse; switch once it has
	const unsub = useStore.subscribe((st) => {
		if (!st.pageNames.includes(name)) return
		unsub()
		setPage(name)
	})
	setTimeout(unsub, 3000)
}

// ---------------------------------------------------------------------------
// pins, per page

/** The current page's pins, keyed by plain node key. */
export function currentPins(s = get()): Record<string, Point> {
	return pagePins(s.pins, s.page, s.pageNames)
}

/** Replaces the current page's pins. */
export function setCurrentPins(local: Record<string, Point>, mode: HistoryMode = 'push') {
	const s = get()
	if (mode === 'push') pushHistory()
	else if (mode !== 'none') pushHistory(snapshot(), mode.tag, mode.ms)
	set({ pins: withPagePins(s.pins, s.page, local, s.pageNames) })
}

/** Merges `patch` into the current page's pins (no history). */
export function mergeCurrentPins(patch: Record<string, Point>) {
	const s = get()
	setCurrentPins({ ...currentPins(s), ...patch }, 'none')
}
