import { describe, expect, it } from 'vitest'
import { layoutDiagram, parseOcto } from '@octo-draw/core'
import { applyPins } from '@octo-draw/core/src/layout/layout'
import { routeEdges } from './route'
import { routeMetrics } from './metrics'

const SRC = `direction right
Client [icon: monitor]
VPC {
  Public {
    LB [icon: server]
  }
  Private {
    API [icon: server]
    DB [icon: database]
  }
}
Client > LB: HTTPS
LB > API
API > DB: SQL
Client --> DB`

describe('routeEdges', () => {
	it('routes every edge orthogonally, attached to its endpoints, with labels placed', async () => {
		const ir = parseOcto(SRC).ir
		const layout = await layoutDiagram(ir)
		const res = routeEdges(layout, ir)
		expect(Object.keys(res.edges).sort()).toEqual(ir.edges.map((e) => e.key).sort())
		expect(Object.values(res.status).every((s) => s === 'valid')).toBe(true)
		const m = routeMetrics(ir, layout, res.edges)
		expect(m.diagonals).toBe(0)
		expect(m.nodeHits).toBe(0)
		// Known router behaviour (see docs/V2-SPIKE.md): Client -> DB cuts through the unrelated
		// `Public` group (in and out = 2 extra wall crossings) instead of going around it.
		expect(m.extraWallCrossings).toBe(2)
		for (const e of ir.edges) {
			const pts = res.edges[e.key].points
			const near = (k: string, p: { x: number; y: number }) => {
				const b = layout.nodes[k]
				return p.x >= b.x - 2 && p.x <= b.x + b.w + 2 && p.y >= b.y - 2 && p.y <= b.y + b.h + 2
			}
			expect(near(e.from, pts[0]), e.key).toBe(true)
			expect(near(e.to, pts[pts.length - 1]), e.key).toBe(true)
			if (e.label) expect(res.edges[e.key].labelAt, e.key).toBeDefined()
		}
	})

	it('is deterministic with the default (infinite) repair budget', async () => {
		const ir = parseOcto(SRC).ir
		const layout = await layoutDiagram(ir)
		expect(JSON.stringify(routeEdges(layout, ir).edges)).toBe(JSON.stringify(routeEdges(layout, ir).edges))
	})

	it('re-routes only touched edges after a drag and keeps the rest exactly', async () => {
		const ir = parseOcto(SRC).ir
		const layout = await layoutDiagram(ir)
		const before = routeEdges(layout, ir)
		const b = layout.nodes.Client
		const moved = applyPins(ir, layout, { Client: { x: b.x, y: b.y + 200 } })
		const after = routeEdges(moved, ir, { touched: { nodes: ['Client'] }, previous: before.edges })
		expect(after.status['LB->API#0']).toBe('adopted')
		expect(after.status['API->DB#0']).toBe('adopted')
		expect(after.status['Client->LB#0']).toBe('valid')
		expect(after.edges['LB->API#0'].points).toEqual(before.edges['LB->API#0'].points)
		expect(after.edges['Client->LB#0'].points).not.toEqual(before.edges['Client->LB#0'].points)
	})

	it('treats a moved container as touching its descendants’ edges', async () => {
		const ir = parseOcto(SRC).ir
		const layout = await layoutDiagram(ir)
		const before = routeEdges(layout, ir)
		const after = routeEdges(layout, ir, { touched: { nodes: ['Private'] }, previous: before.edges })
		expect(after.status['API->DB#0']).not.toBe('adopted')
		expect(after.status['Client->LB#0']).toBe('adopted')
	})

	it('skips self loops and sequence diagrams', async () => {
		const ir = parseOcto('A > A\nA > B').ir
		const res = routeEdges(await layoutDiagram(ir), ir)
		expect(res.skipped).toEqual(['A->A#0'])
		const seq = parseOcto('sequence\nA > B: hi').ir
		expect(Object.keys(routeEdges(await layoutDiagram(seq), seq).edges)).toEqual([])
	})
})
