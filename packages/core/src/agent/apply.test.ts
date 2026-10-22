import { describe, expect, it } from 'vitest'
import { parseOcto } from '../dsl/parse'
import { applyActions } from './apply'

const BASE = `title Shop
direction right

Users [icon: users]
Backend [color: blue] {
	API [icon: server]
	Worker
}
DB [shape: cylinder]

Users > API: HTTPS
API > Worker, DB
Worker > DB > Backups
`

const ir = (code: string) => parseOcto(code).ir
const node = (code: string, key: string) => ir(code).nodes.find((n) => n.key === key)

describe('applyActions — nodes', () => {
	it('addNode at top level goes after the last declaration', () => {
		const r = applyActions(BASE, [{ type: 'addNode', key: 'Cache', shape: 'cylinder', label: 'Redis cache' }])
		expect(r.errors).toEqual([])
		expect(r.applied).toBe(1)
		expect(r.code).toContain('DB [shape: cylinder]\nCache [shape: cylinder, label: "Redis cache"]\n\nUsers > API')
		expect(node(r.code, 'Cache')).toMatchObject({ shape: 'cylinder', label: 'Redis cache' })
	})

	it('addNode inside a parent group with matching indentation', () => {
		const r = applyActions(BASE, [{ type: 'addNode', key: 'Queue', icon: 'radio', parent: 'Backend' }])
		expect(r.code).toContain('\tWorker\n\tQueue [icon: radio]\n}')
		expect(node(r.code, 'Queue')!.parent).toBe('Backend')
	})

	it('addNode into single-line and empty groups', () => {
		const a = applyActions('G {}\n', [{ type: 'addNode', key: 'X', parent: 'G' }])
		expect(a.code).toBe('G {\n\tX\n}\n')
		const b = applyActions('  G { A }\n', [{ type: 'addNode', key: 'X', parent: 'G' }])
		expect(node(b.code, 'X')!.parent).toBe('G')
		expect(node(b.code, 'A')!.parent).toBe('G')
	})

	it('addNode with a new parent creates the group', () => {
		const r = applyActions('A\n', [{ type: 'addNode', key: 'X', parent: 'NewG' }])
		expect(r.code).toBe('A\nNewG {\n\tX\n}\n')
		expect(node(r.code, 'NewG')!.isContainer).toBe(true)
	})

	it('addNode into empty source and source with only edges', () => {
		expect(applyActions('', [{ type: 'addNode', key: 'A' }]).code).toBe('A\n')
		expect(applyActions('A > B', [{ type: 'addNode', key: 'C' }]).code).toBe('C\nA > B')
		expect(applyActions('title T', [{ type: 'addNode', key: 'C' }]).code).toBe('title T\nC')
	})

	it('addNode on an existing node patches it (and can move it)', () => {
		const r = applyActions(BASE, [{ type: 'addNode', key: 'Backups', icon: 'archive', parent: 'Backend' }])
		expect(r.errors).toEqual([])
		expect(node(r.code, 'Backups')).toMatchObject({ icon: 'archive', parent: 'Backend' })
	})

	it('addNode with a non-group parent is an error', () => {
		const r = applyActions(BASE, [{ type: 'addNode', key: 'X', parent: 'DB' }])
		expect(r.applied).toBe(0)
		expect(r.code).toBe(BASE)
		expect(r.errors[0]).toMatchObject({ index: 0 })
	})

	it('updateNode patches each field', () => {
		const r = applyActions(BASE, [{ type: 'updateNode', key: 'DB', label: 'Postgres', color: 'green', icon: 'database' }])
		expect(r.code).toContain('DB [shape: cylinder, icon: database, color: green, label: Postgres]')
	})

	it('updateNode on implicit node appends a declaration', () => {
		const r = applyActions(BASE, [{ type: 'updateNode', key: 'Backups', shape: 'document' }])
		expect(r.code).toBe(BASE + 'Backups [shape: document]\n')
	})

	it('updateNode errors on unknown key / bad shape', () => {
		const r = applyActions(BASE, [
			{ type: 'updateNode', key: 'Nope', label: 'x' },
			{ type: 'updateNode', key: 'DB', shape: 'blob' as never },
			{ type: 'updateNode', key: 'DB', label: 'ok' },
		])
		expect(r.applied).toBe(1)
		expect(r.errors.map((e) => e.index)).toEqual([0, 1])
		expect(r.errors[0].message).toMatch(/Unknown node "Nope"/)
	})

	it('removeNode deletes declaration and rewrites connection lines', () => {
		const r = applyActions(BASE, [{ type: 'removeNode', key: 'DB' }])
		expect(r.errors).toEqual([])
		expect(r.code).toBe(`title Shop
direction right

Users [icon: users]
Backend [color: blue] {
	API [icon: server]
	Worker
}

Users > API: HTTPS
API > Worker
`)
		expect(ir(r.code).nodes.map((n) => n.key)).not.toContain('DB')
	})

	it('removeNode keeps unrelated chain edges', () => {
		const r = applyActions('A > B > C > D\n', [{ type: 'removeNode', key: 'C' }])
		expect(r.code).toBe('A > B\n')
		const r2 = applyActions('  A > B, C: x [id: k]\n', [{ type: 'removeNode', key: 'B' }])
		expect(r2.code).toBe('  A > C: x [id: k#1]\n')
	})

	it('removeNode removes group references', () => {
		const r = applyActions('A\nB\nG {\n  A, B\n}\n', [{ type: 'removeNode', key: 'A' }])
		expect(r.code).toBe('B\nG {\n  B\n}\n')
	})

	it('removeNode on a group unwraps its children', () => {
		const r = applyActions(BASE, [{ type: 'removeNode', key: 'Backend' }])
		expect(r.errors).toEqual([])
		expect(r.code).toContain('Users [icon: users]\nAPI [icon: server]\nWorker\nDB')
		const n = ir(r.code)
		expect(n.nodes.find((x) => x.key === 'Backend')).toBeUndefined()
		expect(n.nodes.find((x) => x.key === 'API')!.parent).toBeUndefined()
	})

	it('removeNode on a nested group moves children to grandparent', () => {
		const r = applyActions('O {\n\tI {\n\t\tL\n\t}\n}\n', [{ type: 'removeNode', key: 'I' }])
		expect(r.code).toBe('O {\n\tL\n}\n')
		const r2 = applyActions('O { I { L } }', [{ type: 'removeNode', key: 'I' }])
		expect(node(r2.code, 'L')!.parent).toBe('O')
	})

	it('removeNode unknown is an error', () => {
		expect(applyActions(BASE, [{ type: 'removeNode', key: 'Zzz' }]).errors).toHaveLength(1)
	})
})

describe('applyActions — edges', () => {
	it('addEdge appends a connection line', () => {
		const r = applyActions(BASE, [
			{ type: 'addEdge', from: 'Worker', to: 'Cache', label: 'reads, writes', op: '<>', id: 'wc' },
			{ type: 'addEdge', from: 'API gateway', to: 'Users' },
		])
		expect(r.code).toBe(BASE + 'Worker <> Cache: reads, writes [id: wc]\nAPI gateway > Users\n')
		const e = ir(r.code).edges
		expect(e.find((x) => x.key === 'wc')).toMatchObject({ label: 'reads, writes', arrow: { start: 'arrow', end: 'arrow' } })
	})

	it('addEdge rejects duplicate ids', () => {
		const r = applyActions('A > B [id: x]', [{ type: 'addEdge', from: 'B', to: 'C', id: 'x' }])
		expect(r.errors).toHaveLength(1)
	})

	it('removeEdge by pair (including within branches)', () => {
		const r = applyActions(BASE, [{ type: 'removeEdge', from: 'API', to: 'DB' }])
		expect(r.code).toContain('API > Worker\nWorker > DB > Backups')
		expect(ir(r.code).edges.some((e) => e.from === 'API' && e.to === 'DB')).toBe(false)
	})

	it('removeEdge by id and reversed pair', () => {
		expect(applyActions('A > B [id: x]\nA > B\n', [{ type: 'removeEdge', from: 'A', to: 'B', id: 'x' }]).code).toBe('A > B\n')
		expect(applyActions('A < B\nC\n', [{ type: 'removeEdge', from: 'B', to: 'A' }]).code).toBe('C\n')
	})

	it('removeEdge error when missing', () => {
		const r = applyActions(BASE, [{ type: 'removeEdge', from: 'DB', to: 'Users' }])
		expect(r.errors[0].message).toMatch(/No connection/)
		expect(r.code).toBe(BASE)
	})
})

describe('applyActions — groups, direction, replace', () => {
	it('addGroup creates a block and moves existing children', () => {
		const r = applyActions(BASE, [{ type: 'addGroup', key: 'Storage', color: 'green', children: ['DB', 'Backups'] }])
		expect(r.errors).toEqual([])
		expect(r.code).toContain('DB [shape: cylinder]\nStorage [color: green] {\n\tDB\n\tBackups\n}\n')
		expect(node(r.code, 'DB')!.parent).toBe('Storage')
		expect(node(r.code, 'Backups')!.parent).toBe('Storage')
		expect(node(r.code, 'DB')!.shape).toBe('cylinder')
	})

	it('addGroup moves a child out of another group', () => {
		const r = applyActions(BASE, [{ type: 'addGroup', key: 'Jobs', children: ['Worker'] }])
		expect(node(r.code, 'Worker')!.parent).toBe('Jobs')
	})

	it('addGroup on an existing group adds references', () => {
		const r = applyActions(BASE, [{ type: 'addGroup', key: 'Backend', children: ['DB'] }])
		expect(r.code).toContain('\tWorker\n\tDB\n}')
		expect(node(r.code, 'DB')!.parent).toBe('Backend')
	})

	it('addGroup errors when key is a plain node or contains itself', () => {
		const r = applyActions(BASE, [
			{ type: 'addGroup', key: 'DB' },
			{ type: 'addGroup', key: 'G', children: ['G'] },
		])
		expect(r.errors.map((e) => e.index)).toEqual([0, 1])
	})

	it('setDirection replaces or inserts', () => {
		expect(applyActions(BASE, [{ type: 'setDirection', direction: 'down' }]).code).toBe(BASE.replace('direction right', 'direction down'))
		expect(applyActions('title T\nA > B\n', [{ type: 'setDirection', direction: 'left' }]).code).toBe('title T\ndirection left\nA > B\n')
		expect(applyActions('A > B\n', [{ type: 'setDirection', direction: 'up' }]).code).toBe('direction up\nA > B\n')
		expect(applyActions('', [{ type: 'setDirection', direction: 'up' }]).code).toBe('direction up\n')
		expect(applyActions('A', [{ type: 'setDirection', direction: 'sideways' as never }]).errors).toHaveLength(1)
	})

	it('replaceCode octo', () => {
		const r = applyActions(BASE, [{ type: 'replaceCode', code: 'X > Y' }])
		expect(r.code).toBe('X > Y')
	})

	it('replaceCode mermaid converts to octo', () => {
		const r = applyActions('', [{ type: 'replaceCode', format: 'mermaid', code: 'flowchart LR\n  A[Start] --> B{Ok?}\n  B -->|yes| C' }])
		expect(r.errors).toEqual([])
		const out = ir(r.code)
		expect(out.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['A', 'B', 'C']))
		expect(out.edges).toHaveLength(2)
		expect(out.direction).toBe('right')
	})

	it('a full agent run composes and is valid', () => {
		const r = applyActions(BASE, [
			{ type: 'addGroup', key: 'Data', children: ['DB'] },
			{ type: 'addNode', key: 'Cache', shape: 'cylinder', parent: 'Data' },
			{ type: 'addEdge', from: 'Worker', to: 'Cache', op: '-->' },
			{ type: 'updateNode', key: 'Users', label: 'End users' },
			{ type: 'removeNode', key: 'Backups' },
			{ type: 'setDirection', direction: 'down' },
		])
		expect(r.errors).toEqual([])
		expect(r.applied).toBe(6)
		const { ir: out, diagnostics } = parseOcto(r.code)
		expect(diagnostics).toEqual([])
		expect(out.direction).toBe('down')
		expect(out.nodes.find((n) => n.key === 'Cache')!.parent).toBe('Data')
		expect(out.nodes.find((n) => n.key === 'Users')!.label).toBe('End users')
		expect(out.nodes.some((n) => n.key === 'Backups')).toBe(false)
	})

	it('collects errors for malformed actions without throwing', () => {
		const r = applyActions('A', [null as never, { type: 'bogus' } as never, { type: 'addNode' } as never])
		expect(r.applied).toBe(0)
		expect(r.errors.map((e) => e.index)).toEqual([0, 1, 2])
		expect(r.code).toBe('A')
	})
})
