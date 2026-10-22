/**
 * ERD statements for the octo DSL (Eraser syntax), driven by the main
 * `Parser` once an `erd` header switched the grammar:
 *
 *   users [icon: user, color: blue] {
 *     id string pk
 *     teamId string fk
 *   }
 *   users.teamId > teams.id        // many-to-one
 *   notation crows-feet            // or chen
 *
 * Operators carry cardinality: `<` one-to-many, `>` many-to-one, `-` one-to-one,
 * `<>` many-to-many (`--` / `-->` are dotted one-to-one / many-to-one).
 * Unknown entities and attributes are created on first use. Never throws.
 */
import type { Cardinality, IREdge, IRField, IRNode } from '../ir'
import type { DeclItem, Parser, Token } from './parse'
import { restOfLine } from './sequence'

export const ERD_KEYWORDS = ['notation'] as const
export const ERD_NOTATIONS = ['crows-feet', 'chen'] as const

export const OP_CARDINALITY: Record<string, { cardinality: Cardinality; dash: 'solid' | 'dotted' }> = {
	'<': { cardinality: '1-n', dash: 'solid' },
	'>': { cardinality: 'n-1', dash: 'solid' },
	'-': { cardinality: '1-1', dash: 'solid' },
	'<>': { cardinality: 'n-n', dash: 'solid' },
	'--': { cardinality: '1-1', dash: 'dotted' },
	'-->': { cardinality: 'n-1', dash: 'dotted' },
}

function upsertField(n: IRNode, f: IRField): IRField {
	n.fields ??= []
	const hit = n.fields.find((x) => x.name === f.name)
	if (!hit) {
		n.fields.push(f)
		return f
	}
	if (f.type !== undefined) hit.type = f.type
	if (f.meta?.length) hit.meta = [...new Set([...(hit.meta ?? []), ...f.meta])]
	return hit
}

export function parseErdStatement(p: Parser): void {
	const t = p.peek()
	const rest = restOfLine(p)
	if (t.type === 'word' && t.value === 'notation' && !rest.some((x) => x.type === 'op' || x.type === '{')) {
		p.next()
		const vals: Token[] = []
		while (!p.atEnd()) vals.push(p.next())
		const v = p.textOf(vals)
		if (v === 'crows-feet' || v === 'chen') p.notation = v
		else if (v === 'crowsfeet' || v === 'crows-foot' || v === 'crowsfoot') p.notation = 'crows-feet'
		else p.err(vals[0]?.from ?? t.from, p.lastTo, `Unknown notation "${v}" (expected crows-feet, chen)`, 'warning')
		p.statements.push({ kind: 'directive', name: 'notation', from: t.from, to: p.lastTo, valueFrom: vals[0]?.from ?? t.to, valueTo: p.lastTo })
		return
	}

	const start = p.peek()
	const segments: DeclItem[][] = []
	const ops: Token[] = []
	for (;;) {
		const list: DeclItem[] = []
		for (;;) {
			const item = p.parseItem()
			if (!item) break
			list.push(item)
			if (p.peek().type !== ',') break
			p.next()
		}
		if (!list.length) {
			const u = p.peek()
			if (ops.length) p.err(ops[ops.length - 1].from, ops[ops.length - 1].to, `Expected an entity after "${ops[ops.length - 1].value}"`)
			else p.err(u.from, u.to, `Unexpected "${u.value}"`)
			p.next()
			p.skipLine()
			return
		}
		segments.push(list)
		if (p.peek().type === 'op') {
			ops.push(p.next())
			continue
		}
		break
	}

	if (ops.length === 0) {
		const items = segments[0]
		for (const item of items) p.declare(item, undefined, true)
		p.statements.push({ kind: 'decl', items, from: items[0].from, to: items[items.length - 1].to })
		if (p.peek().type === '{') {
			if (items.length > 1) p.err(p.peek().from, p.peek().to, 'An entity body needs exactly one name before "{"')
			parseEntityBody(p, p.nodes.get(items[items.length - 1].key)!)
			return
		}
		if (p.peek().type === ':') p.err(p.peek().from, p.peek().to, 'Labels (":") are only allowed on relationships')
		if (!p.atEnd()) {
			const u = p.peek()
			p.err(u.from, u.to, `Unexpected "${u.value}"`)
			p.skipLine()
		}
		return
	}
	parseRelationship(p, start.from, segments, ops)
}

function parseEntityBody(p: Parser, node: IRNode) {
	const open = p.next()
	node.fields ??= []
	for (;;) {
		const t = p.peek()
		if (t.type === 'nl') {
			p.next()
			continue
		}
		if (t.type === 'eof') {
			p.err(open.from, open.to, `Unclosed "{" for entity "${node.key}"`)
			return
		}
		if (t.type === '}') {
			p.next()
			return
		}
		const words: Token[] = []
		while (!p.atEnd()) {
			const u = p.peek()
			if (u.type === 'word' || u.type === 'string') words.push(p.next())
			else if (u.type === '[') {
				const props = p.parseProps()
				p.err(props.from, props.to, 'Attribute properties are not supported (use "name type pk fk")', 'warning')
			} else if (u.type === ':' || u.type === ',') p.next()
			else {
				p.err(u.from, u.to, `Unexpected "${u.value}" in entity "${node.key}"`)
				p.next()
			}
		}
		if (!words.length) continue
		const f: IRField = { name: words[0].value }
		if (words[1]) f.type = words[1].value
		if (words.length > 2) f.meta = words.slice(2).map((w) => w.value.toLowerCase())
		if (node.fields.some((x) => x.name === f.name && x.type !== undefined)) p.err(words[0].from, words[0].to, `Duplicate attribute "${f.name}"`, 'warning')
		upsertField(node, f)
	}
}

/** `users.teamId` → entity + field; a known entity name wins over splitting on the dot. */
function resolveEnd(p: Parser, key: string): { entity: string; field?: string } {
	if (p.nodes.has(key)) return { entity: key }
	const dot = key.lastIndexOf('.')
	if (dot > 0 && dot < key.length - 1) {
		const entity = key.slice(0, dot).trim()
		const field = key.slice(dot + 1).trim()
		if (entity && field) return { entity, field }
	}
	return { entity: key }
}

function parseRelationship(p: Parser, from: number, segments: DeclItem[][], ops: Token[]) {
	let label: string | undefined
	let id: string | undefined
	let color: string | undefined
	if (p.peek().type === ':') {
		p.next()
		const toks: Token[] = []
		while (!p.atEnd() && p.peek().type !== '[') toks.push(p.next())
		const text = p.textOf(toks)
		if (text !== '') label = text
	}
	const last = segments[segments.length - 1]
	const lastItem = last[last.length - 1]
	let props = p.peek().type === '[' ? p.parseProps() : undefined
	if (!props && lastItem.props && label === undefined) {
		props = lastItem.props
		lastItem.props = undefined
		lastItem.to = lastItem.nameTo
	}
	for (const e of props?.entries ?? []) {
		if (e.key === 'id') id = e.value
		else if (e.key === 'color') color = e.value
		else if (e.key === 'label') label = e.value
		else p.err(e.from, e.to, `Unknown relationship property "${e.key}"`, 'warning')
	}
	if (!p.atEnd()) {
		const u = p.peek()
		p.err(u.from, u.to, `Unexpected "${u.value}"`)
		p.skipLine()
	}
	const to = p.lastTo
	const span = p.span(from, to)
	const ends = segments.map((seg) =>
		seg.map((item) => {
			const r = resolveEnd(p, item.key)
			const n = p.ensure(r.entity)
			if (item.props) p.declare({ ...item, key: r.entity }, undefined, true)
			if (r.field) upsertField(n, { name: r.field })
			return r
		}),
	)
	const stmtEdges: { edge: IREdge; explicitId: boolean }[] = []
	let ordinal = 0
	for (let i = 0; i < ops.length; i++) {
		const style = OP_CARDINALITY[ops[i].value] ?? OP_CARDINALITY['-']
		for (const a of ends[i]) {
			for (const b of ends[i + 1]) {
				const edge: IREdge = {
					key: '',
					from: a.entity,
					to: b.entity,
					arrow: { start: 'none', end: 'none' },
					line: { dash: style.dash },
					cardinality: style.cardinality,
					span: { ...span },
				}
				if (a.field) edge.fromField = a.field
				if (b.field) edge.toField = b.field
				if (label !== undefined) edge.label = label
				if (color !== undefined) edge.style = { color }
				if (id !== undefined) {
					edge.key = ordinal === 0 ? id : `${id}#${ordinal}`
					if (p.ids.has(edge.key)) p.err(from, to, `Duplicate relationship id "${edge.key}"`, 'warning')
				} else {
					const pair = `${a.entity}->${b.entity}`
					const n = p.pairCount.get(pair) ?? 0
					p.pairCount.set(pair, n + 1)
					edge.key = `${pair}#${n}`
				}
				p.ids.add(edge.key)
				ordinal++
				p.edges.push(edge)
				stmtEdges.push({ edge, explicitId: id !== undefined })
			}
		}
	}
	p.statements.push({ kind: 'connection', items: segments.flat(), edges: stmtEdges, from, to })
}
