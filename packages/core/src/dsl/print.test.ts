import { describe, expect, it } from 'vitest'
import type { DiagramIR } from '../ir'
import { parseOcto } from './parse'
import { printOcto, quoteName, quoteValue } from './print'

/** Strip spans and sort nodes so IRs from different texts can be compared. */
function norm(ir: DiagramIR) {
	return {
		...ir,
		nodes: ir.nodes.map(({ span: _s, ...n }) => n).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
		edges: ir.edges.map(({ span: _s, ...e }) => e),
	}
}

const CASES: Record<string, string> = {
	contract: `title My system
direction right
colorMode pastel
styleMode shadow
typeface clean
Users [icon: users, shape: oval]
Backend [color: blue] {
  API gateway [icon: server]
  Worker [icon: cpu]
  "Pub/Sub" [icon: radio]
}
DB [shape: cylinder, icon: database, label: "Postgres 16"]
Users > API gateway: HTTPS
API gateway > Worker, "Pub/Sub"
Worker > DB > Backups
Worker <> Cache: [color: red]
Worker -- Logs
API gateway --> Audit: async [id: audit-edge]`,
	empty: '',
	onlyTitle: 'title Hello world',
	architecture: 'architecture\nA > B',
	architectureDown: 'architecture\ndirection down\nA',
	allOps: 'A > B\nA < B\nA <> B\nA - B\nA -- B\nA --> B',
	repeatedPairs: 'A > B\nA > B: second\nA > B [id: custom]\nA > B',
	nested: 'Outer [icon: cloud] {\n  Inner [color: red] {\n    Leaf [shape: diamond]\n  }\n  Side\n}\nLeaf > Side',
	references: 'A [icon: a]\nB\nG {\n  A, B\n}\nA > B',
	emptyGroup: 'G {\n}',
	quotedNames: '"a, b" > "c: d"\n"x > y" -- "[z]"\n"title thing" > "flowchart"\n"say \\"hi\\"" > back\\slash',
	specialValues: 'A [label: "hello, world", link: https://x.com/a?b=c, color: #ff00aa, tier: gold, pin]',
	edgeProps: 'A > B: label [color: red, dash: dashed]\nC --> D [id: c-d]',
	labels: 'A > B: has: colon, comma > op\nB > C: "[bracket]"\nC > D: "  padded  "\nD > E: "quoted" thing',
	unknownShape: 'A [shape: blob]',
	isolated: 'Lonely\nA > B',
	multiId: 'A > B, C [id: e]',
	weirdTitle: 'title "  // not a comment "',
	hashNames: '"#tag" > "a // b"',
	implicitInGroup: 'G {\n  X > Y\n}',
}

describe('printOcto round-trip', () => {
	for (const [name, src] of Object.entries(CASES)) {
		it(name, () => {
			const first = parseOcto(src)
			const printed = printOcto(first.ir)
			const second = parseOcto(printed)
			expect(second.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
			expect(norm(second.ir)).toEqual(norm(first.ir))
			// Idempotent.
			expect(printOcto(second.ir)).toBe(printed)
		})
	}
})

describe('printOcto output', () => {
	it('canonical form of the contract example', () => {
		expect(printOcto(parseOcto(CASES.contract).ir)).toBe(`title My system
direction right
colorMode pastel
styleMode shadow
typeface clean

Users [shape: oval, icon: users]
Backend [color: blue] {
	API gateway [icon: server]
	Worker [icon: cpu]
	Pub/Sub [icon: radio]
}
DB [shape: cylinder, icon: database, label: "Postgres 16"]

Users > API gateway: HTTPS
API gateway > Worker
API gateway > Pub/Sub
Worker > DB
DB > Backups
Worker <> Cache [color: red]
Worker -- Logs
API gateway --> Audit: async [id: audit-edge]
`)
	})

	it('empty IR prints empty string', () => {
		expect(printOcto(parseOcto('').ir)).toBe('')
	})

	it('omits default direction, prints header for non-flowchart', () => {
		expect(printOcto(parseOcto('architecture\nA').ir)).toBe('architecture\n\nA\n')
	})

	it('handles hand-built IR with non-container parents and cycles', () => {
		const ir: DiagramIR = {
			version: 1,
			kind: 'flowchart',
			direction: 'down',
			style: {},
			nodes: [{ key: 'P' }, { key: 'C', parent: 'P' }, { key: 'X', parent: 'Y' }, { key: 'Y', parent: 'X' }, { key: 'Z', parent: 'missing' }],
			edges: [{ key: 'weird', from: 'C', to: 'Z', arrow: { start: 'arrow', end: 'none' }, line: { dash: 'dotted' }, label: 'two\nlines' }],
		}
		const out = printOcto(ir)
		const back = parseOcto(out)
		expect(back.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(back.ir.nodes.find((n) => n.key === 'C')!.parent).toBe('P')
		expect(back.ir.edges[0]).toMatchObject({ key: 'weird', label: 'two lines' })
		expect(back.ir.nodes.map((n) => n.key).sort()).toEqual(['C', 'P', 'X', 'Y', 'Z'])
	})

	it('quoteName / quoteValue', () => {
		expect(quoteName('API gateway')).toBe('API gateway')
		expect(quoteName('main-vpc')).toBe('main-vpc')
		expect(quoteName('a - b')).toBe('"a - b"')
		expect(quoteName('direction')).toBe('"direction"')
		expect(quoteName('')).toBe('""')
		expect(quoteValue('blue')).toBe('blue')
		expect(quoteValue('two words')).toBe('"two words"')
		expect(quoteValue('a,b')).toBe('"a,b"')
	})
})
