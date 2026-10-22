import type { DiagramIR, DiagramLayout, Direction, IREdge, IRNode, LaidOutEdge, LaidOutNode, Point } from '../ir'
import { routeOrthogonal, polylineMidpoint } from './route'
import { GROUP_PADDING } from './sizing'
import { clipToShapes } from './clip'
import { routeErdEdge } from './erdRoute'

/** Parent/children relations of an IR, guarded against dangling parents and cycles. */
export interface Hierarchy {
	byKey: Map<string, IRNode>
	parentOf: Map<string, string>
	childrenOf: Map<string, string[]>
	isContainer: (key: string) => boolean
	ancestors: (key: string) => string[]
	depth: (key: string) => number
	/** true when one endpoint contains the other */
	nested: (a: string, b: string) => boolean
}

export function buildHierarchy(ir: DiagramIR): Hierarchy {
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const parentOf = new Map<string, string>()
	for (const n of ir.nodes) {
		if (!n.parent || !byKey.has(n.parent) || n.parent === n.key) continue
		let p: string | undefined = n.parent
		let cyclic = false
		const seen = new Set([n.key])
		while (p) {
			if (seen.has(p)) {
				cyclic = true
				break
			}
			seen.add(p)
			p = byKey.get(p)?.parent
		}
		if (!cyclic) parentOf.set(n.key, n.parent)
	}
	const childrenOf = new Map<string, string[]>()
	for (const [child, parent] of parentOf) {
		const list = childrenOf.get(parent) ?? []
		list.push(child)
		childrenOf.set(parent, list)
	}
	const ancestors = (key: string): string[] => {
		const out: string[] = []
		let p = parentOf.get(key)
		while (p) {
			out.push(p)
			p = parentOf.get(p)
		}
		return out
	}
	return {
		byKey,
		parentOf,
		childrenOf,
		isContainer: (key) => !!byKey.get(key)?.isContainer || childrenOf.has(key),
		ancestors,
		depth: (key) => ancestors(key).length,
		nested: (a, b) => ancestors(a).includes(b) || ancestors(b).includes(a),
	}
}

export function routeEdge(
	e: IREdge,
	nodes: Record<string, LaidOutNode>,
	h: Hierarchy,
	direction: Direction,
): LaidOutEdge | null {
	const a = nodes[e.from]
	const b = nodes[e.to]
	if (!a || !b) return null
	let points: Point[]
	if (h.nested(e.from, e.to)) {
		// container ↔ own descendant: short vertical stub from the inner box into the title band
		const inner = h.ancestors(e.to).includes(e.from) ? b : a
		const outer = inner === a ? b : a
		const x = inner.x + inner.w / 2
		const p1 = { x, y: inner.y }
		const p2 = { x, y: outer.y + GROUP_PADDING.top - 10 }
		points = inner === a ? [p1, p2] : [p2, p1]
	} else {
		points = routeOrthogonal(a, b, direction)
		points = clipToShapes(points, a, b, h.byKey.get(e.from)?.shape, h.byKey.get(e.to)?.shape)
	}
	return { key: e.key, points, labelAt: e.label ? polylineMidpoint(points) : undefined }
}

/**
 * Moves pinned nodes (top-left) onto an existing layout. Pure and cheap, so
 * the canvas can call it on every pointer move while dragging. Unchanged node
 * and edge objects keep their identity.
 */
export function applyPins(ir: DiagramIR, layout: DiagramLayout, pinned: Record<string, Point>): DiagramLayout {
	// sequence columns are positioned by time order, not draggable
	if (layout.sequence) return layout
	const h = buildHierarchy(ir)
	const direction = ir.direction ?? 'down'
	const nodes: Record<string, LaidOutNode> = { ...layout.nodes }
	const dirty = new Set<string>()
	const touch = (key: string) => {
		if (!dirty.has(key)) {
			nodes[key] = { ...nodes[key] }
			dirty.add(key)
		}
		return nodes[key]
	}
	const moveSubtree = (key: string, dx: number, dy: number) => {
		if (!nodes[key]) return
		const n = touch(key)
		n.x += dx
		n.y += dy
		for (const c of h.childrenOf.get(key) ?? []) moveSubtree(c, dx, dy)
	}
	// outermost first so a pinned child inside a pinned container wins
	const keys = Object.keys(pinned)
		.filter((k) => nodes[k])
		.sort((a, b) => h.depth(a) - h.depth(b))
	for (const key of keys) {
		const n = nodes[key]
		const p = pinned[key]
		const dx = p.x - n.x
		const dy = p.y - n.y
		if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) moveSubtree(key, dx, dy)
	}
	if (!dirty.size) return layout

	// refit every ancestor of a moved node, deepest first
	const refit = new Set<string>()
	for (const k of dirty) for (const a of h.ancestors(k)) refit.add(a)
	for (const key of [...refit].sort((a, b) => h.depth(b) - h.depth(a))) {
		const kids = (h.childrenOf.get(key) ?? []).map((c) => nodes[c]).filter(Boolean)
		if (!nodes[key] || !kids.length) continue
		const minX = Math.min(...kids.map((c) => c.x)) - GROUP_PADDING.left
		const minY = Math.min(...kids.map((c) => c.y)) - GROUP_PADDING.top
		const maxX = Math.max(...kids.map((c) => c.x + c.w)) + GROUP_PADDING.right
		const maxY = Math.max(...kids.map((c) => c.y + c.h)) + GROUP_PADDING.bottom
		const n = touch(key)
		const w = Math.max(maxX - minX, 160)
		n.x = minX - (w - (maxX - minX)) / 2
		n.y = minY
		n.w = w
		n.h = maxY - minY
	}

	const edges: Record<string, LaidOutEdge> = { ...layout.edges }
	for (const e of ir.edges) {
		if (!edges[e.key]) continue
		if (dirty.has(e.from) || dirty.has(e.to)) {
			const r = ir.kind === 'erd' ? routeErdEdge(e, nodes) : routeEdge(e, nodes, h, direction)
			if (r) edges[e.key] = r
		}
	}
	return { nodes, edges, bounds: computeBounds(nodes, edges) }
}

export function computeBounds(nodes: Record<string, LaidOutNode>, edges: Record<string, LaidOutEdge>) {
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (const n of Object.values(nodes)) {
		minX = Math.min(minX, n.x)
		minY = Math.min(minY, n.y)
		maxX = Math.max(maxX, n.x + n.w)
		maxY = Math.max(maxY, n.y + n.h)
	}
	for (const e of Object.values(edges)) {
		for (const p of e.points) {
			minX = Math.min(minX, p.x)
			minY = Math.min(minY, p.y)
			maxX = Math.max(maxX, p.x)
			maxY = Math.max(maxY, p.y)
		}
	}
	if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 }
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

