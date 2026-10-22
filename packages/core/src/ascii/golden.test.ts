import { describe, expect, it } from 'vitest'
import { printOcto } from '../dsl/print'
import { parseOcto } from '../dsl/parse'
import { goldenAll, goldenNew } from '../fixtures/asciiGolden'
import { detectFormat, importText } from '../import/detect'
import type { DiagramIR, SeqMessage } from '../ir'
import { parseAscii, stripStep } from './parse'
import { irEdges, parseGoldenEdge, precision, recall, scoreIR, scoreTable, type Score } from './score'

const labelOf = (ir: DiagramIR, key: string) => {
	const n = ir.nodes.find((x) => x.key === key)
	return n?.label ?? n?.key
}

describe('golden ASCII fixtures', () => {
	it.each(Object.entries(goldenAll))('%s', (_name, f) => {
		const { ir } = parseAscii(f.text)
		if (f.kind) expect(ir.kind).toBe(f.kind)
		expect(ir.nodes.map((n) => n.label ?? n.key)).toEqual(expect.arrayContaining(f.nodes))
		expect(ir.nodes).toHaveLength(f.nodes.length)
		const got = irEdges(ir).map((e) => `${e.key}${e.label ? `: ${e.label.toLowerCase()}` : ''}`)
		const want = f.edges.map((s) => {
			const e = parseGoldenEdge(s)
			return `${e.key}${e.label ? `: ${e.label.toLowerCase()}` : ''}`
		})
		expect(got.sort()).toEqual(want.sort())
		for (const [child, parent] of Object.entries(f.parents ?? {})) {
			const n = ir.nodes.find((x) => (x.label ?? x.key) === child)!
			expect(labelOf(ir, n.parent!)).toBe(parent)
		}
		for (const [label, shape] of Object.entries(f.shapes ?? {})) {
			expect(ir.nodes.find((x) => (x.label ?? x.key) === label)!.shape).toBe(shape)
		}
	})

	it.each(Object.keys(goldenNew))('detects %s as ascii', (name) => {
		expect(detectFormat(goldenNew[name].text)).toBe('ascii')
	})

	it('scores precision / recall over all fixtures', () => {
		const rows: [string, Score][] = Object.entries(goldenAll).map(([name, f]) => [name, scoreIR(parseAscii(f.text).ir, f)])
		const { table, total } = scoreTable(rows)
		console.log(`\nASCII import scores\n${table}\n`)
		expect(precision(total.nodes)).toBeGreaterThanOrEqual(0.95)
		expect(recall(total.nodes)).toBeGreaterThanOrEqual(0.95)
		expect(precision(total.edges)).toBeGreaterThanOrEqual(0.95)
		expect(recall(total.edges)).toBeGreaterThanOrEqual(0.95)
		expect(total.labels.ok / total.labels.total).toBeGreaterThanOrEqual(0.9)
	})

	it('scorer counts misses and extras', () => {
		const ir = parseAscii('A --> B --> C').ir
		const s = scoreIR(ir, { nodes: ['A', 'B', 'D'], edges: ['A > B', 'C > B'] })
		expect(s.nodes).toEqual({ tp: 2, fp: 1, fn: 1 })
		expect(s.edges).toEqual({ tp: 1, fp: 1, fn: 1 })
	})
})

describe('ASCII robustness details', () => {
	it('keeps straight-through continuity at a crossing but merges a fork', () => {
		expect(parseAscii(goldenNew.crossingUnicode.text).ir.edges).toHaveLength(2)
		const org = parseAscii(goldenNew.orgChart.text).ir
		expect(org.edges.map((e) => `${e.from}-${e.to}`)).toEqual(['CEO-CTO', 'CEO-CFO', 'CEO-COO'])
	})

	it('reads undirected chains as chains, not labels', () => {
		const { ir } = parseAscii('client --- server --- db')
		expect(ir.edges.map((e) => [e.from, e.to, e.label, e.arrow.end])).toEqual([
			['client', 'server', undefined, 'none'],
			['server', 'db', undefined, 'none'],
		])
		// ...but a word inside a directed line is still a label
		expect(parseAscii('A --- ok ---> B').ir.edges.map((e) => e.label)).toEqual(['ok'])
	})

	it('strips step numbers', () => {
		expect(stripStep('1. Clone')).toBe('Clone')
		expect(stripStep('Step 2: Build')).toBe('Build')
		expect(stripStep('(3) Test')).toBe('Test')
		expect(stripStep('2FA check')).toBe('2FA check')
		expect(stripStep('3.5 inch')).toBe('3.5 inch')
	})

	it('builds sequence IR with dashes, direction and order', () => {
		const { ir, confidence } = parseAscii(goldenNew.seqPlain.text)
		const msgs = ir.sequence!.events as SeqMessage[]
		expect(msgs.map((m) => m.dash)).toEqual(['solid', 'solid', 'dotted', 'solid'])
		expect(msgs[2]).toMatchObject({ from: 'DB', to: 'API', arrow: { start: 'none', end: 'arrow' } })
		expect(confidence).toBeGreaterThan(0.9)
		const code = printOcto(ir)
		expect(code.startsWith('sequence')).toBe(true)
		expect(parseOcto(code).ir.sequence!.events).toHaveLength(4)
	})

	it('dotted unicode returns in a boxed sequence', () => {
		const msgs = parseAscii(goldenNew.seqBoxes.text).ir.sequence!.events as SeqMessage[]
		expect(msgs[2]).toMatchObject({ from: 'Users', to: 'Auth', dash: 'dotted', label: 'user row' })
	})

	it('does not mistake stacked boxes with long lines for a sequence', () => {
		const src = `
┌─────┐       ┌─────┐
│  A  │       │  B  │
└──┬──┘       └──┬──┘
   │             │
   │             │
   │             │
   ▼             ▼
┌─────┐       ┌─────┐
│  C  │       │  D  │
└─────┘       └─────┘`
		const { ir } = parseAscii(src)
		expect(ir.kind).toBe('flowchart')
		expect(ir.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['A>C', 'B>D'])
	})

	it('markdown tables become ERD entities with fields and FKs', () => {
		const { ir } = parseAscii(goldenNew.markdownErd.text)
		const posts = ir.nodes.find((n) => n.key === 'posts')!
		expect(posts.fields).toEqual([
			{ name: 'id', type: 'SERIAL', meta: ['pk'] },
			{ name: 'user_id', type: 'INTEGER', meta: ['fk'] },
			{ name: 'title', type: 'TEXT' },
		])
		expect(ir.edges.map((e) => `${e.from}.${e.fromField} > ${e.to}.${e.toField} ${e.cardinality}`)).toEqual([
			'posts.user_id > users.id n-1',
			'comments.post_id > posts.id n-1',
			'comments.author_id > users.id n-1',
		])
		const code = printOcto(ir)
		const back = parseOcto(code)
		expect(back.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(back.ir.edges).toHaveLength(3)
	})

	it('infers FKs from field names and ignores tables without a type column', () => {
		const md = '**teams**\n| field | type |\n|---|---|\n| id | uuid |\n\n**members**\n| field | type |\n|---|---|\n| id | uuid |\n| teamId | uuid |'
		const { ir } = parseAscii(md)
		expect(ir.kind).toBe('erd')
		expect(ir.edges.map((e) => `${e.from}.${e.fromField}>${e.to}.${e.toField}`)).toEqual(['members.teamId>teams.id'])
		expect(detectFormat('| Name | Age |\n|------|-----|\n| Bob  | 3   |')).toBe('plain')
		expect(detectFormat(md)).toBe('ascii')
	})

	it('parses CJK boxes either way the model counted widths', () => {
		for (const name of ['cjkDisplay', 'cjkMiscount'] as const) {
			const { ir, diagnostics } = parseAscii(goldenNew[name].text)
			expect(diagnostics).toEqual([])
			expect(ir.edges.length).toBeGreaterThan(0)
		}
	})
})

describe('importText pins', () => {
	it('preserves the drawn arrangement', () => {
		const r = importText(goldenNew.microservices.text)!
		const p = r.pins!
		expect(Object.keys(p).sort()).toEqual(['Gateway', 'Inventory', 'Kafka', 'Orders'])
		// left-to-right order on the top row, Kafka below Orders
		expect(p.Gateway.x).toBeLessThan(p.Orders.x)
		expect(p.Orders.x).toBeLessThan(p.Inventory.x)
		expect(p.Gateway.y).toBe(p.Orders.y)
		expect(p.Kafka.y).toBeGreaterThan(p.Orders.y + 48)
		expect(Math.abs(p.Kafka.x - p.Orders.x)).toBeLessThan(20)
	})

	it('pushes cramped nodes apart and skips containers', () => {
		const r = importText('[A]->[B]->[C]')!
		const xs = ['A', 'B', 'C'].map((k) => r.pins![k].x)
		expect(xs[1] - xs[0]).toBeGreaterThanOrEqual(120)
		expect(xs[2] - xs[1]).toBeGreaterThanOrEqual(120)
		const nested = importText(goldenNew.k8sNested.text)!
		expect(nested.pins!['Kubernetes Cluster']).toBeUndefined()
		expect(nested.pins!['namespace: prod']).toBeUndefined()
		expect(nested.pins!.Ingress).toBeDefined()
	})

	it('omits pins for sequence and ERD imports', () => {
		expect(importText(goldenNew.seqPlain.text)!.pins).toBeUndefined()
		expect(importText(goldenNew.markdownErd.text)!.pins).toBeUndefined()
	})
})
