import { describe, expect, it } from 'vitest'
import type { DiagramIR, IREdge, IRNode } from '../ir'
import { applyPins, layoutBase, layoutDiagram } from './layout'
import { routeOrthogonal, polylineMidpoint } from './route'
import { nodeSize, estimateText } from './sizing'

function edge(from: string, to: string, label?: string): IREdge {
	return {
		key: `${from}->${to}#0`,
		from,
		to,
		label,
		arrow: { start: 'none', end: 'arrow' },
		line: { dash: 'solid' },
	}
}

function ir(nodes: IRNode[], edges: IREdge[], direction: DiagramIR['direction'] = 'right'): DiagramIR {
	return { version: 1, kind: 'flowchart', direction, style: {}, nodes, edges }
}

const inside = (inner: { x: number; y: number; w: number; h: number }, outer: typeof inner) =>
	inner.x >= outer.x - 0.01 &&
	inner.y >= outer.y - 0.01 &&
	inner.x + inner.w <= outer.x + outer.w + 0.01 &&
	inner.y + inner.h <= outer.y + outer.h + 0.01

describe('layoutDiagram', () => {
	it('lays out a simple chain left to right', async () => {
		const l = await layoutDiagram(ir([{ key: 'A' }, { key: 'B' }, { key: 'C' }], [edge('A', 'B'), edge('B', 'C', 'next')]))
		expect(l.nodes.A.x).toBeLessThan(l.nodes.B.x)
		expect(l.nodes.B.x).toBeLessThan(l.nodes.C.x)
		expect(l.edges['A->B#0'].points.length).toBeGreaterThanOrEqual(2)
		expect(l.edges['B->C#0'].labelAt).toBeDefined()
		expect(l.bounds.w).toBeGreaterThan(0)
	})

	it('maps direction down', async () => {
		const l = await layoutDiagram(ir([{ key: 'A' }, { key: 'B' }], [edge('A', 'B')], 'down'))
		expect(l.nodes.A.y + l.nodes.A.h).toBeLessThanOrEqual(l.nodes.B.y)
	})

	it('maps direction up and left', async () => {
		const up = await layoutDiagram(ir([{ key: 'A' }, { key: 'B' }], [edge('A', 'B')], 'up'))
		expect(up.nodes.A.y).toBeGreaterThan(up.nodes.B.y)
		const left = await layoutDiagram(ir([{ key: 'A' }, { key: 'B' }], [edge('A', 'B')], 'left'))
		expect(left.nodes.A.x).toBeGreaterThan(left.nodes.B.x)
	})

	it('nests groups with absolute coordinates and room for a title', async () => {
		const l = await layoutDiagram(
			ir(
				[
					{ key: 'Users' },
					{ key: 'Backend', isContainer: true },
					{ key: 'API', parent: 'Backend', icon: 'server' },
					{ key: 'Worker', parent: 'Backend' },
					{ key: 'DB', shape: 'cylinder' },
				],
				[edge('Users', 'API'), edge('API', 'Worker'), edge('Worker', 'DB')],
			),
		)
		const g = l.nodes.Backend
		expect(g.isContainer).toBe(true)
		expect(l.nodes.API.depth).toBe(1)
		expect(inside(l.nodes.API, g)).toBe(true)
		expect(inside(l.nodes.Worker, g)).toBe(true)
		expect(l.nodes.API.y - g.y).toBeGreaterThanOrEqual(40)
		const pts = l.edges['Users->API#0'].points
		// orthogonal: each segment is axis-aligned
		for (let i = 1; i < pts.length; i++) {
			const horizontal = Math.abs(pts[i].y - pts[i - 1].y) < 0.01
			const vertical = Math.abs(pts[i].x - pts[i - 1].x) < 0.01
			expect(horizontal || vertical).toBe(true)
		}
	})

	it('sizes shapes: diamonds bigger, icons add space', () => {
		const rect = nodeSize({ key: 'Decide' }, estimateText)
		const diamond = nodeSize({ key: 'Decide', shape: 'diamond' }, estimateText)
		expect(diamond.w).toBeGreaterThan(rect.w)
		expect(diamond.h).toBeGreaterThan(rect.h)
		const long = nodeSize({ key: 'A pretty long label for a node' }, estimateText)
		const withIcon = nodeSize({ key: 'A pretty long label for a node', icon: 'server' }, estimateText)
		expect(withIcon.w).toBeGreaterThan(long.w)
	})

	it('uses measureText when given', async () => {
		const l = await layoutDiagram(ir([{ key: 'A' }], []), { measureText: () => ({ w: 400, h: 20 }) })
		expect(l.nodes.A.w).toBeGreaterThanOrEqual(400)
	})

	it('moves pinned nodes and re-routes their edges', async () => {
		const nodes: IRNode[] = [{ key: 'A' }, { key: 'B' }, { key: 'C' }]
		const edges = [edge('A', 'B'), edge('B', 'C')]
		const l = await layoutDiagram(ir(nodes, edges), { pinned: { B: { x: 500, y: 400 } } })
		expect(l.nodes.B.x).toBe(500)
		expect(l.nodes.B.y).toBe(400)
		const ab = l.edges['A->B#0'].points
		const last = ab[ab.length - 1]
		const b = l.nodes.B
		// ends on B's border
		const onBorder =
			(Math.abs(last.x - b.x) < 0.01 || Math.abs(last.x - (b.x + b.w)) < 0.01 || Math.abs(last.y - b.y) < 0.01 || Math.abs(last.y - (b.y + b.h)) < 0.01) &&
			last.x >= b.x - 0.01 &&
			last.x <= b.x + b.w + 0.01
		expect(onBorder).toBe(true)
		expect(l.bounds.y + l.bounds.h).toBeGreaterThanOrEqual(400 + b.h)
	})

	it('moves container children with a pinned container and refits parents', async () => {
		const nodes: IRNode[] = [
			{ key: 'G', isContainer: true },
			{ key: 'X', parent: 'G' },
			{ key: 'Y', parent: 'G' },
			{ key: 'Z' },
		]
		const base = await layoutDiagram(ir(nodes, [edge('X', 'Y'), edge('Y', 'Z')]))
		const pinned = await layoutDiagram(ir(nodes, [edge('X', 'Y'), edge('Y', 'Z')]), { pinned: { G: { x: 1000, y: 1000 } } })
		const dx = pinned.nodes.G.x - base.nodes.G.x
		expect(pinned.nodes.X.x - base.nodes.X.x).toBeCloseTo(dx)
		expect(inside(pinned.nodes.X, pinned.nodes.G)).toBe(true)

		// pin a child far outside: container grows to fit
		const out = await layoutDiagram(ir(nodes, [edge('X', 'Y')]), { pinned: { X: { x: 2000, y: 50 } } })
		expect(inside(out.nodes.X, out.nodes.G)).toBe(true)
		expect(inside(out.nodes.Y, out.nodes.G)).toBe(true)
	})

	it('handles edges to containers, self loops, empty groups and dangling refs', async () => {
		const l = await layoutDiagram(
			ir(
				[{ key: 'G', isContainer: true }, { key: 'A', parent: 'G' }, { key: 'E', isContainer: true }, { key: 'B' }],
				[edge('G', 'B'), edge('A', 'A'), edge('G', 'A'), edge('B', 'missing')],
			),
		)
		expect(l.nodes.E.w).toBeGreaterThan(0)
		expect(l.edges['G->B#0']).toBeDefined()
		expect(l.edges['A->A#0']).toBeDefined()
		expect(l.edges['G->A#0']).toBeDefined()
		expect(l.edges['B->missing#0']).toBeUndefined()
	})

	it('applyPins is pure and keeps identity of untouched nodes', async () => {
		const d = ir([{ key: 'A' }, { key: 'B' }, { key: 'C' }], [edge('A', 'B')])
		const base = await layoutBase(d)
		const moved = applyPins(d, base, { C: { x: 900, y: 900 } })
		expect(moved.nodes.A).toBe(base.nodes.A)
		expect(moved.edges['A->B#0']).toBe(base.edges['A->B#0'])
		expect(moved.nodes.C.x).toBe(900)
		expect(base.nodes.C.x).not.toBe(900)
		expect(applyPins(d, base, {})).toBe(base)
	})

	it('keeps model order when breaking cycles', async () => {
		const l = await layoutDiagram(ir([{ key: 'A' }, { key: 'B' }, { key: 'C' }], [edge('A', 'B'), edge('B', 'C'), edge('B', 'A')]))
		expect(l.nodes.A.x).toBeLessThan(l.nodes.B.x)
		expect(l.nodes.B.x).toBeLessThan(l.nodes.C.x)
	})

	it('clips edge ends to non-rectangular outlines', async () => {
		const d = ir([{ key: 'A' }, { key: 'D', shape: 'diamond' }], [edge('A', 'D')])
		const base = await layoutBase(d)
		const a = base.nodes.A
		const moved = applyPins(d, base, { D: { x: a.x + 400, y: a.y - base.nodes.D.h / 2 + 10 } })
		const pts = moved.edges['A->D#0'].points
		const end = pts[pts.length - 1]
		const dn = moved.nodes.D
		// straight horizontal line hits the diamond's slanted side, not its bbox
		expect(end.x).toBeGreaterThan(dn.x + 1)
		const dx = Math.abs(end.x - (dn.x + dn.w / 2)) / (dn.w / 2)
		const dy = Math.abs(end.y - (dn.y + dn.h / 2)) / (dn.h / 2)
		expect(dx + dy).toBeCloseTo(1, 1)
	})

	it('returns empty bounds for an empty diagram', async () => {
		const l = await layoutDiagram(ir([], []))
		expect(l.bounds).toEqual({ x: 0, y: 0, w: 0, h: 0 })
	})
})

describe('routeOrthogonal', () => {
	it('draws a straight line when boxes overlap on an axis', () => {
		const pts = routeOrthogonal({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 10, w: 100, h: 40 })
		expect(pts).toHaveLength(2)
		expect(pts[0]).toEqual({ x: 100, y: 25 })
		expect(pts[1]).toEqual({ x: 200, y: 25 })
	})
	it('draws an elbow otherwise', () => {
		const pts = routeOrthogonal({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 300, w: 100, h: 40 }, 'right')
		expect(pts).toHaveLength(4)
		expect(pts[0].x).toBe(100)
		expect(pts[3].x).toBe(300)
	})
	it('finds polyline midpoints', () => {
		expect(polylineMidpoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toEqual({ x: 10, y: 0 })
	})
})
