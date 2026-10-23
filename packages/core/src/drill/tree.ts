/**
 * Recursive drill-down helpers: the page tree (pages stay a flat list in the
 * code; the tree comes from `drill:` links), breadcrumb paths, and group
 * depth control for one page.
 */

import type { DiagramIR } from '../ir'
import { parentMap } from './groups'
import { analyzePage, drillTargets, findPage, ROOT_PAGE, splitPages, type OctoPage } from './pages'

export interface PageTreeNode {
	/** Page name (`''` = root). The synthetic orphan entry is named `Unlinked` and has `unlinked: true`. */
	name: string
	/** Node key on the parent page that drills into this page. */
	via?: string
	children: PageTreeNode[]
	/** 0 for the root (and the synthetic Unlinked entry). */
	depth: number
	/** A link back to an ancestor: a leaf that is not expanded again. */
	cycle?: true
	/** The synthetic entry holding pages nothing drills into. */
	unlinked?: true
}

export interface PagePathEntry {
	page: string
	/** Node key on the previous page that drills into `page` (absent for the first entry). */
	via?: string
}

/**
 * The page tree: root first, then (only when there are orphan pages) a
 * synthetic `{ name: 'Unlinked', unlinked: true }` entry. BFS from the root:
 * a page linked from several parents appears under the first one; a link to an
 * ancestor becomes a leaf with `cycle: true`; duplicate page names: first wins.
 */
export function pageTree(src: string): PageTreeNode[] {
	const all = splitPages(src)
	const names = all.map((p) => p.name)
	const pages: OctoPage[] = []
	const seen = new Set<string>()
	for (const p of all) {
		const k = p.name.toLowerCase()
		if (p !== all[0] && (p.name === ROOT_PAGE || seen.has(k))) continue
		seen.add(k)
		pages.push(p)
	}
	const targetCache = new Map<string, [string, string][]>()
	const targets = (page: OctoPage): [string, string][] => {
		let t = targetCache.get(page.name)
		if (!t) {
			const ir = analyzePage(src, page).result.ir
			const map = drillTargets(ir, names, page.name === ROOT_PAGE ? undefined : page.name)
			t = ir.nodes.filter((n) => map[n.key] !== undefined).map((n) => [n.key, map[n.key]] as [string, string])
			targetCache.set(page.name, t)
		}
		return t
	}
	const byLower = new Map(pages.map((p) => [p.name.toLowerCase(), p]))
	const placed = new Set<string>()

	const grow = (top: PageTreeNode, topAncestors: string[]) => {
		const queue: { node: PageTreeNode; path: string[] }[] = [{ node: top, path: [...topAncestors, top.name.toLowerCase()] }]
		while (queue.length) {
			const { node, path } = queue.shift()!
			const page = byLower.get(node.name.toLowerCase()) ?? (node.name === ROOT_PAGE ? pages[0] : undefined)
			if (!page) continue
			const cycles = new Set<string>()
			for (const [key, target] of targets(page)) {
				const lower = target.toLowerCase()
				const canonical = byLower.get(lower)?.name ?? target
				if (path.includes(lower)) {
					if (cycles.has(lower)) continue
					cycles.add(lower)
					node.children.push({ name: canonical, via: key, children: [], depth: node.depth + 1, cycle: true })
					continue
				}
				if (placed.has(lower)) continue
				placed.add(lower)
				const child: PageTreeNode = { name: canonical, via: key, children: [], depth: node.depth + 1 }
				node.children.push(child)
				queue.push({ node: child, path: [...path, lower] })
			}
		}
	}

	const root: PageTreeNode = { name: ROOT_PAGE, children: [], depth: 0 }
	placed.add(ROOT_PAGE)
	grow(root, [])
	const out = [root]
	const unlinked: PageTreeNode = { name: 'Unlinked', unlinked: true, children: [], depth: 0 }
	for (const p of pages) {
		const lower = p.name.toLowerCase()
		if (placed.has(lower)) continue
		placed.add(lower)
		const top: PageTreeNode = { name: p.name, children: [], depth: 1 }
		unlinked.children.push(top)
		grow(top, [])
	}
	if (unlinked.children.length) out.push(unlinked)
	return out
}

/**
 * Breadcrumb path from the root (inclusive) to `name` (inclusive), with the
 * node key used at each step. Orphan pages: root, then the chain from the
 * orphan's top page. Unknown page: `[]`.
 */
export function pagePath(src: string, name: string): PagePathEntry[] {
	if (name === ROOT_PAGE) return [{ page: ROOT_PAGE }]
	const page = findPage(splitPages(src), name)
	if (!page) return []
	const want = page.name
	const find = (n: PageTreeNode, trail: PagePathEntry[]): PagePathEntry[] | null => {
		if (n.cycle) return null
		const here = n.unlinked ? trail : [...trail, n.via !== undefined ? { page: n.name, via: n.via } : { page: n.name }]
		if (!n.unlinked && n.name === want) return here
		for (const c of n.children) {
			const hit = find(c, here)
			if (hit) return hit
		}
		return null
	}
	const [root, unlinked] = pageTree(src)
	return find(root, []) ?? (unlinked ? find(unlinked, [{ page: ROOT_PAGE }]) : null) ?? []
}

/**
 * Container keys to collapse so only `depth` levels of nesting show (top-level
 * nodes are level 1): every container at level >= depth, in node order.
 * `depth <= 0` acts like 1; a non-finite depth (All) returns `[]`.
 */
export function collapseToDepth(ir: DiagramIR, depth: number): string[] {
	if (!Number.isFinite(depth)) return []
	const d = Math.max(1, Math.floor(depth))
	const parents = parentMap(ir)
	const hasChildren = new Set(parents.values())
	const level = (key: string) => {
		let l = 1
		for (let p = parents.get(key); p !== undefined; p = parents.get(p)) l++
		return l
	}
	const out: string[] = []
	const seen = new Set<string>()
	for (const n of ir.nodes) {
		if (seen.has(n.key)) continue
		seen.add(n.key)
		if ((n.isContainer || hasChildren.has(n.key)) && level(n.key) >= d) out.push(n.key)
	}
	return out
}
