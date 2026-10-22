/**
 * Layout hints for imports: turns source rectangles (ASCII grid cells, image
 * bounding boxes) into canvas pins (top-left points per node key) so an
 * import keeps the arrangement the author drew.
 *
 * Steps: scale the source rectangles to canvas units, centre each node's real
 * canvas size on its source centre, snap near-aligned centres onto shared
 * rows / columns, then push overlapping nodes apart along the axis they were
 * already separated on (so left/right and above/below order is kept).
 * Containers are never pinned: the layout refits them around their children.
 */
import type { DiagramIR, IRNode, Point } from '../ir'
import { estimateText, nodeSize } from '../layout/sizing'

/** A rectangle in source units (grid cells, pixels or 0–1000 normalised). */
export interface SourceRect {
	x: number
	y: number
	w: number
	h: number
}

/** ASCII grid rectangle: rows/cols are 0-based cell indices, `rows`/`cols` the extent. */
export interface CellRect {
	row: number
	col: number
	rows: number
	cols: number
}

export interface PinOptions {
	/** Canvas units per source unit on each axis. */
	scaleX: number
	scaleY: number
	/** Minimum gap between pinned nodes (canvas units). */
	gap?: number
	/** Centres closer than this (canvas units) snap onto one row / column. */
	snap?: number
}

/** Monospace cell → canvas units. Cells are ~1:2, canvas nodes are larger than glyphs. */
export const ASCII_CELL = { w: 11, h: 26 }

export function cellToRect(c: CellRect): SourceRect {
	return { x: c.col, y: c.row, w: c.cols, h: c.rows }
}

export function pinsFromCells(ir: DiagramIR, cells: Record<string, CellRect>): Record<string, Point> {
	const rects: Record<string, SourceRect> = {}
	for (const [k, c] of Object.entries(cells)) rects[k] = cellToRect(c)
	return pinsFromRects(ir, rects, { scaleX: ASCII_CELL.w, scaleY: ASCII_CELL.h })
}

interface Placed {
	key: string
	cx: number
	cy: number
	w: number
	h: number
	parent?: string
}

export function pinsFromRects(ir: DiagramIR, rects: Record<string, SourceRect>, opts: PinOptions): Record<string, Point> {
	const gap = opts.gap ?? 28
	const snap = opts.snap ?? 14
	const byKey = new Map<string, IRNode>(ir.nodes.map((n) => [n.key, n]))
	const containers = new Set(ir.nodes.filter((n) => n.isContainer).map((n) => n.key))
	for (const n of ir.nodes) if (n.parent) containers.add(n.parent)
	const placed: Placed[] = []
	for (const [key, r] of Object.entries(rects)) {
		const node = byKey.get(key)
		if (!node || containers.has(key)) continue
		if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue
		const size = nodeSize(node, estimateText)
		placed.push({
			key,
			cx: (r.x + r.w / 2) * opts.scaleX,
			cy: (r.y + r.h / 2) * opts.scaleY,
			w: size.w,
			h: size.h,
			parent: node.parent,
		})
	}
	if (!placed.length) return {}
	snapAxis(placed, 'cx', snap)
	snapAxis(placed, 'cy', snap)
	separate(placed, gap)
	// Shift so the top-left of the drawing sits at a small margin.
	const minX = Math.min(...placed.map((p) => p.cx - p.w / 2))
	const minY = Math.min(...placed.map((p) => p.cy - p.h / 2))
	const out: Record<string, Point> = {}
	for (const p of placed) {
		out[p.key] = { x: Math.round(p.cx - p.w / 2 - minX + 40), y: Math.round(p.cy - p.h / 2 - minY + 40) }
	}
	return out
}

/** Clusters near-equal centre coordinates and moves them to the cluster mean. */
function snapAxis(ps: Placed[], axis: 'cx' | 'cy', tol: number) {
	const sorted = [...ps].sort((a, b) => a[axis] - b[axis])
	let group: Placed[] = []
	const flush = () => {
		if (group.length > 1) {
			const m = group.reduce((s, p) => s + p[axis], 0) / group.length
			for (const p of group) p[axis] = m
		}
		group = []
	}
	for (const p of sorted) {
		if (group.length && p[axis] - group[group.length - 1][axis] > tol) flush()
		group.push(p)
	}
	flush()
}

/**
 * Pushes overlapping nodes apart. Each pair is separated along the axis on
 * which their source centres differ most (normalised by size), moving the
 * later node away from the earlier one so the original order is kept.
 */
function separate(ps: Placed[], gap: number) {
	const order = [...ps].sort((a, b) => a.cy - b.cy || a.cx - b.cx)
	for (let round = 0; round < 12; round++) {
		let moved = false
		for (let i = 0; i < order.length; i++) {
			for (let j = i + 1; j < order.length; j++) {
				const a = order[i]
				const b = order[j]
				const needX = (a.w + b.w) / 2 + gap - Math.abs(a.cx - b.cx)
				const needY = (a.h + b.h) / 2 + gap - Math.abs(a.cy - b.cy)
				if (needX <= 0 || needY <= 0) continue
				const dx = Math.abs(a.cx - b.cx) / (a.w + b.w)
				const dy = Math.abs(a.cy - b.cy) / (a.h + b.h)
				if (dx > dy) {
					const sign = b.cx >= a.cx ? 1 : -1
					shift(order, a, b, 'cx', sign * needX)
				} else {
					const sign = b.cy >= a.cy ? 1 : -1
					shift(order, a, b, 'cy', sign * needY)
				}
				moved = true
			}
		}
		if (!moved) break
	}
}

/** Moves `p` and every node beyond it on that axis (keeps rows/columns aligned). */
function shift(ps: Placed[], anchor: Placed, p: Placed, axis: 'cx' | 'cy', d: number) {
	const from = p[axis]
	for (const q of ps) {
		if (q === p || q === anchor) continue
		if (d > 0 ? q[axis] > from : q[axis] < from) q[axis] += d
		else if (q[axis] === from) q[axis] += d
	}
	p[axis] += d
}
