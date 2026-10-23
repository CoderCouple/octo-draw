import type { PageTreeNode } from './coreV2'

/**
 * Pure model of the page outline: the page tree flattened into visible rows
 * (indentation, open/closed branches, descendant counts, search filter).
 */

export interface OutlineRow {
	/** stable row id: the page name, or `\u0000<name>` for synthetic entries */
	id: string
	/** page name to open; null for synthetic entries ("Unlinked") */
	page: string | null
	label: string
	depth: number
	via?: string
	hasChildren: boolean
	open: boolean
	/** all pages below this one */
	count: number
	cycle?: boolean
	current: boolean
	/** [from, to) of the search match inside `label` */
	match?: [number, number]
}

export interface OutlineOptions {
	/** real page names; tree entries not in it are synthetic */
	pageNames: Iterable<string>
	/** the page shown on the canvas: highlighted, its ancestors open unless toggled closed */
	current: string
	/** branches the user toggled: id → open */
	toggled?: Record<string, boolean>
	/** branches shallower than this start open */
	openDepth?: number
	query?: string
	/** label for the root page */
	rootLabel?: string
}

/** `server modules / sync` under `server modules` reads as `sync`. */
export function shortPageLabel(name: string, parent: string | null | undefined): string {
	if (parent && name.length > parent.length + 3 && name.toLowerCase().startsWith(parent.toLowerCase() + ' / ')) return name.slice(parent.length + 3)
	return name
}

const countBelow = (n: PageTreeNode): number => n.children.reduce((a, c) => (c.cycle ? a : a + 1 + countBelow(c)), 0)

export function buildOutline(tree: PageTreeNode[], opts: OutlineOptions): OutlineRow[] {
	const real = new Set(opts.pageNames)
	const toggled = opts.toggled ?? {}
	const openDepth = opts.openDepth ?? 2
	const q = (opts.query ?? '').trim().toLowerCase()
	const counts = new Map<PageTreeNode, number>()
	const count = (n: PageTreeNode) => {
		let c = counts.get(n)
		if (c === undefined) counts.set(n, (c = countBelow(n)))
		return c
	}
	const isReal = (n: PageTreeNode) => !n.unlinked && real.has(n.name)
	// a cycle entry repeats an ancestor's name: give it its own row id
	const idOf = (n: PageTreeNode, parentId = '') => (n.cycle ? `\u0000cycle\u0000${parentId}\u0000${n.name}` : isReal(n) ? n.name : `\u0000${n.name}`)
	const labelOf = (n: PageTreeNode, parent: PageTreeNode | null) => (n.name === '' && isReal(n) ? opts.rootLabel || 'Root' : shortPageLabel(n.name, parent && isReal(parent) ? parent.name : null))

	// which entries lie on the way to the current page (forced open)
	const onPath = new Set<PageTreeNode>()
	const findPath = (n: PageTreeNode): boolean => {
		if (n.cycle) return false
		if (isReal(n) && n.name === opts.current) return true
		for (const c of n.children) if (findPath(c)) return onPath.add(n), true
		return false
	}
	for (const t of tree) findPath(t)

	// with a query: entries that match or have a matching descendant
	const keep = new Set<PageTreeNode>()
	const matches = (n: PageTreeNode, parent: PageTreeNode | null) => {
		const label = labelOf(n, parent).toLowerCase()
		return label.includes(q) || n.name.toLowerCase().includes(q)
	}
	const filter = (n: PageTreeNode, parent: PageTreeNode | null): boolean => {
		let hit = matches(n, parent)
		for (const c of n.children) if (filter(c, n)) hit = true
		if (hit) keep.add(n)
		return hit
	}
	if (q) for (const t of tree) filter(t, null)

	const rows: OutlineRow[] = []
	const visit = (n: PageTreeNode, parent: PageTreeNode | null, depth: number, parentId: string) => {
		if (q && !keep.has(n)) return
		const id = idOf(n, parentId)
		const label = labelOf(n, parent)
		const hasChildren = n.children.length > 0
		const open = hasChildren && (q ? true : (toggled[id] ?? (onPath.has(n) || depth < openDepth)))
		const row: OutlineRow = { id, page: isReal(n) ? n.name : null, label, depth, hasChildren, open, count: count(n), current: isReal(n) && !n.cycle && n.name === opts.current }
		if (n.via !== undefined) row.via = n.via
		if (n.cycle) row.cycle = true
		if (q) {
			const at = label.toLowerCase().indexOf(q)
			if (at >= 0) row.match = [at, at + q.length]
		}
		rows.push(row)
		if (open) for (const c of n.children) visit(c, n, depth + 1, id)
	}
	for (const t of tree) visit(t, null, 0, '')
	return rows
}

/** Row ids of the entries above `page` (the component re-opens them when the page changes). */
export function outlineAncestors(tree: PageTreeNode[], page: string, pageNames: Iterable<string>): string[] {
	const real = new Set(pageNames)
	const out: string[] = []
	const walk = (n: PageTreeNode): boolean => {
		if (n.cycle) return false
		if (!n.unlinked && real.has(n.name) && n.name === page) return true
		for (const c of n.children)
			if (walk(c)) {
				out.push(!n.unlinked && real.has(n.name) ? n.name : `\u0000${n.name}`)
				return true
			}
		return false
	}
	for (const t of tree) if (walk(t)) break
	return out.reverse()
}
