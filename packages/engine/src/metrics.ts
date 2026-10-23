import type { DiagramIR, DiagramLayout, LaidOutEdge, Point } from '@octo-draw/core'

/** Route quality numbers used to compare ELK routes with Eraser's corridor router. */
export interface RouteMetrics {
	edges: number
	bends: number
	/** Proper crossings between segments of different edges. */
	crossings: number
	length: number
	/** Times a polyline crosses a group border. */
	wallCrossings: number
	/** Wall crossings beyond the minimum the endpoints' nesting requires. */
	extraWallCrossings: number
	/** Segments passing through a node that is neither an endpoint nor a container. */
	nodeHits: number
	/** Non-orthogonal segments (diagonals). */
	diagonals: number
}

type Box = { x: number; y: number; w: number; h: number }
const EPS = 0.5

function segs(points: Point[]): [Point, Point][] {
	const out: [Point, Point][] = []
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]
		const b = points[i]
		if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) continue
		out.push([a, b])
	}
	return out
}

/** Bends = direction changes along the polyline (collinear points are not bends). */
export function bendCount(points: Point[]): number {
	const s = segs(points)
	let n = 0
	for (let i = 1; i < s.length; i++) {
		const [a, b] = s[i - 1]
		const [c, d] = s[i]
		const cross = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
		if (Math.abs(cross) > EPS) n++
	}
	return n
}

export function polylineLength(points: Point[]): number {
	let l = 0
	for (const [a, b] of segs(points)) l += Math.hypot(b.x - a.x, b.y - a.y)
	return l
}

function orient(a: Point, b: Point, c: Point) {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/** Strict interior crossing (shared endpoints and collinear overlaps don't count). */
function properCross(a: Point, b: Point, c: Point, d: Point) {
	const o1 = orient(a, b, c)
	const o2 = orient(a, b, d)
	const o3 = orient(c, d, a)
	const o4 = orient(c, d, b)
	return o1 * o2 < -EPS && o3 * o4 < -EPS
}

function insideStrict(p: Point, b: Box) {
	return p.x > b.x + EPS && p.x < b.x + b.w - EPS && p.y > b.y + EPS && p.y < b.y + b.h - EPS
}

/** Number of times segment ab crosses the border of b (0, 1 or 2 for a straight segment). */
function borderCrossings(a: Point, c: Point, b: Box): number {
	const ia = insideStrict(a, b)
	const ic = insideStrict(c, b)
	if (ia !== ic) return 1
	if (ia && ic) return 0
	return segmentHitsBox(a, c, b) ? 2 : 0
}

/** Does segment ac pass through the interior of b? */
function segmentHitsBox(a: Point, c: Point, b: Box): boolean {
	const minX = Math.min(a.x, c.x)
	const maxX = Math.max(a.x, c.x)
	const minY = Math.min(a.y, c.y)
	const maxY = Math.max(a.y, c.y)
	if (maxX <= b.x + EPS || minX >= b.x + b.w - EPS || maxY <= b.y + EPS || minY >= b.y + b.h - EPS) return false
	// axis-aligned segments: the bbox test is exact
	if (Math.abs(a.x - c.x) < EPS || Math.abs(a.y - c.y) < EPS) return true
	// diagonal: sample
	for (let t = 0.02; t < 1; t += 0.02) {
		if (insideStrict({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t }, b)) return true
	}
	return false
}

export function routeMetrics(ir: DiagramIR, layout: DiagramLayout, edges: Record<string, LaidOutEdge> = layout.edges): RouteMetrics {
	const parent = new Map(ir.nodes.map((n) => [n.key, n.parent]))
	const containers = new Set(ir.nodes.filter((n) => n.isContainer || ir.nodes.some((c) => c.parent === n.key)).map((n) => n.key))
	const ancestors = (k: string) => {
		const out: string[] = []
		let p = parent.get(k)
		while (p && !out.includes(p)) {
			out.push(p)
			p = parent.get(p)
		}
		return out
	}
	const byKey = new Map(ir.edges.map((e) => [e.key, e]))
	const m: RouteMetrics = { edges: 0, bends: 0, crossings: 0, length: 0, wallCrossings: 0, extraWallCrossings: 0, nodeHits: 0, diagonals: 0 }
	const all: { key: string; s: [Point, Point][] }[] = []
	for (const [key, le] of Object.entries(edges)) {
		const e = byKey.get(key)
		if (!e) continue
		const s = segs(le.points)
		all.push({ key, s })
		m.edges++
		m.bends += bendCount(le.points)
		m.length += polylineLength(le.points)
		m.diagonals += s.filter(([a, b]) => Math.abs(a.x - b.x) > EPS && Math.abs(a.y - b.y) > EPS).length
		const af = ancestors(e.from)
		const at = ancestors(e.to)
		let walls = 0
		for (const g of containers) {
			const box = layout.nodes[g]
			if (!box) continue
			// an endpoint that is the group itself: its border is the attachment, not a crossing
			if (g === e.from || g === e.to) continue
			for (const [a, b] of s) walls += borderCrossings(a, b, box)
		}
		const required = af.filter((g) => !at.includes(g) && g !== e.to).length + at.filter((g) => !af.includes(g) && g !== e.from).length
		m.wallCrossings += walls
		m.extraWallCrossings += Math.max(0, walls - required)
		for (const [k, box] of Object.entries(layout.nodes)) {
			if (k === e.from || k === e.to || containers.has(k)) continue
			if (s.some(([a, b]) => segmentHitsBox(a, b, box))) m.nodeHits++
		}
	}
	for (let i = 0; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			for (const [a, b] of all[i].s) for (const [c, d] of all[j].s) if (properCross(a, b, c, d)) m.crossings++
		}
	}
	m.length = Math.round(m.length)
	return m
}
