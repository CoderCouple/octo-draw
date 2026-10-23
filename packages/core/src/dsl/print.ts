/**
 * Canonical, deterministic octo DSL formatter.
 * `parseOcto(printOcto(ir))` reproduces `ir` (modulo spans and node order of
 * implicit nodes).
 */

import type { ArrowHead, DiagramIR, IREdge, IRField, IRNode, SeqEvent } from '../ir'
import { DIRECTIVES, KIND_HEADERS, OPS, type EdgeOp } from './parse'

const NAME_SPECIAL = /[[\]{},:"\n\r]/

function oneLine(s: string): string {
	return s.replace(/\r?\n/g, ' ')
}

function quote(s: string): string {
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Would this text be split, eaten as a comment, or otherwise mangled if written bare? */
function looksLikeComment(s: string): boolean {
	return /(^|\s)\/\//.test(s) || /(^|\s)#(\s|$)/.test(s) || /^#/.test(s)
}

export function quoteName(name: string): string {
	name = oneLine(name)
	if (
		name === '' ||
		NAME_SPECIAL.test(name) ||
		/^\s|\s$|\s\s|[\t\f\v]/.test(name) ||
		looksLikeComment(name)
	)
		return quote(name)
	const parts = name.split(' ')
	if (parts.some((p) => (OPS as readonly string[]).includes(p))) return quote(name)
	if ((DIRECTIVES as readonly string[]).includes(parts[0])) return quote(name)
	if (parts.length === 1 && KIND_HEADERS[name]) return quote(name)
	// `page X` alone on a line would start a new page.
	if (parts[0] === 'page' && parts.length > 1) return quote(name)
	return name
}

/** Quote a property value when it contains whitespace or characters the props syntax uses. */
export function quoteValue(value: string): string {
	value = oneLine(value)
	if (value === '' || /[\s,[\]{}"]/.test(value) || looksLikeComment(value)) return quote(value)
	return value
}

function quoteLabel(label: string): string {
	label = oneLine(label)
	if (/^\s|\s$/.test(label) || /[[\]{}"]/.test(label) || looksLikeComment(label)) return quote(label)
	return label
}

export function opFor(arrow: { start: ArrowHead; end: ArrowHead }, dash: 'solid' | 'dotted'): EdgeOp {
	const { start, end } = arrow
	if (dash === 'dotted') {
		if (start === 'none' && end === 'none') return '--'
		if (start === 'none' && end === 'arrow') return '-->'
	}
	if (start === 'arrow' && end === 'arrow') return '<>'
	if (start === 'arrow') return '<'
	if (end === 'arrow') return '>'
	return '-'
}

export type PropList = [string, string | undefined][]

export function printProps(props: PropList): string {
	if (props.length === 0) return ''
	return ` [${props.map(([k, v]) => (v === undefined ? k : `${k}: ${quoteValue(v)}`)).join(', ')}]`
}

export function printEdgeLine(
	from: string,
	op: EdgeOp,
	to: string,
	label?: string,
	props: PropList = [],
): string {
	let s = `${quoteName(from)} ${op} ${quoteName(to)}`
	if (label !== undefined && label !== '') s += `: ${quoteLabel(label)}`
	return s + printProps(props)
}

/** Print a single edge. `withId` controls whether its key is written as `id:`. */
export function printEdge(e: IREdge, withId: boolean): string {
	const props: PropList = []
	if (withId) props.push(['id', e.key])
	if (e.style?.color !== undefined) props.push(['color', e.style.color])
	if (e.style?.dash !== undefined) props.push(['dash', e.style.dash])
	return printEdgeLine(e.from, opFor(e.arrow, e.line.dash), e.to, e.label, props)
}

export function nodeProps(n: IRNode): PropList {
	const props: PropList = []
	if (n.shape !== undefined) props.push(['shape', n.shape])
	if (n.icon !== undefined) props.push(['icon', n.icon])
	if (n.style?.color !== undefined) props.push(['color', n.style.color])
	if (n.label !== undefined) props.push(['label', n.label])
	if (n.link !== undefined) props.push(['link', n.link])
	for (const [k, v] of Object.entries(n.ext ?? {})) {
		if (k === 'shape' && n.shape !== undefined) continue
		props.push([k, v === 'true' ? undefined : v])
	}
	return props
}

function printHeader(ir: DiagramIR): string[] {
	const out: string[] = []
	if (ir.kind !== 'flowchart') out.push(ir.kind)
	if (ir.title !== undefined) {
		const t = oneLine(ir.title)
		const bare = t !== '' && !/^\s|\s$|^"|[{}]/.test(t) && !looksLikeComment(t)
		out.push(`title ${bare ? t : quote(t)}`)
	}
	const defaultDir = ir.kind === 'architecture' || ir.kind === 'erd' ? 'right' : 'down'
	if (ir.direction !== defaultDir) out.push(`direction ${ir.direction}`)
	if (ir.style.colorMode) out.push(`colorMode ${ir.style.colorMode}`)
	if (ir.style.styleMode) out.push(`styleMode ${ir.style.styleMode}`)
	if (ir.style.typeface) out.push(`typeface ${ir.style.typeface}`)
	return out
}

function joinSections(sections: string[][]): string {
	const s = sections.filter((x) => x.length > 0).map((x) => x.join('\n'))
	return s.length ? s.join('\n\n') + '\n' : ''
}

export function printOcto(ir: DiagramIR): string {
	if (ir.kind === 'sequence') return printSequence(ir)
	if (ir.kind === 'erd') return printErd(ir)
	const out = printHeader(ir)

	// Tree of nodes.
	const byKey = new Map<string, IRNode>()
	for (const n of ir.nodes) if (!byKey.has(n.key)) byKey.set(n.key, n)
	const validParent = (n: IRNode): string | undefined => {
		if (n.parent === undefined || !byKey.has(n.parent) || n.parent === n.key) return undefined
		const seen = new Set<string>([n.key])
		let cur: string | undefined = n.parent
		while (cur !== undefined) {
			if (seen.has(cur)) return undefined
			seen.add(cur)
			cur = byKey.get(cur)?.parent
			if (cur !== undefined && !byKey.has(cur)) break
		}
		return n.parent
	}
	const children = new Map<string, IRNode[]>()
	const roots: IRNode[] = []
	for (const n of byKey.values()) {
		const p = validParent(n)
		if (p === undefined) roots.push(n)
		else {
			if (!children.has(p)) children.set(p, [])
			children.get(p)!.push(n)
		}
	}
	const referenced = new Set<string>()
	for (const e of ir.edges) {
		referenced.add(e.from)
		referenced.add(e.to)
	}

	const body: string[] = []
	const printed = new Set<string>()
	const printNode = (n: IRNode, indent: string, nested: boolean) => {
		if (printed.has(n.key)) return
		printed.add(n.key)
		const props = nodeProps(n)
		const kids = children.get(n.key) ?? []
		const head = `${indent}${quoteName(n.key)}${printProps(props)}`
		if (n.isContainer || kids.length > 0) {
			body.push(`${head} {`)
			for (const k of kids) printNode(k, indent + '\t', true)
			body.push(`${indent}}`)
		} else if (nested || props.length > 0 || !referenced.has(n.key)) {
			body.push(head)
		}
	}
	for (const n of roots) printNode(n, '', false)
	for (const n of byKey.values()) printNode(n, '', false)

	const edgeLines: string[] = []
	const pairCount = new Map<string, number>()
	for (const e of ir.edges) {
		const pair = `${e.from}->${e.to}`
		const n = pairCount.get(pair) ?? 0
		const derived = e.key === `${pair}#${n}`
		if (derived) pairCount.set(pair, n + 1)
		edgeLines.push(printEdge(e, !derived))
	}

	const sections = [out, body, edgeLines].filter((s) => s.length > 0).map((s) => s.join('\n'))
	return sections.length ? sections.join('\n\n') + '\n' : ''
}

// ---------------------------------------------------------------------------
// Sequence

/** Free text after `:` (message labels, note text). */
function quoteText(text: string): string {
	text = oneLine(text)
	if (/^\s|\s$/.test(text) || /[[\]{}"]/.test(text) || looksLikeComment(text)) return quote(text)
	return text
}

/** Participant names that a sequence keyword would swallow get quoted. */
function seqName(name: string): string {
	const q = quoteName(name)
	if (q.startsWith('"')) return q
	const first = name.split(' ')[0]
	if (['activate', 'deactivate', 'note', 'autoNumber', 'loop', 'alt', 'opt', 'par', 'break', 'critical', 'else', 'and', 'option'].includes(first)) return quote(name)
	return q
}

function printSeqEvents(events: SeqEvent[], indent: string, out: string[]) {
	for (const ev of events) {
		switch (ev.kind) {
			case 'message': {
				let s = `${indent}${seqName(ev.from)} ${opFor(ev.arrow, ev.dash)} ${seqName(ev.to)}`
				const props: PropList = []
				if (ev.color !== undefined) props.push(['color', ev.color])
				if (ev.label !== undefined && ev.label !== '') s += `: ${quoteText(ev.label)}`
				else if (props.length) s += ':'
				out.push(s + printProps(props))
				break
			}
			case 'activate':
			case 'deactivate':
				out.push(`${indent}${ev.kind} ${seqName(ev.target)}`)
				break
			case 'note': {
				const where = ev.placement === 'over' ? 'over' : `${ev.placement} of`
				const props: PropList = ev.color !== undefined ? [['color', ev.color]] : []
				out.push(`${indent}note ${where} ${ev.targets.map(seqName).join(', ')}: ${quoteText(ev.text)}${printProps(props)}`)
				break
			}
			case 'block': {
				const cont = ev.type === 'par' ? 'and' : ev.type === 'critical' ? 'option' : 'else'
				const sections = ev.sections.length ? ev.sections : [{ events: [] }]
				sections.forEach((sec, i) => {
					const props: PropList = []
					if (sec.label !== undefined) props.push(['label', sec.label])
					if (i === 0 && ev.color !== undefined) props.push(['color', ev.color])
					if (i === 0 && ev.icon !== undefined) props.push(['icon', ev.icon])
					const kw = i === 0 ? ev.type : cont
					out.push(`${indent}${i === 0 ? '' : '} '}${kw}${printProps(props)} {`)
					printSeqEvents(sec.events, indent + '\t', out)
				})
				out.push(`${indent}}`)
				break
			}
		}
	}
}

export function printSequence(ir: DiagramIR): string {
	const head = printHeader(ir)
	const seq = ir.sequence ?? { events: [] }
	if (seq.autoNumber !== undefined) head.push(`autoNumber ${seq.autoNumber ? 'on' : 'off'}`)
	// every participant is declared up front: that fixes the column order
	const decls = ir.nodes.map((n) => `${seqName(n.key)}${printProps(nodeProps(n))}`)
	const events: string[] = []
	printSeqEvents(seq.events, '', events)
	return joinSections([head, decls, events])
}

// ---------------------------------------------------------------------------
// ERD

const CARD_OP: Record<string, EdgeOp> = { '1-n': '<', 'n-1': '>', '1-1': '-', 'n-n': '<>' }

function printField(f: IRField): string {
	const word = (s: string) => (s === '' || /[\s[\]{},:"]/.test(s) || looksLikeComment(s) ? quote(s) : s)
	const parts = [word(f.name)]
	if (f.type !== undefined) parts.push(word(f.type))
	else if (f.meta?.length) parts.push('""')
	for (const m of f.meta ?? []) parts.push(word(m))
	return parts.join(' ')
}

export function printErd(ir: DiagramIR): string {
	const head = printHeader(ir)
	if (ir.erd?.notation) head.push(`notation ${ir.erd.notation}`)
	// every entity is printed (in order), so entity order round-trips
	const body: string[] = []
	for (const n of ir.nodes) {
		const fields = n.fields ?? []
		const head1 = `${quoteName(n.key)}${printProps(nodeProps(n))}`
		if (fields.length) {
			body.push(`${head1} {`)
			for (const f of fields) body.push(`\t${printField(f)}`)
			body.push('}')
		} else body.push(head1)
	}
	const edges: string[] = []
	const pairCount = new Map<string, number>()
	for (const e of ir.edges) {
		const pair = `${e.from}->${e.to}`
		const n = pairCount.get(pair) ?? 0
		const derived = e.key === `${pair}#${n}`
		if (derived) pairCount.set(pair, n + 1)
		const card = e.cardinality ?? '1-1'
		let op = CARD_OP[card] ?? '-'
		const props: PropList = []
		if (e.line.dash === 'dotted') {
			if (card === '1-1') op = '--'
			else if (card === 'n-1') op = '-->'
		}
		if (!derived) props.push(['id', e.key])
		if (e.style?.color !== undefined) props.push(['color', e.style.color])
		const end = (entity: string, field?: string) => quoteName(entity) + (field !== undefined ? `.${field}` : '')
		let s = `${end(e.from, e.fromField)} ${op} ${end(e.to, e.toField)}`
		if (e.label !== undefined && e.label !== '') s += `: ${quoteText(e.label)}`
		edges.push(s + printProps(props))
	}
	return joinSections([head, body, edges])
}
