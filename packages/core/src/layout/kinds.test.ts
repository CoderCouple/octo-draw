import { describe, expect, it } from 'vitest'
import { parseOcto } from '../dsl/parse'
import { applyPins, layoutDiagram } from './layout'

describe('sequence layout', () => {
	const src = `sequence
autoNumber on
A > B: a fairly long request label here
activate B
B > C: q
C --> B: r
B --> A: done
deactivate B
loop [label: retry] {
	A > C: ping
	alt [label: ok] {
		C > A: pong
	} else [label: err] {
		note over A, C: give up
	}
}
note right of C: side
C > C: self
`
	it('places columns by first appearance and rows in time order', async () => {
		const ir = parseOcto(src).ir
		const l = await layoutDiagram(ir)
		const seq = l.sequence!
		expect(seq).toBeDefined()
		const x = (k: string) => seq.participants.find((p) => p.key === k)!.x
		expect(x('A')).toBeLessThan(x('B'))
		expect(x('B')).toBeLessThan(x('C'))
		// the long label fits between A and B
		expect(x('B') - x('A')).toBeGreaterThan(200)
		const ys = seq.messages.map((m) => m.y)
		expect([...ys].sort((p, q) => p - q)).toEqual(ys)
		expect(seq.messages.map((m) => m.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
		expect(l.nodes.A).toMatchObject({ y: 0, h: 44 })
		expect(seq.lifelines.every((ll) => ll.y2 > ys[ys.length - 1])).toBe(true)
	})

	it('draws activations, nested blocks with dividers and notes', async () => {
		const l = await layoutDiagram(parseOcto(src).ir)
		const seq = l.sequence!
		expect(seq.activations).toHaveLength(1)
		const act = seq.activations[0]
		expect(act.key).toBe('B')
		expect(act.y1).toBe(seq.messages[0].y)
		expect(act.y2).toBe(seq.messages[3].y)
		// messages touching an active lifeline end at the bar edge
		expect(seq.messages[1].x1).toBe(act.x + 5)
		expect(seq.blocks.map((b) => b.type)).toEqual(['loop', 'alt'])
		const [loop, alt] = seq.blocks
		expect(alt.y).toBeGreaterThan(loop.y)
		expect(alt.y + alt.h).toBeLessThan(loop.y + loop.h)
		expect(alt.x).toBeGreaterThan(loop.x)
		expect(alt.sections).toHaveLength(2)
		expect(alt.sections[1].y).toBeGreaterThan(alt.sections[0].y)
		expect(seq.notes).toHaveLength(2)
		const self = seq.messages[6]
		expect(self.self).toBe(true)
		expect(self.y2).toBeGreaterThan(self.y)
		expect(l.bounds.w).toBeGreaterThan(0)
	})

	it('is deterministic and ignores pins', async () => {
		const ir = parseOcto(src).ir
		const a = await layoutDiagram(ir)
		const b = await layoutDiagram(ir, { pinned: { A: { x: 500, y: 500 } } })
		expect(b).toEqual(a)
		expect(applyPins(ir, a, { A: { x: 1, y: 1 } })).toBe(a)
	})
})

describe('erd layout', () => {
	const src = `erd
users {
	id string pk
	name string
	teamId string fk
}
teams {
	id string pk
	title string
}
users.teamId > teams.id
users.id < posts.authorId
`
	it('sizes entities by rows and attaches edges to field rows', async () => {
		const ir = parseOcto(src).ir
		const l = await layoutDiagram(ir)
		const users = l.nodes.users
		expect(users.fields!.map((f) => f.name)).toEqual(['id', 'name', 'teamId'])
		expect(users.h).toBeGreaterThan(l.nodes.teams.h)
		const e = l.edges['users->teams#0']
		const teamRow = users.fields![2]
		expect(e.points[0].y).toBe(users.y + teamRow.y + teamRow.h / 2)
		const idRow = l.nodes.teams.fields![0]
		expect(e.points[e.points.length - 1].y).toBe(l.nodes.teams.y + idRow.y + idRow.h / 2)
		// orthogonal
		for (let i = 1; i < e.points.length; i++) {
			const p = e.points[i - 1]
			const q = e.points[i]
			expect(p.x === q.x || p.y === q.y).toBe(true)
		}
	})

	it('keeps field ports when an entity is pinned', async () => {
		const ir = parseOcto(src).ir
		const l = await layoutDiagram(ir, { pinned: { teams: { x: 900, y: 400 } } })
		expect(l.nodes.teams).toMatchObject({ x: 900, y: 400 })
		const e = l.edges['users->teams#0']
		const idRow = l.nodes.teams.fields![0]
		expect(e.points[e.points.length - 1]).toEqual({ x: 900, y: 400 + idRow.y + idRow.h / 2 })
	})
})
