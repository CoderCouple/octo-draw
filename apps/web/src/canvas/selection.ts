import type { DiagramLayout, Point } from '@octo-draw/core'
import type { FreeShape } from '../store'
import { shapeBounds, type Box } from './freehand'

export function unionBox(boxes: Box[]): Box | null {
	if (!boxes.length) return null
	let x = Infinity
	let y = Infinity
	let r = -Infinity
	let b = -Infinity
	for (const o of boxes) {
		x = Math.min(x, o.x)
		y = Math.min(y, o.y)
		r = Math.max(r, o.x + o.w)
		b = Math.max(b, o.y + o.h)
	}
	return { x, y, w: r - x, h: b - y }
}

export const intersects = (a: Box, b: Box) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
export const contains = (outer: Box, inner: Box) =>
	inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h

export function normBox(a: Point, b: Point): Box {
	return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

/** Bounds of the selected free shapes and diagram nodes. */
export function selectionBounds(shapes: FreeShape[], layout: DiagramLayout | null, ids: string[], keys: string[]): Box | null {
	const set = new Set(ids)
	const boxes = shapes.filter((s) => set.has(s.id)).map(shapeBounds)
	for (const k of keys) {
		const n = layout?.nodes[k]
		if (n) boxes.push(n)
	}
	return unionBox(boxes)
}

/** Free shapes touched by the marquee; leaf nodes touched by it; groups only when fully enclosed. */
export function marqueeHits(shapes: FreeShape[], layout: DiagramLayout | null, box: Box): { ids: string[]; keys: string[] } {
	const ids = shapes.filter((s) => intersects(box, shapeBounds(s))).map((s) => s.id)
	const keys: string[] = []
	for (const n of Object.values(layout?.nodes ?? {})) {
		if (n.isContainer ? contains(box, n) : intersects(box, n)) keys.push(n.key)
	}
	return { ids, keys }
}

export function distToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x
	const dy = b.y - a.y
	const l2 = dx * dx + dy * dy
	const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Nearest diagram edge whose polyline (or label) is within `tol` world units of `p`. */
export function hitEdge(layout: DiagramLayout | null, p: Point, tol: number): string | null {
	if (!layout) return null
	let best: string | null = null
	let bestD = tol
	for (const e of Object.values(layout.edges)) {
		const pts = e.points
		for (let i = 1; i < pts.length; i++) {
			const d = distToSegment(p, pts[i - 1], pts[i])
			if (d <= bestD) {
				bestD = d
				best = e.key
			}
		}
		if (e.labelAt && Math.abs(p.x - e.labelAt.x) < 24 && Math.abs(p.y - e.labelAt.y) < 10 && bestD > 0) {
			best = e.key
			bestD = 0
		}
	}
	return best
}

/** Node keys whose ancestor is also in `keys` (moving the ancestor already moves them). */
export function withoutDescendants(keys: string[], parentOf: Map<string, string | undefined>): string[] {
	const set = new Set(keys)
	return keys.filter((k) => {
		let a = parentOf.get(k)
		let guard = 0
		while (a && guard++ < 64) {
			if (set.has(a)) return false
			a = parentOf.get(a)
		}
		return true
	})
}
