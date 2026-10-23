import { describe, expect, it } from 'vitest'
import { parseOcto } from '../dsl/parse'
import { layoutDiagram } from '../layout/layout'
import type { DiagramIR } from '../ir'
import { collapseGroups, focusGroup } from './groups'

const SRC = `Users [icon: users]
Cloud [color: gray] {
	Backend [color: blue, icon: server] {
		API
		Worker
		Jobs {
			Cron
			Queue
		}
	}
	Cache
}
Data {
	DB [shape: cylinder]
	Replica
}
Users > API: HTTPS
API > Worker: enqueue
Worker > Queue
API > DB: read
Worker > DB: write
Cron > DB: write
Worker > Cache
Cache > API
Replica - DB
Backend > Users: notify
`

const ir = () => parseOcto(SRC).ir
const keys = (x: DiagramIR) => x.nodes.map((n) => n.key)
const pairs = (x: DiagramIR) => x.edges.map((e) => `${e.from}>${e.to}${e.label ? ':' + e.label : ''}`)

/** Every edge endpoint exists and every parent is a container in the output. */
function expectValid(x: DiagramIR) {
	const byKey = new Map(x.nodes.map((n) => [n.key, n]))
	expect(byKey.size).toBe(x.nodes.length)
	for (const e of x.edges) {
		expect(byKey.has(e.from), e.from).toBe(true)
		expect(byKey.has(e.to), e.to).toBe(true)
	}
	expect(new Set(x.edges.map((e) => e.key)).size).toBe(x.edges.length)
	for (const n of x.nodes) if (n.parent !== undefined) expect(byKey.get(n.parent)?.isContainer).toBe(true)
}

describe('collapseGroups', () => {
	it('returns an equal copy when nothing is collapsed', () => {
		const input = ir()
		const out = collapseGroups(input, [])
		expect(out).toEqual(input)
		expect(out).not.toBe(input)
		expect(out.nodes[0]).not.toBe(input.nodes[0])
		expect(collapseGroups(input, ['Users', 'Nope'])).toEqual(input)
	})

	it('turns a container into a leaf and rewires edges', () => {
		const out = collapseGroups(ir(), ['Data'])
		expectValid(out)
		expect(keys(out)).toEqual(['Users', 'Cloud', 'Backend', 'API', 'Worker', 'Jobs', 'Cron', 'Queue', 'Cache', 'Data'])
		const data = out.nodes.find((n) => n.key === 'Data')!
		expect(data.isContainer).toBe(false)
		expect(data.ext).toEqual({ collapsed: '2' })
		// Replica - DB became a self-loop and is dropped; two "write" edges keep their shared label
		expect(pairs(out)).toEqual([
			'Users>API:HTTPS',
			'API>Worker:enqueue',
			'Worker>Queue',
			'API>Data:read',
			'Worker>Data:write',
			'Cron>Data:write',
			'Worker>Cache',
			'Cache>API',
			'Backend>Users:notify',
		])
	})

	it('merges parallel edges and counts distinct labels', () => {
		const out = collapseGroups(ir(), ['Backend'])
		expectValid(out)
		expect(keys(out)).toEqual(['Users', 'Cloud', 'Backend', 'Cache', 'Data', 'DB', 'Replica'])
		const backend = out.nodes.find((n) => n.key === 'Backend')!
		expect(backend).toMatchObject({ isContainer: false, parent: 'Cloud', icon: 'server', style: { color: 'blue' }, ext: { collapsed: '5' } })
		expect(pairs(out)).toEqual(['Users>Backend:HTTPS', 'Backend>DB:3 links', 'Backend>Cache', 'Cache>Backend', 'Replica>DB', 'Backend>Users:notify'])
		// the merged edge keeps the first edge's key and style
		expect(out.edges[1].key).toBe('API->DB#0')
	})

	it('drops labels when merged edges have none', () => {
		const x = parseOcto('G {\n A\n B\n}\nA > C\nB > C\nA > C\n').ir
		const out = collapseGroups(x, ['G'])
		expect(pairs(out)).toEqual(['G>C'])
		const y = parseOcto('G {\n A\n B\n}\nA > C: x\nB > C\n').ir
		expect(pairs(collapseGroups(y, ['G']))).toEqual(['G>C:x'])
	})

	it('keeps directions separate', () => {
		const x = parseOcto('G {\n A\n}\nA > C\nC > A\n').ir
		expect(pairs(collapseGroups(x, ['G']))).toEqual(['G>C', 'C>G'])
	})

	it('supports nested collapse (outermost wins)', () => {
		const out = collapseGroups(ir(), ['Jobs', 'Cloud'])
		expectValid(out)
		expect(keys(out)).toEqual(['Users', 'Cloud', 'Data', 'DB', 'Replica'])
		expect(out.nodes.find((n) => n.key === 'Cloud')!.ext).toEqual({ collapsed: '7' })
		expect(pairs(out)).toEqual(['Users>Cloud:HTTPS', 'Cloud>DB:3 links', 'Replica>DB', 'Cloud>Users:notify'])
		const inner = collapseGroups(ir(), ['Jobs'])
		expectValid(inner)
		expect(inner.nodes.find((n) => n.key === 'Jobs')).toMatchObject({ isContainer: false, parent: 'Backend', ext: { collapsed: '2' } })
		expect(pairs(inner)).toContain('Worker>Jobs')
		expect(pairs(inner)).toContain('Jobs>DB:write')
	})

	it('keeps untouched parallel edges as they are', () => {
		const x = parseOcto('G {\n A\n}\nB > C: one\nB > C: two\n').ir
		const out = collapseGroups(x, ['G'])
		expect(pairs(out)).toEqual(['B>C:one', 'B>C:two'])
	})

	it('keeps edges attached to the collapsed container itself', () => {
		const x = parseOcto('G {\n A\n}\nG > B\nA > B\n').ir
		const out = collapseGroups(x, ['G'])
		expect(pairs(out)).toEqual(['G>B'])
		expect(out.edges[0].key).toBe('G->B#0')
	})

	it('never mutates the input', () => {
		const input = ir()
		const before = structuredClone(input)
		collapseGroups(input, ['Backend', 'Data'])
		focusGroup(input, 'Backend')
		expect(input).toEqual(before)
	})

	it('drops ERD field anchors on rewired ends', () => {
		const x: DiagramIR = {
			version: 1,
			kind: 'flowchart',
			direction: 'down',
			style: {},
			nodes: [{ key: 'G', isContainer: true }, { key: 'A', parent: 'G' }, { key: 'B' }],
			edges: [{ key: 'e', from: 'A', to: 'B', fromField: 'id', toField: 'a_id', arrow: { start: 'none', end: 'arrow' }, line: { dash: 'solid' } }],
		}
		const out = collapseGroups(x, ['G'])
		expect(out.edges[0]).toMatchObject({ from: 'G', to: 'B', toField: 'a_id' })
		expect(out.edges[0].fromField).toBeUndefined()
	})
})

describe('focusGroup', () => {
	it('keeps only the descendants, re-parented to the top level', () => {
		const out = focusGroup(ir(), 'Backend')
		expectValid(out)
		const real = out.nodes.filter((n) => !n.ext?.ghost)
		expect(real.map((n) => [n.key, n.parent])).toEqual([
			['API', undefined],
			['Worker', undefined],
			['Jobs', undefined],
			['Cron', 'Jobs'],
			['Queue', 'Jobs'],
		])
		expect(real.find((n) => n.key === 'Jobs')!.isContainer).toBe(true)
	})

	it('adds ghost nodes for crossing edges', () => {
		const out = focusGroup(ir(), 'Backend')
		const ghosts = out.nodes.filter((n) => n.ext?.ghost)
		expect(ghosts.map((n) => n.key)).toEqual(['ghost:Users', 'ghost:Data', 'ghost:Cache'])
		expect(ghosts[0]).toEqual({ key: 'ghost:Users', label: 'Users', icon: 'users', ext: { ghost: 'true', ghostOf: 'Users' } })
		for (const g of ghosts) expect(g.parent).toBeUndefined()
		// Cache lives in Cloud, which encloses Backend, so it is its own ghost. DB folds into Data.
		// `Backend > Users` touches the focused group itself and is dropped.
		expect(pairs(out)).toEqual([
			'ghost:Users>API:HTTPS',
			'API>Worker:enqueue',
			'Worker>Queue',
			'API>ghost:Data:read',
			'Worker>ghost:Data:write',
			'Cron>ghost:Data:write',
			'Worker>ghost:Cache',
			'ghost:Cache>API',
		])
	})

	it('merges parallel crossing edges onto one ghost', () => {
		const x = parseOcto('G {\n A\n}\nH {\n B\n C\n}\nA > B: x\nA > C: y\n').ir
		const out = focusGroup(x, 'G')
		expect(pairs(out)).toEqual(['A>ghost:H:2 links'])
	})

	it('ghosts an enclosing container that is an edge endpoint', () => {
		const x = parseOcto('Outer {\n G {\n  A\n }\n}\nA > Outer\n').ir
		const out = focusGroup(x, 'G')
		expectValid(out)
		expect(pairs(out)).toEqual(['A>ghost:Outer'])
	})

	it('avoids ghost key collisions', () => {
		const x = parseOcto('G {\n "ghost:B"\n}\n"ghost:B" > B\n').ir
		const out = focusGroup(x, 'G')
		expectValid(out)
		expect(keys(out)).toEqual(['ghost:B', 'ghost:ghost:B'])
	})

	it('returns a copy for unknown keys and an empty diagram for leaves', () => {
		expect(focusGroup(ir(), 'Nope')).toEqual(ir())
		const leaf = focusGroup(ir(), 'Users')
		expect(leaf.nodes).toEqual([])
		expect(leaf.edges).toEqual([])
	})
})

describe('layout of drill views', () => {
	it('lays out a collapsed IR', async () => {
		const out = collapseGroups(ir(), ['Backend', 'Data'])
		const l = await layoutDiagram(out)
		expect(Object.keys(l.nodes).sort()).toEqual(keys(out).sort())
		expect(l.nodes.Backend.isContainer).toBe(false)
		expect(l.nodes.Cloud.isContainer).toBe(true)
		for (const e of out.edges) expect(l.edges[e.key].points.length).toBeGreaterThanOrEqual(2)
		const c = l.nodes.Cloud
		const b = l.nodes.Backend
		expect(b.x >= c.x && b.y >= c.y && b.x + b.w <= c.x + c.w && b.y + b.h <= c.y + c.h).toBe(true)
	})

	it('lays out a focused IR', async () => {
		const out = focusGroup(ir(), 'Backend')
		const l = await layoutDiagram(out)
		expect(Object.keys(l.nodes).sort()).toEqual(keys(out).sort())
		expect(l.nodes['ghost:Data'].isContainer).toBe(false)
		expect(l.nodes.Jobs.isContainer).toBe(true)
		for (const e of out.edges) expect(l.edges[e.key].points.length).toBeGreaterThanOrEqual(2)
	})

	it('lays out a collapsed focus', async () => {
		const out = collapseGroups(focusGroup(ir(), 'Backend'), ['Jobs'])
		expectValid(out)
		const l = await layoutDiagram(out)
		expect(l.nodes.Jobs.isContainer).toBe(false)
		expect(l.nodes.Cron).toBeUndefined()
	})
})
