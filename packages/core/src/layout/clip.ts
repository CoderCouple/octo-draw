import type { LaidOutNode, NodeShape, Point } from '../ir'

type Inside = (dx: number, dy: number, hw: number, hh: number) => boolean

/** Point-in-shape tests relative to the box center, for shapes whose outline is far from the box. */
const INSIDE: Partial<Record<NodeShape, Inside>> = {
	diamond: (dx, dy, hw, hh) => Math.abs(dx) / hw + Math.abs(dy) / hh <= 1,
	ellipse: (dx, dy, hw, hh) => (dx / hw) ** 2 + (dy / hh) ** 2 <= 1,
	cloud: (dx, dy, hw, hh) => (dx / (hw * 0.95)) ** 2 + (dy / (hh * 0.85)) ** 2 <= 1,
	star: (dx, dy, hw, hh) => (dx / (hw * 0.62)) ** 2 + (dy / (hh * 0.62)) ** 2 <= 1,
	oval: (dx, dy, hw, hh) => {
		const r = hh
		const ax = Math.abs(dx)
		if (ax <= hw - r) return Math.abs(dy) <= hh
		return (ax - (hw - r)) ** 2 + dy ** 2 <= r * r
	},
	triangle: (dx, dy, hw, hh) => {
		// apex at top center, base at bottom
		const t = (dy + hh) / (2 * hh)
		return t >= 0 && t <= 1 && Math.abs(dx) <= hw * t
	},
	hexagon: (dx, dy, hw, hh) => {
		const inset = Math.min(22, hw * 2 * 0.18)
		const ax = Math.abs(dx)
		if (Math.abs(dy) > hh) return false
		return ax <= hw - inset + inset * (1 - Math.abs(dy) / hh)
	},
}

/**
 * Moves an edge endpoint that sits on a node's bounding box inward along the
 * final segment until it touches the real outline (diamonds, ellipses, …).
 */
function clipEnd(end: Point, prev: Point, box: LaidOutNode, shape: NodeShape | undefined): Point {
	const inside = shape ? INSIDE[shape] : undefined
	if (!inside) return end
	const hw = box.w / 2
	const hh = box.h / 2
	const cx = box.x + hw
	const cy = box.y + hh
	const len = Math.hypot(end.x - prev.x, end.y - prev.y)
	if (len === 0) return end
	const ux = (end.x - prev.x) / len
	const uy = (end.y - prev.y) / len
	const max = Math.max(box.w, box.h)
	const at = (s: number) => ({ x: end.x + ux * s, y: end.y + uy * s })
	const isIn = (s: number) => {
		const p = at(s)
		return inside(p.x - cx, p.y - cy, hw, hh)
	}
	if (isIn(0)) return end
	// find the first sample inside, then bisect
	let hi = -1
	const steps = 24
	for (let i = 1; i <= steps; i++) {
		const s = (max * i) / steps
		if (isIn(s)) {
			hi = s
			break
		}
	}
	if (hi < 0) return end
	let lo = hi - max / steps
	for (let i = 0; i < 18; i++) {
		const mid = (lo + hi) / 2
		if (isIn(mid)) hi = mid
		else lo = mid
	}
	const p = at(hi)
	return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }
}

export function clipToShapes(
	points: Point[],
	from: LaidOutNode | undefined,
	to: LaidOutNode | undefined,
	fromShape: NodeShape | undefined,
	toShape: NodeShape | undefined,
): Point[] {
	if (points.length < 2) return points
	const out = points.slice()
	if (from && !from.isContainer) out[0] = clipEnd(out[0], out[1], from, fromShape)
	if (to && !to.isContainer) out[out.length - 1] = clipEnd(out[out.length - 1], out[out.length - 2], to, toShape)
	return out
}
