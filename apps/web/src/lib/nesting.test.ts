import { describe, expect, it } from 'vitest'
import { parseOcto, parsePage } from '@octo-draw/core'
import { addChild, addSibling, groupNodes, moveIntoGroup, renameKey, ungroup, uniqueKey } from './nesting'

const parents = (src: string, page?: string) => {
	const r = page === undefined ? parseOcto(src) : parsePage(src, page)!
	expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	return Object.fromEntries(r.ir.nodes.map((n) => [n.key, n.parent ?? null]))
}
const node = (src: string, key: string) => parseOcto(src).ir.nodes.find((n) => n.key === key)

describe('addChild', () => {
	it('turns a leaf into a container, keeping its props', () => {
		const src = 'title T\nPayments [icon: credit-card]\nAPI > Payments\n'
		const out = addChild(src, 'Payments', 'New component')
		expect(out).toBe('title T\nPayments [icon: credit-card] {\n  New component\n}\nAPI > Payments\n')
		expect(node(out, 'Payments')).toMatchObject({ isContainer: true, icon: 'credit-card' })
		expect(parents(out)['New component']).toBe('Payments')
	})

	it('appends to an existing container using its child indent', () => {
		const src = 'Backend {\n\tAPI\n\tWorker\n}\n'
		expect(addChild(src, 'Backend', 'Queue')).toBe('Backend {\n\tAPI\n\tWorker\n\tQueue\n}\n')
	})

	it('opens up a one-line group', () => {
		const out = addChild('G { A }\n', 'G', 'B')
		expect(parents(out)).toMatchObject({ A: 'G', B: 'G' })
	})

	it('nests a leaf that sits inside a group in place', () => {
		const src = 'Backend {\n  API [icon: server]\n  Worker\n}\n'
		const out = addChild(src, 'API', 'Router')
		expect(out).toBe('Backend {\n  API [icon: server] {\n    Router\n  }\n  Worker\n}\n')
		expect(parents(out)).toMatchObject({ API: 'Backend', Router: 'API', Worker: 'Backend' })
	})

	it('splits a comma list', () => {
		const out = addChild('Backend {\n  A, B, C\n}\n', 'B', 'X')
		expect(parents(out)).toMatchObject({ A: 'Backend', B: 'Backend', C: 'Backend', X: 'B' })
		expect(node(out, 'B')?.isContainer).toBe(true)
	})

	it('declares an implicit node (only in a connection) as a group', () => {
		const src = 'A > B\n'
		const out = addChild(src, 'B', 'C')
		expect(parents(out)).toMatchObject({ A: null, B: null, C: 'B' })
		expect(node(out, 'B')?.isContainer).toBe(true)
		expect(parseOcto(out).ir.edges).toHaveLength(1)
	})

	it('builds 7 levels by repeated Tab', () => {
		let src = 'L0\n'
		for (let i = 1; i <= 7; i++) src = addChild(src, `L${i - 1}`, `L${i}`)
		const p = parents(src)
		for (let i = 1; i <= 7; i++) expect(p[`L${i}`]).toBe(`L${i - 1}`)
		expect(src.split('\n').find((l) => l.trim() === 'L7')).toBe('              L7')
	})

	it('only edits the given page', () => {
		const src = 'A\n\npage Sub\nX [icon: box]\n'
		const out = addChild(src, 'X', 'Y', 'Sub')
		expect(out).toBe('A\n\npage Sub\nX [icon: box] {\n  Y\n}\n')
		expect(parents(out, 'Sub')).toMatchObject({ X: null, Y: 'X' })
		expect(addChild(src, 'X', 'Y', 'Nope')).toBe(src)
	})
})

describe('addSibling', () => {
	it('adds right after the node in its container', () => {
		const src = 'G {\n  A\n  B\n}\nC\n'
		const out = addSibling(src, 'A', 'A2')
		expect(out).toBe('G {\n  A\n  A2\n  B\n}\nC\n')
	})

	it('adds a top-level sibling after a top-level node', () => {
		expect(addSibling('A\nB\nA > B\n', 'A', 'N')).toBe('A\nN\nB\nA > B\n')
	})

	it('adds after a nested group block', () => {
		const src = 'G {\n  H {\n    x\n  }\n  y\n}\n'
		const out = addSibling(src, 'H', 'H2')
		expect(out).toBe('G {\n  H {\n    x\n  }\n  H2\n  y\n}\n')
		expect(parents(out)).toMatchObject({ H2: 'G', x: 'H' })
	})

	it('handles implicit top-level nodes', () => {
		const out = addSibling('title T\nA > B\n', 'A', 'N')
		expect(parents(out)).toMatchObject({ N: null })
	})
})

describe('renameKey and uniqueKey', () => {
	it('renames everywhere and refuses collisions', () => {
		const src = 'G {\n  New component\n}\nNew component > X\n'
		expect(renameKey(src, 'New component', 'Auth')).toBe('G {\n  Auth\n}\nAuth > X\n')
		expect(renameKey(src, 'New component', 'X')).toBe(src)
		expect(renameKey(src, 'New component', 'a: b')).toBe('G {\n  "a: b"\n}\n"a: b" > X\n')
	})

	it('picks the first free key', () => {
		expect(uniqueKey('New component\nNew component 2\n', 'New component')).toBe('New component 3')
		expect(uniqueKey('A\n', 'New component')).toBe('New component')
	})
})

describe('groupNodes', () => {
	it('wraps top-level nodes in a new group', () => {
		const out = groupNodes('A\nB [icon: x]\nC\nA > B\n', ['A', 'B'], 'Group')
		expect(parents(out)).toMatchObject({ A: 'Group', B: 'Group', C: null })
		expect(node(out, 'B')?.icon).toBe('x')
	})

	it('nests inside the common container (adds one level)', () => {
		const src = 'Backend {\n  API [icon: server]\n  Worker\n  Queue\n}\nAPI > Worker\n'
		const out = groupNodes(src, ['API', 'Worker'], 'Core')
		expect(parents(out)).toMatchObject({ Backend: null, Core: 'Backend', API: 'Core', Worker: 'Core', Queue: 'Backend' })
		expect(out).toContain('  Core {\n    API [icon: server]\n    Worker\n  }')
		expect(node(out, 'API')?.icon).toBe('server')
		expect(parseOcto(out).ir.edges).toHaveLength(1)
	})

	it('moves selected groups with their whole block', () => {
		const src = 'G {\n  H {\n    a\n    b\n  }\n  c\n}\n'
		const out = groupNodes(src, ['H', 'c', 'a'], 'Inner')
		expect(parents(out)).toMatchObject({ G: null, Inner: 'G', H: 'Inner', c: 'Inner', a: 'H', b: 'H' })
	})

	it('uses the deepest common ancestor across levels', () => {
		const src = 'A {\n  B {\n    x\n  }\n  y\n}\n'
		expect(parents(groupNodes(src, ['x', 'y'], 'N'))).toMatchObject({ N: 'A', x: 'N', y: 'N', B: 'A' })
	})

	it('groups implicit nodes', () => {
		expect(parents(groupNodes('A > B > C\n', ['A', 'B'], 'G'))).toMatchObject({ A: 'G', B: 'G', C: null })
	})

	it('refuses an existing name', () => {
		expect(groupNodes('A\nB\n', ['A'], 'B')).toBe('A\nB\n')
	})
})

describe('moveIntoGroup', () => {
	it('moves a top-level node in and back out, keeping props', () => {
		const src = 'G {\n  a\n}\nB [icon: box]\nB > a\n'
		const inG = moveIntoGroup(src, 'B', 'G')
		expect(parents(inG)).toMatchObject({ B: 'G' })
		expect(node(inG, 'B')?.icon).toBe('box')
		const out = moveIntoGroup(inG, 'B', null)
		expect(parents(out)).toMatchObject({ B: null, a: 'G' })
		expect(node(out, 'B')?.icon).toBe('box')
	})

	it('moves an in-group declaration with props to another group', () => {
		const src = 'G {\n  a [icon: x]\n  b\n}\nH {\n  c\n}\n'
		const out = moveIntoGroup(src, 'a', 'H')
		expect(out).toBe('G {\n  b\n}\nH {\n  c\n  a [icon: x]\n}\n')
	})

	it('moves a whole group block, deeply', () => {
		const src = 'A {\n  B {\n    C {\n      D {\n        E {\n          F {\n            leaf\n          }\n        }\n      }\n    }\n  }\n}\nOther\n'
		const out = moveIntoGroup(src, 'D', 'Other')
		expect(parents(out)).toMatchObject({ D: 'Other', E: 'D', F: 'E', leaf: 'F', C: 'B' })
		const back = moveIntoGroup(out, 'D', null)
		expect(parents(back)).toMatchObject({ D: null, E: 'D', leaf: 'F' })
	})

	it('declares implicit nodes inside the group', () => {
		const out = moveIntoGroup('G {\n  x\n}\nA > B\n', 'B', 'G')
		expect(parents(out)).toMatchObject({ B: 'G', A: null })
	})

	it('refuses cycles and no-ops', () => {
		const src = 'G {\n  H {\n    x\n  }\n}\n'
		expect(moveIntoGroup(src, 'G', 'H')).toBe(src)
		expect(moveIntoGroup(src, 'G', 'G')).toBe(src)
		expect(moveIntoGroup(src, 'x', 'H')).toBe(src)
	})

	it('works on a sub-page only', () => {
		const src = 'G {\n  a\n}\n\npage P\nG {\n  a\n}\nb\n'
		const out = moveIntoGroup(src, 'b', 'G', 'P')
		expect(out.startsWith('G {\n  a\n}\n\npage P\n')).toBe(true)
		expect(parents(out, 'P')).toMatchObject({ b: 'G' })
	})
})

describe('ungroup', () => {
	it('keeps the children at the parent level', () => {
		const src = 'A {\n  G {\n    x\n    y\n  }\n}\n'
		expect(parents(ungroup(src, 'G'))).toEqual({ A: null, x: 'A', y: 'A' })
	})
})
