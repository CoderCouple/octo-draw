import type { DiagramLayout, Point } from '@octo-draw/core'
import { pushHistory, selectedKeys, setCode, showToast, undo, useStore } from '../store'
import { addChild, addSibling, groupNodes, moveIntoGroup, renameKey, ungroup, uniqueKey } from './nesting'
import { addSubDiagram, deletePage, renamePage } from './pageEdits'
import { applyActions, parsePage, renameNodeLabel } from './drillCore'
import { currentPins, drillTo, requestMorph, setPage, toggleCollapsed } from './view'
import { relayoutNow } from './pipeline'
import { withPagePins } from './pages'

/**
 * Canvas-first nesting: Tab adds a child (a leaf becomes a container), Enter
 * after naming adds a sibling, Shift+Tab selects the parent, Cmd+G groups,
 * drag re-parents, the Component tool draws nodes into containers. Every
 * structural edit is a code edit (one undo step) on the current page.
 */

export const PLACEHOLDER = 'New component'

const get = useStore.getState
const set = useStore.setState

/** Set after a label commit in the Tab / Enter flow: the next Enter adds a sibling. */
let composing: string | null = null
export const composingKey = () => composing
export function stopComposing() {
	composing = null
}

const isGhost = (key: string) => key.startsWith('ghost:')
const focusKey = () => get().crumbs[get().crumbs.length - 1].focus

/** The node's real parent on the page (the focused view re-parents to the top). */
export function realParent(key: string): string | null {
	return get().pageIR?.nodes.find((n) => n.key === key)?.parent ?? null
}

function applyStructural(code: string, patch: Partial<ReturnType<typeof get>> = {}, history = true) {
	const s = get()
	if (code === s.code) return false
	if (history) pushHistory()
	set({ code, ...patch })
	requestMorph()
	relayoutNow()
	return true
}

/** Opens the label editor on `key` once it is laid out; `placeholder` renames the key on commit. */
function editSoon(key: string, placeholder: boolean) {
	set({ selection: { kind: 'node', key }, editRequest: { key, page: get().page, placeholder } })
}

/** Tab: a new child inside `key` (a leaf turns into a container, props kept). */
export function addChildTo(key: string) {
	const s = get()
	if (isGhost(key)) return
	composing = null
	// a collapsed group opens first so the new child is visible
	if (s.ir?.nodes.find((n) => n.key === key)?.ext?.collapsed !== undefined) toggleCollapsed(key)
	const name = uniqueKey(s.code, PLACEHOLDER, s.page)
	const code = addChild(s.code, key, name, s.page)
	const wasLeaf = !s.pageIR?.nodes.find((n) => n.key === key)?.isContainer
	const pins = currentPins(s)
	const patch: Record<string, unknown> = {}
	if (wasLeaf && pins[key]) {
		// a pinned leaf becoming a container: let the layout size it around its children
		delete pins[key]
		patch.pins = withPagePins(s.pins, s.page, pins, s.pageNames)
	}
	if (applyStructural(code, patch)) editSoon(name, true)
}

/** Enter (after naming) / side "+": a sibling next to `key` in the same container. */
export function addSiblingOf(key: string) {
	const s = get()
	if (isGhost(key)) return
	composing = null
	const name = uniqueKey(s.code, PLACEHOLDER, s.page)
	const parent = realParent(key)
	// inside a focused view, a top-level node's sibling stays in the focused group
	const code = parent === null && focusKey() ? addChild(s.code, focusKey()!, name, s.page) : addSibling(s.code, key, name, s.page)
	if (applyStructural(code)) editSoon(name, true)
}

/** Shift+Tab: select the parent container (stays inside a focused view). */
export function selectParentOf(key: string) {
	composing = null
	const parent = realParent(key)
	if (!parent || !get().layout?.nodes[parent]) return false
	set({ selection: { kind: 'node', key: parent } })
	return true
}

/**
 * Commits a label typed in the editor. A placeholder key (`New component 3`)
 * is renamed to the typed name when that key is free; otherwise the label
 * changes. Placeholder commits join the "add" undo step.
 */
export function commitLabel(key: string, value: string | null, placeholder: boolean): string {
	const s = get()
	const text = value?.replace(/\s+/g, ' ').trim() ?? ''
	if (placeholder) composing = key
	if (value === null || !text) return key
	const node = s.ir?.nodes.find((n) => n.key === key)
	if (!placeholder) {
		if (text !== (node?.label ?? key)) setCode(renameNodeLabel(s.code, key, text, s.page))
		return key
	}
	let code = renameKey(s.code, key, text, s.page)
	let next = text
	if (code === s.code) {
		code = renameNodeLabel(s.code, key, text, s.page)
		next = key
	}
	if (code !== s.code) {
		// a renamed key keeps its pin (a component drawn at a spot stays there)
		const pins = currentPins(s)
		const patch: Record<string, unknown> = {}
		if (next !== key && pins[key]) {
			pins[next] = pins[key]
			delete pins[key]
			patch.pins = withPagePins(s.pins, s.page, pins, s.pageNames)
		}
		set({ code, ...patch })
		relayoutNow()
	}
	composing = next
	set({ selection: { kind: 'node', key: next } })
	return next
}

/** Cmd+G: wraps the selected nodes in a new group (nested in their common container). */
export function groupSelection() {
	const s = get()
	const keys = selectedKeys(s.selection).filter((k) => !isGhost(k))
	if (!keys.length) return false
	const name = uniqueKey(s.code, 'Group', s.page)
	const code = groupNodes(s.code, keys, name, s.page)
	if (!applyStructural(code)) {
		showToast("Couldn't group the selection")
		return false
	}
	editSoon(name, true)
	return true
}

/** Shift+Cmd+G: removes the selected group, keeping its contents. */
export function ungroupSelection() {
	const s = get()
	const key = s.selection?.kind === 'node' ? s.selection.key : null
	if (!key || !s.pageIR?.nodes.find((n) => n.key === key)?.isContainer) return false
	const children = s.pageIR.nodes.filter((n) => n.parent === key).map((n) => n.key)
	const ok = applyStructural(ungroup(s.code, key, s.page), { selection: children.length ? { kind: 'multi', ids: [], keys: children } : null })
	if (!ok) showToast("Couldn't ungroup")
	return ok
}

/** The deepest container in the layout whose box contains `p` (skipping `exclude` and anything inside it). */
export function containerAt(layout: DiagramLayout, p: Point, exclude: string[] = []): string | null {
	const s = get()
	const parents = new Map((s.ir?.nodes ?? []).map((n) => [n.key, n.parent]))
	const inside = (k: string, anc: string) => {
		for (let a: string | undefined = k, i = 0; a !== undefined && i < 64; a = parents.get(a), i++) if (a === anc) return true
		return false
	}
	let best: { key: string; depth: number; area: number } | null = null
	for (const n of Object.values(layout.nodes)) {
		if (!n.isContainer || exclude.some((e) => inside(n.key, e))) continue
		if (p.x < n.x || p.y < n.y || p.x > n.x + n.w || p.y > n.y + n.h) continue
		const area = n.w * n.h
		if (!best || n.depth > best.depth || (n.depth === best.depth && area < best.area)) best = { key: n.key, depth: n.depth, area }
	}
	return best?.key ?? null
}

/**
 * Drag end: nodes whose center left their container move out; nodes dropped
 * into a container move in. Joins the drag's undo step. Returns true if the
 * code changed.
 */
export function reparentAfterDrag(keys: string[], layout: DiagramLayout): boolean {
	const s = get()
	if (s.ir?.kind !== 'flowchart') return false
	const focus = focusKey()
	const moving = keys.filter((k) => !isGhost(k) && s.ir?.nodes.find((n) => n.key === k)?.ext?.collapsed === undefined)
	const parents = new Map((s.pageIR?.nodes ?? []).map((n) => [n.key, n.parent]))
	const top = moving.filter((k) => {
		for (let a = parents.get(k), i = 0; a !== undefined && i < 64; a = parents.get(a), i++) if (moving.includes(a)) return false
		return true
	})
	let code = s.code
	const pins = currentPins(s)
	let pinsChanged = false
	for (const k of top) {
		const box = layout.nodes[k]
		if (!box) continue
		const target = containerAt(layout, { x: box.x + box.w / 2, y: box.y + box.h / 2 }, [k]) ?? focus ?? null
		if (target === (parents.get(k) ?? null)) continue
		const next = moveIntoGroup(code, k, target, s.page)
		if (next === code) continue
		code = next
		// inside a container the layout places it; at the top it stays where it was dropped
		if (target !== null && pins[k]) {
			delete pins[k]
			pinsChanged = true
		}
	}
	if (code === s.code) return false
	set({ code, ...(pinsChanged ? { pins: withPagePins(s.pins, s.page, pins, s.pageNames) } : {}) })
	requestMorph()
	relayoutNow()
	return true
}

/**
 * Component tool: a box drawn around existing nodes groups them; otherwise a
 * new node goes into the deepest container under the drag start (or the top
 * level, pinned where it was drawn).
 */
export function drawComponent(box: { x: number; y: number; w: number; h: number }, start: Point) {
	const s = get()
	const layout = s.layout
	if (!layout || (s.ir && s.ir.kind !== 'flowchart')) {
		showToast('Components can be drawn on flowchart / architecture pages')
		return
	}
	const enclosed = Object.values(layout.nodes).filter((n) => !isGhost(n.key) && n.x >= box.x && n.y >= box.y && n.x + n.w <= box.x + box.w && n.y + n.h <= box.y + box.h)
	if (box.w > 24 && box.h > 24 && enclosed.length) {
		set({ selection: { kind: 'multi', ids: [], keys: enclosed.map((n) => n.key) } })
		groupSelection()
		return
	}
	const name = uniqueKey(s.code, PLACEHOLDER, s.page)
	const container = containerAt(layout, start) ?? focusKey() ?? null
	let code: string
	if (container) code = addChild(s.code, container, name, s.page)
	else {
		const r = applyActions(s.code, [{ type: 'addNode', key: name }], { page: s.page })
		code = r.code
	}
	const patch: Record<string, unknown> = {}
	if (!container) {
		const pins = { ...currentPins(s), [name]: { x: Math.round(box.x), y: Math.round(box.y) } }
		patch.pins = withPagePins(s.pins, s.page, pins, s.pageNames)
	}
	if (applyStructural(code, patch)) {
		set({ tool: 'select' })
		editSoon(name, true)
	}
}

/** "Add sub-diagram": an empty linked page `<page> / <label>`, then drill in. "Open" when it exists. */
export function addSubDiagramFor(key: string) {
	const s = get()
	if (isGhost(key)) return
	if (s.drill[key]) return drillTo(s.drill[key], key)
	const node = s.pageIR?.nodes.find((n) => n.key === key) ?? s.ir?.nodes.find((n) => n.key === key)
	const r = addSubDiagram(s.code, s.page, key, node?.label ?? key)
	if (r.code === s.code) return
	pushHistory()
	set({ code: r.code })
	relayoutNow()
	afterPage(r.page, () => drillTo(r.page, key))
}

/** Runs `fn` once the pipeline knows page `name` (it learns it on the next parse). */
export function afterPage(name: string, fn: () => void) {
	if (get().pageNames.includes(name) && !get().layoutPending) {
		fn()
		return
	}
	const unsub = useStore.subscribe((st) => {
		if (!st.pageNames.includes(name) || st.layoutPending) return
		unsub()
		clearTimeout(t)
		fn()
	})
	const t = setTimeout(unsub, 4000)
}

/** Outline "+ child page": linked from `viaKey` on `parent`, or from a new node there. */
export function addChildPage(parent: string, viaKey: string | null) {
	const s = get()
	let code = s.code
	let key = viaKey
	if (key === null) {
		key = uniqueKey(code, 'New page', parent)
		const r = applyActions(code, [{ type: 'addNode', key }], { page: parent })
		if (r.errors.length) return showToast(`Couldn't add a node: ${r.errors[0].message}`)
		code = r.code
	}
	const label = parsedLabel(code, parent, key)
	const r = addSubDiagram(code, parent, key, label)
	if (r.code === s.code) return
	pushHistory()
	set({ code: r.code })
	relayoutNow()
	afterPage(r.page, () => setPage(r.page, true))
}

function parsedLabel(code: string, page: string, key: string) {
	return parsePage(code, page)?.ir.nodes.find((n) => n.key === key)?.label ?? key
}

export function renamePageTo(from: string, to: string) {
	const s = get()
	const code = renamePage(s.code, from, to)
	if (code === s.code) {
		if (to.trim() && to !== from) showToast(`Can't rename to "${to}": that page name is taken`)
		return false
	}
	setCode(code)
	return true
}

export function deletePageNamed(name: string) {
	const s = get()
	const code = deletePage(s.code, name)
	if (code === s.code) return
	setCode(code)
	showToast(`Deleted page "${name}"`, [{ label: 'Undo', run: undo }])
}
