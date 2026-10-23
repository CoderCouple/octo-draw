import type { DiagramIR, Point } from '@octo-draw/core'
import { pushHistory, snapshot, useStore, type HistoryMode } from '../store'
import { drillInto, focusInto, goTo, goUp, jumpToPath, pagePins, sameCrumb, withPagePins, type Crumb } from './pages'
import { addPage } from './drillCore'
import { collapseToDepth, pagePath, type PageTreeNode } from './coreV2'

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
	const trail = get().trail
	// remember the deeper path we came up from, so Cmd+] can go back down it
	const onTrail = trail.length >= next.length && next.every((c, i) => sameCrumb(c, trail[i]))
	set({ crumbs: next, page: top.page, selection: null, trail: onTrail ? trail : next })
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

/**
 * Outline / editor caret / agent hook: opens a page directly. The breadcrumb
 * trail is rebuilt from the page tree (`pagePath`) unless the page is already
 * on the current path.
 */
export function setPage(name: string, animate = false) {
	const s = get()
	if (!s.pageNames.includes(name)) return false
	const top = s.crumbs[s.crumbs.length - 1]
	if (top.page === name && !top.focus) return true
	void navigate(jumpToPath(s.crumbs, name, pagePath(s.code, name)), animate ? 'in' : 'none')
	return true
}

/** Cmd+]: one level back down the path we last came up from. */
export function goDeeper() {
	const s = get()
	if (s.trail.length <= s.crumbs.length) return false
	const next = s.trail.slice(0, s.crumbs.length + 1)
	void navigate(next, 'in', next[next.length - 1].via)
	return true
}

function findInTree(tree: PageTreeNode[], name: string): { node: PageTreeNode; parent: PageTreeNode | null } | null {
	const walk = (n: PageTreeNode, parent: PageTreeNode | null): { node: PageTreeNode; parent: PageTreeNode | null } | null => {
		if (n.name === name && (parent !== null || n === tree[0])) return { node: n, parent }
		for (const c of n.children) {
			const hit = walk(c, n)
			if (hit) return hit
		}
		return null
	}
	for (const t of tree) {
		const hit = walk(t, null)
		if (hit) return hit
	}
	return null
}

/** Page Up / Page Down: the previous / next sibling page in the page tree. */
export function siblingPage(dir: -1 | 1) {
	const s = get()
	const hit = findInTree(s.tree, s.page)
	if (!hit?.parent) return false
	const sibs = hit.parent.children.filter((c) => s.pageNames.includes(c.name))
	const i = sibs.findIndex((c) => c.name === s.page)
	const next = sibs[i + dir]
	if (!next) return false
	return setPage(next.name, true)
}

/** Child pages of `name` in the page tree (outline counts, sub-diagram menus). */
export function childPages(name: string): string[] {
	const s = get()
	return findInTree(s.tree, name)?.node.children.map((c) => c.name) ?? []
}

/** Deepest container level in a view (top-level containers are level 1); 0 without groups. */
export function maxGroupDepth(ir: DiagramIR | null): number {
	if (!ir) return 0
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	let max = 0
	for (const n of ir.nodes) {
		if (!n.isContainer) continue
		let level = 1
		const seen = new Set([n.key])
		for (let p = n.parent; p !== undefined && byKey.has(p) && !seen.has(p); p = byKey.get(p)!.parent) {
			seen.add(p)
			level++
		}
		max = Math.max(max, level)
	}
	return max
}

/**
 * Levels control: `levels` visible hierarchy levels (1 = top-level items only,
 * every group collapsed), null = everything open. Inside a focused view only
 * the focused subtree changes.
 */
export function setLevels(levels: number | null) {
	const s = get()
	const view = s.focusIR
	if (!view) return
	const inView = new Set(view.nodes.map((n) => n.key))
	const keep = (s.collapsed[s.page] ?? []).filter((k) => !inView.has(k))
	const next = levels === null ? keep : [...keep, ...collapseToDepth(view, levels)]
	const collapsed = { ...s.collapsed }
	if (next.length) collapsed[s.page] = next
	else delete collapsed[s.page]
	set({ collapsed })
}

/** Which Levels button matches the current collapse state (null = All, undefined = custom). */
export function currentLevels(s = get()): number | null | undefined {
	const view = s.focusIR
	if (!view) return null
	const inView = new Set(view.nodes.filter((n) => n.isContainer).map((n) => n.key))
	const here = new Set((s.collapsed[s.page] ?? []).filter((k) => inView.has(k) && k !== s.crumbs[s.crumbs.length - 1].focus))
	if (!here.size) return null
	const max = maxGroupDepth(view)
	for (let n = 1; n <= max; n++) {
		const keys = collapseToDepth(view, n)
		if (keys.length === here.size && keys.every((k) => here.has(k))) return n
	}
	return undefined
}

let morphNext = false
/** The next layout animates (nodes glide) instead of jumping. */
export function requestMorph() {
	morphNext = true
}
export function takeMorph() {
	const v = morphNext
	morphNext = false
	return v
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
