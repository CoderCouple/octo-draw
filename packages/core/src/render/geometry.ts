/**
 * Pure SVG path geometry shared by renderers (headless SVG in core; the web
 * canvas has an identical copy in apps/web/src/canvas/geometry.ts that should
 * import from here once the canvas files are free to edit).
 */

import type { NodeShape, Point } from '../ir'

const f = (n: number) => Math.round(n * 100) / 100

/** SVG path for a node outline in local coords (0,0)-(w,h), plus an optional stroke-only detail path. */
export function shapePath(shape: NodeShape | undefined, w: number, h: number): { d: string; detail?: string } {
	switch (shape ?? 'rectangle') {
		case 'rectangle':
			return { d: roundedRect(w, h, 8) }
		case 'oval':
			return { d: roundedRect(w, h, h / 2) }
		case 'ellipse': {
			const rx = w / 2
			const ry = h / 2
			return { d: `M0,${f(ry)} A${f(rx)},${f(ry)} 0 1 1 ${f(w)},${f(ry)} A${f(rx)},${f(ry)} 0 1 1 0,${f(ry)} Z` }
		}
		case 'diamond':
			return { d: poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], 4) }
		case 'cylinder': {
			const ry = Math.min(12, h * 0.16)
			const rx = w / 2
			return {
				d: `M0,${f(ry)} A${f(rx)},${f(ry)} 0 0 1 ${f(w)},${f(ry)} L${f(w)},${f(h - ry)} A${f(rx)},${f(ry)} 0 0 1 0,${f(h - ry)} Z`,
				detail: `M0,${f(ry)} A${f(rx)},${f(ry)} 0 0 0 ${f(w)},${f(ry)}`,
			}
		}
		case 'hexagon': {
			const i = Math.min(22, w * 0.18)
			return { d: poly([[i, 0], [w - i, 0], [w, h / 2], [w - i, h], [i, h], [0, h / 2]], 4) }
		}
		case 'parallelogram': {
			const s = Math.min(20, w * 0.15)
			return { d: poly([[s, 0], [w, 0], [w - s, h], [0, h]], 4) }
		}
		case 'trapezoid': {
			const s = Math.min(20, w * 0.15)
			return { d: poly([[s, 0], [w - s, 0], [w, h], [0, h]], 4) }
		}
		case 'document': {
			const wave = Math.min(10, h * 0.15)
			return {
				d: `M6,0 L${f(w - 6)},0 Q${f(w)},0 ${f(w)},6 L${f(w)},${f(h - wave)} C${f(w * 0.75)},${f(h - wave * 2.4)} ${f(w * 0.25)},${f(h + wave * 0.6)} 0,${f(h - wave)} L0,6 Q0,0 6,0 Z`,
			}
		}
		case 'triangle':
			return { d: poly([[w / 2, 0], [w, h], [0, h]], 4) }
		case 'star': {
			const pts: [number, number][] = []
			for (let i = 0; i < 10; i++) {
				const a = -Math.PI / 2 + (i * Math.PI) / 5
				const r = i % 2 === 0 ? 1 : 0.45
				pts.push([w / 2 + Math.cos(a) * r * (w / 2), h * 0.53 + Math.sin(a) * r * (h * 0.53)])
			}
			return { d: poly(pts, 2) }
		}
		case 'cloud': {
			const sx = w / 100
			const sy = h / 64
			const p = (x: number, y: number) => `${f(x * sx)},${f(y * sy)}`
			return {
				d: `M${p(24, 56)} C${p(8, 58)} ${p(0, 44)} ${p(10, 35)} C${p(4, 22)} ${p(18, 10)} ${p(31, 15)} C${p(36, 2)} ${p(58, 0)} ${p(65, 12)} C${p(78, 4)} ${p(94, 14)} ${p(89, 28)} C${p(102, 34)} ${p(98, 56)} ${p(80, 56)} Z`,
			}
		}
	}
	return { d: roundedRect(w, h, 8) }
}

export function roundedRect(w: number, h: number, r: number) {
	const rr = Math.max(0, Math.min(r, w / 2, h / 2))
	return `M${f(rr)},0 H${f(w - rr)} A${f(rr)},${f(rr)} 0 0 1 ${f(w)},${f(rr)} V${f(h - rr)} A${f(rr)},${f(rr)} 0 0 1 ${f(w - rr)},${f(h)} H${f(rr)} A${f(rr)},${f(rr)} 0 0 1 0,${f(h - rr)} V${f(rr)} A${f(rr)},${f(rr)} 0 0 1 ${f(rr)},0 Z`
}

/** Polygon with slightly rounded corners. */
function poly(pts: [number, number][], r: number) {
	const n = pts.length
	let d = ''
	for (let i = 0; i < n; i++) {
		const [x0, y0] = pts[(i - 1 + n) % n]
		const [x1, y1] = pts[i]
		const [x2, y2] = pts[(i + 1) % n]
		const l1 = Math.hypot(x1 - x0, y1 - y0)
		const l2 = Math.hypot(x2 - x1, y2 - y1)
		const r1 = Math.min(r, l1 / 2)
		const r2 = Math.min(r, l2 / 2)
		const ax = x1 - ((x1 - x0) / l1) * r1
		const ay = y1 - ((y1 - y0) / l1) * r1
		const bx = x1 + ((x2 - x1) / l2) * r2
		const by = y1 + ((y2 - y1) / l2) * r2
		d += `${i === 0 ? 'M' : 'L'}${f(ax)},${f(ay)} Q${f(x1)},${f(y1)} ${f(bx)},${f(by)} `
	}
	return d + 'Z'
}

/** Content box center (for label/icon) per shape: triangles push content down. */
export function contentCenterY(shape: NodeShape | undefined, h: number) {
	if (shape === 'triangle') return h * 0.66
	if (shape === 'cylinder') return h / 2 + Math.min(12, h * 0.16) / 2
	if (shape === 'document') return h / 2 - 3
	if (shape === 'star') return h * 0.55
	return h / 2
}

/** Polyline with rounded bends. */
export function roundedPolyline(points: Point[], radius = 10): string {
	if (points.length < 2) return ''
	let d = `M${f(points[0].x)},${f(points[0].y)}`
	for (let i = 1; i < points.length - 1; i++) {
		const p0 = points[i - 1]
		const p1 = points[i]
		const p2 = points[i + 1]
		const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y)
		const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y)
		const r = Math.min(radius, l1 / 2, l2 / 2)
		if (r < 0.5 || l1 === 0 || l2 === 0) {
			d += ` L${f(p1.x)},${f(p1.y)}`
			continue
		}
		const ax = p1.x - ((p1.x - p0.x) / l1) * r
		const ay = p1.y - ((p1.y - p0.y) / l1) * r
		const bx = p1.x + ((p2.x - p1.x) / l2) * r
		const by = p1.y + ((p2.y - p1.y) / l2) * r
		d += ` L${f(ax)},${f(ay)} Q${f(p1.x)},${f(p1.y)} ${f(bx)},${f(by)}`
	}
	const last = points[points.length - 1]
	return d + ` L${f(last.x)},${f(last.y)}`
}

/** Triangle arrowhead at `tip`, pointing away from `from`. */
export function arrowHead(from: Point, tip: Point, size = 10): string {
	const ang = Math.atan2(tip.y - from.y, tip.x - from.x)
	const a1 = ang + Math.PI - 0.42
	const a2 = ang + Math.PI + 0.42
	return `M${f(tip.x)},${f(tip.y)} L${f(tip.x + Math.cos(a1) * size)},${f(tip.y + Math.sin(a1) * size)} L${f(tip.x + Math.cos(a2) * size)},${f(tip.y + Math.sin(a2) * size)} Z`
}

/** Shortens a polyline at both ends (so the line doesn't poke through arrowheads). */
export function trimPolyline(points: Point[], start: number, end: number): Point[] {
	if (points.length < 2) return points
	const out = points.map((p) => ({ ...p }))
	const shift = (a: Point, b: Point, d: number) => {
		const l = Math.hypot(b.x - a.x, b.y - a.y)
		if (l <= d || l === 0) return
		a.x += ((b.x - a.x) / l) * d
		a.y += ((b.y - a.y) / l) * d
	}
	if (start) shift(out[0], out[1], start)
	if (end) shift(out[out.length - 1], out[out.length - 2], end)
	return out
}

/** Find the point a polyline approaches its end from, skipping zero-length tails. */
export function approachPoint(points: Point[], atEnd: boolean): Point {
	const seq = atEnd ? [...points].reverse() : points
	const tip = seq[0]
	for (let i = 1; i < seq.length; i++) if (Math.hypot(seq[i].x - tip.x, seq[i].y - tip.y) > 0.5) return seq[i]
	return { x: tip.x - 1, y: tip.y }
}
