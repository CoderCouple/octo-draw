/**
 * Precision / recall scorer for the ASCII importer against golden fixtures.
 * Nodes match by normalised label; edges by endpoint labels and direction
 * (`A > B`, `A <> B` and `A - B` are distinct; the latter two ignore order).
 * Edge labels are scored separately on matched edges that have a golden label.
 */
import type { DiagramIR } from '../ir'

export interface Score {
	nodes: { tp: number; fp: number; fn: number }
	edges: { tp: number; fp: number; fn: number }
	labels: { ok: number; total: number }
	kindOk: boolean
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

export function parseGoldenEdge(s: string): { key: string; label?: string } {
	const m = /^(.+?) (<>|>|-) (.+?)(?:: (.+))?$/.exec(s)
	if (!m) throw new Error(`bad golden edge ${s}`)
	return { key: edgeKey(m[1], m[2] as '>' | '<>' | '-', m[3]), label: m[4] }
}

function edgeKey(a: string, op: '>' | '<>' | '-', b: string): string {
	const x = norm(a)
	const y = norm(b)
	if (op === '>') return `${x} > ${y}`
	const [p, q] = x < y ? [x, y] : [y, x]
	return `${p} ${op} ${q}`
}

/** The IR's edges (or sequence messages) as label-level golden strings. */
export function irEdges(ir: DiagramIR): { key: string; label?: string }[] {
	const name = new Map(ir.nodes.map((n) => [n.key, n.label ?? n.key]))
	const label = (k: string) => name.get(k) ?? k
	const out: { key: string; label?: string }[] = []
	const push = (from: string, to: string, start: string, end: string, lab?: string) => {
		const op = start === 'arrow' && end === 'arrow' ? '<>' : end === 'arrow' ? '>' : start === 'arrow' ? '<' : '-'
		const key = op === '<' ? edgeKey(label(to), '>', label(from)) : edgeKey(label(from), op, label(to))
		out.push({ key, label: lab })
	}
	if (ir.kind === 'sequence') {
		for (const e of ir.sequence?.events ?? []) if (e.kind === 'message') push(e.from, e.to, e.arrow.start, e.arrow.end, e.label)
	} else if (ir.kind === 'erd') {
		for (const e of ir.edges) out.push({ key: edgeKey(label(e.from), '>', label(e.to)), label: e.label })
	} else for (const e of ir.edges) push(e.from, e.to, e.arrow.start, e.arrow.end, e.label)
	return out
}

function multisetMatch(got: string[], want: string[]) {
	const pool = new Map<string, number>()
	for (const w of want) pool.set(w, (pool.get(w) ?? 0) + 1)
	let tp = 0
	for (const g of got) {
		const n = pool.get(g) ?? 0
		if (n > 0) {
			tp++
			pool.set(g, n - 1)
		}
	}
	return { tp, fp: got.length - tp, fn: want.length - tp }
}

export function scoreIR(ir: DiagramIR, golden: { nodes: string[]; edges: string[]; kind?: string }): Score {
	const gotNodes = ir.nodes.map((n) => norm(n.label ?? n.key))
	const nodes = multisetMatch(gotNodes, golden.nodes.map(norm))
	const want = golden.edges.map(parseGoldenEdge)
	const got = irEdges(ir)
	const edges = multisetMatch(
		got.map((e) => e.key),
		want.map((e) => e.key),
	)
	let ok = 0
	let total = 0
	const remaining = [...got]
	for (const w of want) {
		const i = remaining.findIndex((g) => g.key === w.key)
		if (i < 0) continue
		const g = remaining.splice(i, 1)[0]
		if (!w.label) continue
		total++
		if (g.label && norm(g.label) === norm(w.label)) ok++
	}
	return { nodes, edges, labels: { ok, total }, kindOk: !golden.kind || golden.kind === ir.kind }
}

export const precision = (c: { tp: number; fp: number }) => (c.tp + c.fp ? c.tp / (c.tp + c.fp) : 1)
export const recall = (c: { tp: number; fn: number }) => (c.tp + c.fn ? c.tp / (c.tp + c.fn) : 1)

/** Markdown table of per-fixture and micro-averaged scores. */
export function scoreTable(rows: [string, Score][]): { table: string; total: Score } {
	const total: Score = { nodes: { tp: 0, fp: 0, fn: 0 }, edges: { tp: 0, fp: 0, fn: 0 }, labels: { ok: 0, total: 0 }, kindOk: true }
	const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4)
	const lines = ['| fixture | node P | node R | edge P | edge R | labels |', '|---|---|---|---|---|---|']
	for (const [name, s] of rows) {
		for (const k of ['nodes', 'edges'] as const) {
			total[k].tp += s[k].tp
			total[k].fp += s[k].fp
			total[k].fn += s[k].fn
		}
		total.labels.ok += s.labels.ok
		total.labels.total += s.labels.total
		total.kindOk &&= s.kindOk
		lines.push(
			`| ${name}${s.kindOk ? '' : ' (kind!)'} | ${pct(precision(s.nodes))} | ${pct(recall(s.nodes))} | ${pct(precision(s.edges))} | ${pct(recall(s.edges))} | ${s.labels.ok}/${s.labels.total} |`,
		)
	}
	lines.push(
		`| **all (${rows.length})** | ${pct(precision(total.nodes))} | ${pct(recall(total.nodes))} | ${pct(precision(total.edges))} | ${pct(recall(total.edges))} | ${total.labels.ok}/${total.labels.total} |`,
	)
	return { table: lines.join('\n'), total }
}
