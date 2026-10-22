import type { Direction, Point } from '../ir'

export interface Box {
	x: number
	y: number
	w: number
	h: number
}

const cx = (b: Box) => b.x + b.w / 2
const cy = (b: Box) => b.y + b.h / 2

/** Point on the border of `b` along the ray from its center toward `p`. */
export function clipToBox(b: Box, p: Point): Point {
	const dx = p.x - cx(b)
	const dy = p.y - cy(b)
	if (dx === 0 && dy === 0) return { x: cx(b), y: cy(b) }
	const sx = dx === 0 ? Infinity : b.w / 2 / Math.abs(dx)
	const sy = dy === 0 ? Infinity : b.h / 2 / Math.abs(dy)
	const s = Math.min(sx, sy)
	return { x: cx(b) + dx * s, y: cy(b) + dy * s }
}

/**
 * Clean orthogonal route between two boxes (border to border): a straight
 * segment when the boxes overlap on one axis, otherwise a Z-shaped elbow whose
 * main axis follows the diagram direction.
 */
export function routeOrthogonal(a: Box, b: Box, direction: Direction = 'right'): Point[] {
	if (a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)) {
		// self loop: small rectangle off the top-right corner
		const r = a.x + a.w
		const t = a.y
		return [
			{ x: r - a.w * 0.25, y: t },
			{ x: r - a.w * 0.25, y: t - 24 },
			{ x: r + 24, y: t - 24 },
			{ x: r + 24, y: t + a.h * 0.25 },
			{ x: r, y: t + a.h * 0.25 },
		]
	}
	const xOverlapLo = Math.max(a.x, b.x)
	const xOverlapHi = Math.min(a.x + a.w, b.x + b.w)
	const yOverlapLo = Math.max(a.y, b.y)
	const yOverlapHi = Math.min(a.y + a.h, b.y + b.h)
	const xOverlap = xOverlapHi - xOverlapLo
	const yOverlap = yOverlapHi - yOverlapLo
	const aboveBelow = a.y + a.h <= b.y || b.y + b.h <= a.y
	const sideBySide = a.x + a.w <= b.x || b.x + b.w <= a.x

	if (xOverlap > 8 && aboveBelow) {
		const x = (xOverlapLo + xOverlapHi) / 2
		const down = cy(b) > cy(a)
		return [
			{ x, y: down ? a.y + a.h : a.y },
			{ x, y: down ? b.y : b.y + b.h },
		]
	}
	if (yOverlap > 8 && sideBySide) {
		const y = (yOverlapLo + yOverlapHi) / 2
		const right = cx(b) > cx(a)
		return [
			{ x: right ? a.x + a.w : a.x, y },
			{ x: right ? b.x : b.x + b.w, y },
		]
	}
	if (!aboveBelow && !sideBySide) {
		// overlapping boxes: straight line between borders
		return [clipToBox(a, { x: cx(b), y: cy(b) }), clipToBox(b, { x: cx(a), y: cy(a) })]
	}
	const horizontal =
		sideBySide && (!aboveBelow || direction === 'right' || direction === 'left')
	if (horizontal) {
		const right = cx(b) > cx(a)
		const ax = right ? a.x + a.w : a.x
		const bx = right ? b.x : b.x + b.w
		const mx = (ax + bx) / 2
		return [
			{ x: ax, y: cy(a) },
			{ x: mx, y: cy(a) },
			{ x: mx, y: cy(b) },
			{ x: bx, y: cy(b) },
		]
	}
	const down = cy(b) > cy(a)
	const ay = down ? a.y + a.h : a.y
	const by = down ? b.y : b.y + b.h
	const my = (ay + by) / 2
	return [
		{ x: cx(a), y: ay },
		{ x: cx(a), y: my },
		{ x: cx(b), y: my },
		{ x: cx(b), y: by },
	]
}

/** Point halfway along a polyline, by length. */
export function polylineMidpoint(points: Point[]): Point {
	if (points.length === 0) return { x: 0, y: 0 }
	if (points.length === 1) return points[0]
	let total = 0
	for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
	let half = total / 2
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]
		const b = points[i]
		const len = Math.hypot(b.x - a.x, b.y - a.y)
		if (len >= half && len > 0) {
			const t = half / len
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
		}
		half -= len
	}
	return points[points.length - 1]
}

/** Closest point to `p` on a polyline. */
export function nearestOnPolyline(points: Point[], p: Point): Point {
	if (points.length < 2) return points[0] ?? p
	let best = points[0]
	let bestD = Infinity
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]
		const b = points[i]
		const dx = b.x - a.x
		const dy = b.y - a.y
		const len2 = dx * dx + dy * dy
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
		const q = { x: a.x + dx * t, y: a.y + dy * t }
		const d = Math.hypot(q.x - p.x, q.y - p.y)
		if (d < bestD) {
			bestD = d
			best = q
		}
	}
	return best
}
