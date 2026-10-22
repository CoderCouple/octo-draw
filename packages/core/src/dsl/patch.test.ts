import { describe, expect, it } from 'vitest'
import { parseOcto } from './parse'
import { renameNodeLabel, setEdgeProp, setNodeProp } from './patch'

const node = (src: string, key: string) => parseOcto(src).ir.nodes.find((n) => n.key === key)

describe('setNodeProp', () => {
	it('inserts a props block on a bare declaration', () => {
		expect(setNodeProp('A\nA > B\n', 'A', 'icon', 'server')).toBe('A [icon: server]\nA > B\n')
	})

	it('adds to an existing block', () => {
		expect(setNodeProp('A [icon: x] // c\n', 'A', 'color', 'red')).toBe('A [icon: x, color: red] // c\n')
	})

	it('fills an empty block', () => {
		expect(setNodeProp('A []\n', 'A', 'color', 'red')).toBe('A [color: red]\n')
	})

	it('replaces an existing value preserving surroundings', () => {
		expect(setNodeProp('  A [icon:x,   color: red ]  \n', 'A', 'icon', 'y')).toBe('  A [icon: y,   color: red ]  \n')
		expect(setNodeProp('A [pin]', 'A', 'pin', 'false')).toBe('A [pin: false]')
	})

	it('quotes values with spaces or special chars', () => {
		const out = setNodeProp('A', 'A', 'label', 'Hello, world')
		expect(out).toBe('A [label: "Hello, world"]')
		expect(node(out, 'A')!.label).toBe('Hello, world')
	})

	it('removes props', () => {
		expect(setNodeProp('A [icon: x, color: red, label: L]', 'A', 'color', null)).toBe('A [icon: x, label: L]')
		expect(setNodeProp('A [icon: x, color: red]', 'A', 'color', null)).toBe('A [icon: x]')
		expect(setNodeProp('A [icon: x, color: red]', 'A', 'icon', null)).toBe('A [color: red]')
		expect(setNodeProp('A [icon: x] {\n}', 'A', 'icon', null)).toBe('A {\n}')
		expect(setNodeProp('A [color: a, color: b]', 'A', 'color', null)).toBe('A')
		expect(setNodeProp('A', 'A', 'color', null)).toBe('A')
		expect(setNodeProp('A > B', 'A', 'color', null)).toBe('A > B')
	})

	it('edits group headers', () => {
		const src = 'Backend [color: blue] {\n  API\n}\n'
		expect(setNodeProp(src, 'Backend', 'icon', 'server')).toBe('Backend [color: blue, icon: server] {\n  API\n}\n')
		expect(setNodeProp('G {\n}', 'G', 'color', 'red')).toBe('G [color: red] {\n}')
	})

	it('edits nested declarations and quoted names', () => {
		const src = 'G {\n\t"Pub/Sub" [icon: radio]\n}\n'
		expect(setNodeProp(src, 'Pub/Sub', 'icon', 'queue')).toBe('G {\n\t"Pub/Sub" [icon: queue]\n}\n')
	})

	it('appends a declaration for implicit nodes', () => {
		expect(setNodeProp('A > B\n', 'B', 'shape', 'cylinder')).toBe('A > B\nB [shape: cylinder]\n')
		expect(setNodeProp('A > B', 'B', 'shape', 'cylinder')).toBe('A > B\nB [shape: cylinder]\n')
		expect(setNodeProp('', 'X y', 'icon', 'z')).toBe('X y [icon: z]\n')
		expect(setNodeProp('A', 'a > b', 'icon', 'z')).toBe('A\n"a > b" [icon: z]\n')
		const out = setNodeProp('A > B\n', 'B', 'shape', 'cylinder')
		expect(node(out, 'B')!.shape).toBe('cylinder')
	})

	it('uses the first declaration', () => {
		expect(setNodeProp('A [icon: a]\nA [color: b]', 'A', 'icon', 'z')).toBe('A [icon: z]\nA [color: b]')
	})

	it('edits props declared inside a connection', () => {
		expect(setNodeProp('A [icon: a] > B', 'A', 'icon', 'z')).toBe('A [icon: z] > B')
	})

	it('closes an unclosed block when appending', () => {
		const out = setNodeProp('A [icon: a\n', 'A', 'color', 'red')
		expect(out).toBe('A [icon: a, color: red]\n')
		expect(parseOcto(out).diagnostics).toEqual([])
	})
})

describe('renameNodeLabel', () => {
	it('sets label without changing identity', () => {
		const src = 'title T\nDB [shape: cylinder]\nAPI > DB\n'
		const out = renameNodeLabel(src, 'DB', 'Postgres 16')
		expect(out).toBe('title T\nDB [shape: cylinder, label: "Postgres 16"]\nAPI > DB\n')
		const ir = parseOcto(out).ir
		expect(ir.nodes.find((n) => n.key === 'DB')!.label).toBe('Postgres 16')
		expect(ir.edges[0].to).toBe('DB')
	})

	it('replaces an existing label', () => {
		expect(renameNodeLabel('A [label: "Old one"]', 'A', 'New')).toBe('A [label: New]')
	})

	it('escapes quotes', () => {
		const out = renameNodeLabel('A', 'A', 'say "hi"')
		expect(node(out, 'A')!.label).toBe('say "hi"')
	})
})

describe('setEdgeProp', () => {
	const edge = (src: string, key: string) => parseOcto(src).ir.edges.find((e) => e.key === key)

	it('appends a props block to a bare connection', () => {
		expect(setEdgeProp('A > B // hi\n', 'A->B#0', 'color', 'red')).toBe('A > B [color: red] // hi\n')
		expect(setEdgeProp('A > B: HTTPS\n', 'A->B#0', 'color', 'red')).toBe('A > B: HTTPS [color: red]\n')
		expect(edge(setEdgeProp('A > B: HTTPS\n', 'A->B#0', 'color', 'red'), 'A->B#0')!.style?.color).toBe('red')
	})

	it('edits an existing block', () => {
		expect(setEdgeProp('A > B [color: red]\n', 'A->B#0', 'color', 'blue')).toBe('A > B [color: blue]\n')
		expect(setEdgeProp('A > B: x [dash: dotted]', 'A->B#0', 'color', 'blue')).toBe('A > B: x [dash: dotted, color: blue]')
		expect(setEdgeProp('A > B: [color: red]', 'A->B#0', 'color', 'green')).toBe('A > B: [color: green]')
	})

	it('removes props and empty blocks', () => {
		expect(setEdgeProp('A > B [color: red, dash: dotted]', 'A->B#0', 'color', null)).toBe('A > B [dash: dotted]')
		expect(setEdgeProp('A > B [color: red]\nB > C', 'A->B#0', 'color', null)).toBe('A > B\nB > C')
		expect(setEdgeProp('A > B', 'A->B#0', 'color', null)).toBe('A > B')
	})

	it('targets edges by explicit id', () => {
		const out = setEdgeProp('A --> B: async [id: e1]\n', 'e1', 'color', 'red')
		expect(out).toBe('A --> B: async [id: e1, color: red]\n')
		expect(edge(out, 'e1')!.style?.color).toBe('red')
	})

	it('does not confuse node props with edge props', () => {
		const out = setEdgeProp('A [icon: x] > B\n', 'A->B#0', 'color', 'red')
		expect(out).toBe('A [icon: x] > B [color: red]\n')
		const ir = parseOcto(out).ir
		expect(ir.nodes.find((n) => n.key === 'A')!.icon).toBe('x')
		expect(ir.edges[0].style?.color).toBe('red')
	})

	it('splits branching / chained statements so only the target changes', () => {
		const out = setEdgeProp('  A > B, C\n', 'A->C#0', 'color', 'red')
		expect(out).toBe('  A > B\n  A > C [color: red]\n')
		const chain = setEdgeProp('A > B > C', 'B->C#0', 'color', 'red')
		const ir = parseOcto(chain).ir
		expect(ir.edges.map((e) => [e.key, e.style?.color])).toEqual([
			['A->B#0', undefined],
			['B->C#0', 'red'],
		])
	})

	it('keeps node props when splitting', () => {
		const out = setEdgeProp('A [icon: x] > B, C', 'A->B#0', 'color', 'red')
		const ir = parseOcto(out).ir
		expect(ir.nodes.find((n) => n.key === 'A')!.icon).toBe('x')
		expect(ir.edges.find((e) => e.key === 'A->B#0')!.style?.color).toBe('red')
		expect(ir.edges.find((e) => e.key === 'A->C#0')!.style?.color).toBeUndefined()
	})

	it('leaves source unchanged for unknown keys', () => {
		expect(setEdgeProp('A > B', 'X->Y#0', 'color', 'red')).toBe('A > B')
	})
})
