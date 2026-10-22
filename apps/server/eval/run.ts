/**
 * Prompt-quality harness. Runs eval/cases.json against the real Claude API and
 * scores each result with deterministic checks on the parsed diagram.
 *
 *   ANTHROPIC_API_KEY=... pnpm --dir apps/server exec tsx eval/run.ts [case-id-filter]
 *
 * Skips (exit 0) when ANTHROPIC_API_KEY is not set. Writes eval/results.json.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOcto, type DiagramIR, type IRNode } from '@octo-draw/core'
import { generate } from '../src/ai'
import { runAgentStream, type AgentMode } from '../src/agentStream'
import { createStreamFn, MODEL } from '../src/claude'

interface NodeExpect {
	match: string
	shape?: string
	color?: string
	icon?: string
	container?: boolean
	/** ERD: attribute names (regexes) the entity must have. */
	fields?: string[]
}
interface EdgeExpect {
	from: string
	to: string
	dash?: 'solid' | 'dotted'
}
interface Expect {
	/** flowchart | architecture | sequence | erd */
	diagramKind?: string
	minNodes?: number
	maxNodes?: number
	minGroups?: number
	direction?: string
	nodes?: NodeExpect[]
	edges?: EdgeExpect[]
	absentEdges?: EdgeExpect[]
	absentNodes?: string[]
	keepNodes?: string[]
	parentOf?: { child: string; parent: string }[]
	edgeCount?: number
	hasCycle?: boolean
	text?: string[]
	unchanged?: boolean
	maxWords?: number
}
interface Case {
	id: string
	kind: 'generate' | 'agent' | 'explain'
	prompt: string
	code?: string
	selection?: string[]
	expect: Expect
}

const here = dirname(fileURLToPath(import.meta.url))

export function toRegex(s: string): RegExp {
	const m = /^\/(.*)\/([a-z]*)$/s.exec(s)
	return m ? new RegExp(m[1], m[2]) : new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
}

const nodeMatches = (n: IRNode, re: RegExp) => re.test(n.key) || (!!n.label && re.test(n.label))

function hasCycle(ir: DiagramIR): boolean {
	const out = new Map<string, string[]>()
	for (const e of ir.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
	const state = new Map<string, number>()
	const visit = (k: string): boolean => {
		state.set(k, 1)
		for (const t of out.get(k) ?? []) {
			if (state.get(t) === 1) return true
			if (!state.get(t) && visit(t)) return true
		}
		state.set(k, 2)
		return false
	}
	return ir.nodes.some((n) => !state.get(n.key) && visit(n.key))
}

/** Deterministic checks; returns the list of failures (empty = pass). */
export function check(expect: Expect, code: string, original: string, text: string): string[] {
	const fails: string[] = []
	const { ir, diagnostics } = parseOcto(code)
	const errors = diagnostics.filter((d) => d.severity === 'error')
	if (errors.length) fails.push(`parse errors: ${errors.map((d) => d.message).join('; ')}`)
	const leaves = ir.nodes.filter((n) => !n.isContainer)
	const groups = ir.nodes.filter((n) => n.isContainer)
	const find = (pattern: string) => ir.nodes.filter((n) => nodeMatches(n, toRegex(pattern)))
	const edgeExists = (e: EdgeExpect) => {
		const froms = new Set(find(e.from).map((n) => n.key))
		const tos = new Set(find(e.to).map((n) => n.key))
		return ir.edges.some((x) => {
			const fwd = froms.has(x.from) && tos.has(x.to)
			const rev = froms.has(x.to) && tos.has(x.from) && x.arrow.start === 'arrow'
			return (fwd || rev) && (!e.dash || x.line.dash === e.dash)
		})
	}

	if (expect.minNodes !== undefined && leaves.length < expect.minNodes) fails.push(`expected >= ${expect.minNodes} nodes, got ${leaves.length}`)
	if (expect.maxNodes !== undefined && leaves.length > expect.maxNodes) fails.push(`expected <= ${expect.maxNodes} nodes, got ${leaves.length}`)
	if (expect.minGroups !== undefined && groups.length < expect.minGroups) fails.push(`expected >= ${expect.minGroups} groups, got ${groups.length}`)
	if (expect.diagramKind && ir.kind !== expect.diagramKind) fails.push(`diagram kind ${ir.kind}, expected ${expect.diagramKind}`)
	if (expect.direction && ir.direction !== expect.direction) fails.push(`direction ${ir.direction}, expected ${expect.direction}`)
	if (expect.edgeCount !== undefined && ir.edges.length !== expect.edgeCount) fails.push(`expected ${expect.edgeCount} edges, got ${ir.edges.length}`)
	for (const n of expect.nodes ?? []) {
		const hits = find(n.match).filter(
			(x) =>
				(!n.shape || x.shape === n.shape) &&
				(!n.color || toRegex(n.color).test(x.style?.color ?? '')) &&
				(!n.icon || toRegex(n.icon).test(x.icon ?? '')) &&
				(n.container === undefined || !!x.isContainer === n.container) &&
				(n.fields ?? []).every((f) => (x.fields ?? []).some((fx) => toRegex(f).test(fx.name))),
		)
		if (!hits.length) fails.push(`no node matching ${JSON.stringify(n)}`)
	}
	for (const e of expect.edges ?? []) if (!edgeExists(e)) fails.push(`missing edge ${e.from} -> ${e.to}${e.dash ? ` (${e.dash})` : ''}`)
	for (const e of expect.absentEdges ?? []) if (edgeExists(e)) fails.push(`edge ${e.from} -> ${e.to} should be gone`)
	for (const p of expect.absentNodes ?? []) if (find(p).length) fails.push(`node ${p} should be gone`)
	for (const k of expect.keepNodes ?? []) if (!ir.nodes.some((n) => n.key === k)) fails.push(`lost node ${k}`)
	for (const r of expect.parentOf ?? []) {
		const parents = new Set(find(r.parent).map((n) => n.key))
		const child = find(r.child)
		if (!child.length || !child.every((c) => c.parent && parents.has(c.parent))) fails.push(`${r.child} not inside ${r.parent}`)
	}
	if (expect.hasCycle && !hasCycle(ir)) fails.push('expected a cycle (retry path)')
	for (const t of expect.text ?? []) if (!toRegex(t).test(text)) fails.push(`answer does not mention ${t}`)
	if (expect.unchanged && code !== original) fails.push('diagram changed but should not have')
	if (expect.maxWords !== undefined) {
		const words = text.split(/\s+/).filter(Boolean).length
		if (words > expect.maxWords) fails.push(`answer has ${words} words (> ${expect.maxWords})`)
	}
	return fails
}

async function main() {
	if (!process.env.ANTHROPIC_API_KEY) {
		console.log('[eval] ANTHROPIC_API_KEY is not set: skipping (this harness calls the real API).')
		return
	}
	const filter = process.argv[2]
	const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')) as { cases: Case[] }
	const selected = cases.filter((c) => !filter || c.id.includes(filter))
	const stream = createStreamFn()
	const results: { id: string; pass: boolean; fails: string[]; ms: number; actions?: number; code: string; text: string }[] = []
	console.log(`[eval] ${selected.length} cases against ${MODEL}`)

	for (const c of selected) {
		const t0 = Date.now()
		const original = c.code ?? ''
		let code = original
		let text = ''
		let actions: number | undefined
		let fails: string[]
		try {
			if (c.kind === 'generate') {
				code = await generate(stream, { prompt: c.prompt, code: c.code }, () => {})
			} else {
				const mode: AgentMode | undefined = c.kind === 'explain' ? 'explain' : undefined
				const r = await runAgentStream(stream, { prompt: c.prompt, code: original, selection: c.selection, mode }, () => {})
				code = r.code
				text = r.message
				actions = r.actions.length
			}
			fails = check(c.expect, code, original, text)
		} catch (err) {
			fails = [`threw: ${err instanceof Error ? err.message : String(err)}`]
		}
		const ms = Date.now() - t0
		results.push({ id: c.id, pass: fails.length === 0, fails, ms, actions, code, text })
		console.log(`${fails.length ? 'FAIL' : 'pass'}  ${c.id}  (${(ms / 1000).toFixed(1)}s${actions !== undefined ? `, ${actions} actions` : ''})`)
		for (const f of fails) console.log(`      - ${f}`)
	}

	const passed = results.filter((r) => r.pass).length
	console.log(`\n[eval] ${passed}/${results.length} passed`)
	writeFileSync(join(here, 'results.json'), JSON.stringify({ model: MODEL, at: new Date().toISOString(), passed, total: results.length, results }, null, '\t'))
	if (passed < results.length) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main()
