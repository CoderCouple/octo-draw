import type { DiagramLayout } from '@octo-draw/core'
import type { FreeShape } from '../store'
import { shapeBounds, type Box } from './freehand'

/** A thin alignment guide: vertical (`axis: 'x'`, at x) or horizontal line. */
export interface Guide {
	axis: 'x' | 'y'
	at: number
	from: number
	to: number
}

/** Boxes the selection can snap to: other free shapes and diagram nodes, minus the moving ones. */
export function snapTargets(shapes: FreeShape[], layout: DiagramLayout | null, skipIds: Set<string>, skipKeys: Set<string>): Box[] {
	const out: Box[] = []
	for (const s of shapes) if (!skipIds.has(s.id)) out.push(shapeBounds(s))
	for (const n of Object.values(layout?.nodes ?? {})) if (!skipKeys.has(n.key)) out.push(n)
	return out
}

const xs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w]
const ys = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h]

function nearest(points: number[], targets: Box[], axis: 'x' | 'y', threshold: number): number | null {
	let best: number | null = null
	for (const t of targets) {
		for (const c of axis === 'x' ? xs(t) : ys(t)) {
			for (const p of points) {
				const d = c - p
				if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d
			}
		}
	}
	return best
}

/** Guides for every exact alignment between `box` and the targets (after snapping). */
export function guidesFor(box: Box, targets: Box[], only?: { x?: number[]; y?: number[] }): Guide[] {
	const out: Guide[] = []
	const seen = new Set<string>()
	const px = only?.x ?? xs(box)
	const py = only?.y ?? ys(box)
	for (const t of targets) {
		for (const c of xs(t)) {
			if (!px.some((p) => Math.abs(p - c) < 0.5)) continue
			const id = `x${Math.round(c)}`
			const g = { axis: 'x' as const, at: c, from: Math.min(box.y, t.y), to: Math.max(box.y + box.h, t.y + t.h) }
			if (seen.has(id)) {
				const prev = out.find((o) => o.axis === 'x' && Math.round(o.at) === Math.round(c))!
				prev.from = Math.min(prev.from, g.from)
				prev.to = Math.max(prev.to, g.to)
			} else {
				seen.add(id)
				out.push(g)
			}
		}
		for (const c of ys(t)) {
			if (!py.some((p) => Math.abs(p - c) < 0.5)) continue
			const id = `y${Math.round(c)}`
			const g = { axis: 'y' as const, at: c, from: Math.min(box.x, t.x), to: Math.max(box.x + box.w, t.x + t.w) }
			if (seen.has(id)) {
				const prev = out.find((o) => o.axis === 'y' && Math.round(o.at) === Math.round(c))!
				prev.from = Math.min(prev.from, g.from)
				prev.to = Math.max(prev.to, g.to)
			} else {
				seen.add(id)
				out.push(g)
			}
		}
	}
	return out
}

/** Nudge (dx, dy) that aligns the moving box's edges/center with a target's, within `threshold`. */
export function snapMove(box: Box, targets: Box[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
	const dx = nearest(xs(box), targets, 'x', threshold) ?? 0
	const dy = nearest(ys(box), targets, 'y', threshold) ?? 0
	const moved = { ...box, x: box.x + dx, y: box.y + dy }
	return { dx, dy, guides: dx || dy || targets.length ? guidesFor(moved, targets) : [] }
}

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** Snaps only the edges a resize handle moves. */
export function snapResize(box: Box, handle: HandleId, targets: Box[], threshold: number): { box: Box; guides: Guide[] } {
	let { x, y, w, h } = box
	const onlyX: number[] = []
	const onlyY: number[] = []
	if (handle.includes('w')) {
		const d = nearest([x], targets, 'x', threshold)
		if (d !== null) {
			x += d
			w -= d
		}
		onlyX.push(x)
	} else if (handle.includes('e')) {
		const d = nearest([x + w], targets, 'x', threshold)
		if (d !== null) w += d
		onlyX.push(x + w)
	}
	if (handle.includes('n')) {
		const d = nearest([y], targets, 'y', threshold)
		if (d !== null) {
			y += d
			h -= d
		}
		onlyY.push(y)
	} else if (handle.includes('s')) {
		const d = nearest([y + h], targets, 'y', threshold)
		if (d !== null) h += d
		onlyY.push(y + h)
	}
	const out = { x, y, w, h }
	return { box: out, guides: guidesFor(out, targets, { x: onlyX, y: onlyY }) }
}

/** New box from dragging `handle` of `start` by (dx, dy). Shift keeps the aspect ratio. Can flip. */
export function resizeBox(start: Box, handle: HandleId, dx: number, dy: number, keepAspect: boolean): Box {
	let l = start.x
	let t = start.y
	let r = start.x + start.w
	let b = start.y + start.h
	if (handle.includes('w')) l += dx
	if (handle.includes('e')) r += dx
	if (handle.includes('n')) t += dy
	if (handle.includes('s')) b += dy
	if (keepAspect && start.w > 0 && start.h > 0) {
		const aspect = start.w / start.h
		const corner = handle.length === 2
		let w = r - l
		let hh = b - t
		if (corner) {
			if (Math.abs(w) / aspect > Math.abs(hh)) hh = (Math.abs(w) / aspect) * Math.sign(hh || 1)
			else w = Math.abs(hh) * aspect * Math.sign(w || 1)
			if (handle.includes('w')) l = r - w
			else r = l + w
			if (handle.includes('n')) t = b - hh
			else b = t + hh
		} else if (handle === 'e' || handle === 'w') {
			const nh = Math.abs(w) / aspect
			const cy = start.y + start.h / 2
			t = cy - nh / 2
			b = cy + nh / 2
		} else {
			const nw = Math.abs(hh) * aspect
			const cx = start.x + start.w / 2
			l = cx - nw / 2
			r = cx + nw / 2
		}
	}
	return { x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t) }
}
