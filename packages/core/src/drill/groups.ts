/**
 * View transforms on a page's IR: collapse groups into leaf nodes, or focus
 * one group (its contents plus ghost nodes for whatever it connects to).
 * Both return fresh IR that `layoutDiagram` accepts and never mutate input.
 */

import type { DiagramIR, IREdge, IRNode } from '../ir'

export const GHOST_PREFIX = 'ghost:'

function cloneNode(n: IRNode): IRNode {
	const c: IRNode = { ...n }
	if (n.style) c.style = { ...n.style }
	if (n.geometry) c.geometry = { ...n.geometry }
	if (n.span) c.span = { ...n.span }
	if (n.ext) c.ext = { ...n.ext }
	if (n.fields) c.fields = n.fields.map((f) => ({ ...f, ...(f.meta ? { meta: [...f.meta] } : {}) }))
	return c
}

function cloneEdge(e: IREdge): IREdge {
	const c: IREdge = { ...e, arrow: { ...e.arrow }, line: { ...e.line } }
	if (e.style) c.style = { ...e.style }
	if (e.span) c.span = { ...e.span }
	return c
}

function cloneIR(ir: DiagramIR, nodes: IRNode[], edges: IREdge[]): DiagramIR {
	const out: DiagramIR = { ...ir, style: { ...ir.style }, nodes, edges }
	if (ir.sequence) out.sequence = structuredClone(ir.sequence)
	if (ir.erd) out.erd = { ...ir.erd }
	return out
}

/** Parent links with dangling parents and cycles removed. */
export function parentMap(ir: DiagramIR): Map<string, string> {
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const out = new Map<string, string>()
	for (const n of ir.nodes) {
		if (!n.parent || n.parent === n.key || !byKey.has(n.parent)) continue
		const seen = new Set([n.key])
		let p: string | undefined = n.parent
		let cyclic = false
		while (p !== undefined) {
			if (seen.has(p)) {
				cyclic = true
				break
			}
			seen.add(p)
			p = byKey.get(p)?.parent
		}
		if (!cyclic) out.set(n.key, n.parent)
	}
	return out
}

function ancestorsOf(parents: Map<string, string>, key: string): string[] {
	const out: string[] = []
	let p = parents.get(key)
	while (p !== undefined) {
		out.push(p)
		p = parents.get(p)
	}
	return out
}

function descendantCounts(parents: Map<string, string>): Map<string, number> {
	const counts = new Map<string, number>()
	for (const key of parents.keys()) for (const a of ancestorsOf(parents, key)) counts.set(a, (counts.get(a) ?? 0) + 1)
	return counts
}

/**
 * Rewire edges through `map` (endpoint → visible endpoint, undefined = drop).
 * Self-loops created by rewiring are dropped; when a (from, to) pair holds a
 * rewired edge, all its edges merge into one (label kept when there is at most
 * one distinct label, otherwise `"<n> links"`).
 */
function rewire(edges: IREdge[], map: (key: string) => string | undefined): IREdge[] {
	const groups = new Map<string, { edges: IREdge[]; rewired: boolean; from: string; to: string }>()
	const order: string[] = []
	for (const e of edges) {
		const from = map(e.from)
		const to = map(e.to)
		if (from === undefined || to === undefined) continue
		const rewired = from !== e.from || to !== e.to
		if (rewired && from === to) continue
		const id = JSON.stringify([from, to])
		let g = groups.get(id)
		if (!g) {
			g = { edges: [], rewired: false, from, to }
			groups.set(id, g)
			order.push(id)
		}
		g.edges.push(e)
		g.rewired ||= rewired
	}
	const out: IREdge[] = []
	for (const id of order) {
		const g = groups.get(id)!
		if (!g.rewired) {
			out.push(...g.edges.map(cloneEdge))
			continue
		}
		const first = g.edges[0]
		const e = cloneEdge(first)
		if (e.from !== g.from) delete e.fromField
		if (e.to !== g.to) delete e.toField
		e.from = g.from
		e.to = g.to
		if (g.edges.length > 1) {
			const labels = new Set(g.edges.map((x) => x.label).filter((l): l is string => l !== undefined && l !== ''))
			if (labels.size > 1) e.label = `${g.edges.length} links`
			else if (labels.size === 1) e.label = [...labels][0]
			else delete e.label
			if (g.edges.some((x) => x.from !== first.from || x.to !== first.to)) {
				delete e.fromField
				delete e.toField
			}
		}
		out.push(e)
	}
	return out
}

/**
 * Collapses containers into leaf nodes (`isContainer: false`,
 * `ext.collapsed = '<descendant count>'`, `ext.children = '<direct children count>'`,
 * both counted on the input IR). Their descendants disappear and
 * edges are rewired to the nearest visible ancestor.
 */
export function collapseGroups(ir: DiagramIR, collapsed: Iterable<string>): DiagramIR {
	const want = new Set(collapsed)
	const parents = parentMap(ir)
	const counts = descendantCounts(parents)
	const direct = new Map<string, number>()
	for (const p of parents.values()) direct.set(p, (direct.get(p) ?? 0) + 1)
	const isGroup = (key: string) => counts.has(key) || ir.nodes.some((n) => n.key === key && n.isContainer)
	const keys = new Set([...want].filter(isGroup))
	if (keys.size === 0) return cloneIR(ir, ir.nodes.map(cloneNode), ir.edges.map(cloneEdge))
	/** Visible stand-in: the outermost collapsed strict ancestor, else the node itself. */
	const rep = (key: string): string => {
		let out = key
		for (const a of ancestorsOf(parents, key)) if (keys.has(a)) out = a
		return out
	}
	const nodes: IRNode[] = []
	for (const n of ir.nodes) {
		if (rep(n.key) !== n.key) continue
		const c = cloneNode(n)
		if (keys.has(n.key)) {
			c.isContainer = false
			c.ext = { ...c.ext, collapsed: String(counts.get(n.key) ?? 0), children: String(direct.get(n.key) ?? 0) }
		}
		nodes.push(c)
	}
	return cloneIR(ir, nodes, rewire(ir.edges, rep))
}

/**
 * Only `groupKey`'s descendants, re-parented to the top level. Each edge that
 * crosses the group boundary is attached to a ghost node (`ghost:<key>`,
 * `ext.ghost = 'true'`, `ext.ghostOf = '<key>'`) for the outside endpoint's
 * outermost ancestor that does not itself contain the group (or the endpoint
 * itself when it encloses the group). Edges touching the group itself, or with
 * both ends outside, are dropped. An unknown key returns a copy of `ir`.
 */
export function focusGroup(ir: DiagramIR, groupKey: string): DiagramIR {
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	if (!byKey.has(groupKey)) return cloneIR(ir, ir.nodes.map(cloneNode), ir.edges.map(cloneEdge))
	const parents = parentMap(ir)
	const inside = new Set<string>()
	for (const n of ir.nodes) if (ancestorsOf(parents, n.key).includes(groupKey)) inside.add(n.key)
	const enclosing = new Set(ancestorsOf(parents, groupKey))
	const nodes: IRNode[] = []
	for (const n of ir.nodes) {
		if (!inside.has(n.key)) continue
		const c = cloneNode(n)
		if (c.parent === groupKey || !parents.has(n.key)) delete c.parent
		nodes.push(c)
	}
	const taken = new Set(nodes.map((n) => n.key))
	const ghosts = new Map<string, string>()
	const ghostFor = (key: string): string => {
		let target = key
		if (!enclosing.has(key)) for (const a of ancestorsOf(parents, key)) if (!enclosing.has(a)) target = a
		let gk = ghosts.get(target)
		if (gk !== undefined) return gk
		gk = GHOST_PREFIX + target
		while (taken.has(gk)) gk = GHOST_PREFIX + gk
		taken.add(gk)
		ghosts.set(target, gk)
		const src = byKey.get(target)
		const g: IRNode = { key: gk, label: src?.label ?? target, ext: { ghost: 'true', ghostOf: target } }
		if (src?.shape) g.shape = src.shape
		if (src?.icon) g.icon = src.icon
		if (src?.style) g.style = { ...src.style }
		nodes.push(g)
		return gk
	}
	const edges = rewire(
		ir.edges.filter((e) => {
			if (e.from === groupKey || e.to === groupKey) return false
			return inside.has(e.from) || inside.has(e.to)
		}),
		(key) => (inside.has(key) ? key : ghostFor(key)),
	)
	return cloneIR(ir, nodes, edges)
}
