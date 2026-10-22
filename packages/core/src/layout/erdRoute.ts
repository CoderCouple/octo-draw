/** Field-to-field routing for ERD relationships (used by the ERD layout and by pins). */
import type { IREdge, LaidOutEdge, LaidOutNode, Point } from '../ir'
import { polylineMidpoint } from './route'

export const ERD_HEAD_H = 36
export const ERD_ROW_H = 28
/** Horizontal stub before the first bend: room for crow's-foot markers. */
const STUB = 28

/** y of the attribute row an edge attaches to (header middle when it names no attribute). */
export function fieldY(node: LaidOutNode, field: string | undefined): number {
	const row = field !== undefined ? node.fields?.find((f) => f.name === field) : undefined
	return node.y + (row ? row.y + row.h / 2 : ERD_HEAD_H / 2)
}

export function routeErdEdge(e: IREdge, nodes: Record<string, LaidOutNode>): LaidOutEdge | null {
	const a = nodes[e.from]
	const b = nodes[e.to]
	if (!a || !b) return null
	let ya = fieldY(a, e.fromField)
	let yb = fieldY(b, e.toField)
	const ar = a.x + a.w
	const br = b.x + b.w
	let points: Point[]
	if (a === b || e.from === e.to) {
		if (Math.abs(ya - yb) < 1) yb = ya + ERD_ROW_H / 2
		const x = ar + STUB
		points = [{ x: ar, y: ya }, { x, y: ya }, { x, y: yb }, { x: ar, y: yb }]
	} else if (ar + STUB * 2 <= b.x) {
		const mx = Math.round((ar + b.x) / 2)
		points = Math.abs(ya - yb) < 1 ? [{ x: ar, y: ya }, { x: b.x, y: ya }] : [{ x: ar, y: ya }, { x: mx, y: ya }, { x: mx, y: yb }, { x: b.x, y: yb }]
	} else if (br + STUB * 2 <= a.x) {
		const mx = Math.round((br + a.x) / 2)
		points = Math.abs(ya - yb) < 1 ? [{ x: a.x, y: ya }, { x: br, y: ya }] : [{ x: a.x, y: ya }, { x: mx, y: ya }, { x: mx, y: yb }, { x: br, y: yb }]
	} else {
		// stacked: leave and enter on the right side
		const x = Math.max(ar, br) + STUB
		if (Math.abs(ya - yb) < 1) yb += 1
		points = [{ x: ar, y: ya }, { x, y: ya }, { x, y: yb }, { x: br, y: yb }]
	}
	return { key: e.key, points, labelAt: e.label ? polylineMidpoint(points) : undefined }
}
