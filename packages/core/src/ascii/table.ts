/**
 * Markdown tables of entity attributes, as chat models describe a schema:
 *
 *   ### users
 *   | Field   | Type    | Notes            |
 *   |---------|---------|------------------|
 *   | id      | uuid    | PK               |
 *   | team_id | uuid    | FK → teams.id    |
 *
 * Every table whose header has a type column becomes an ERD entity (named by
 * the heading or bold line above it). Foreign keys come from explicit
 * references (`FK → teams.id`, `references teams(id)`) or, failing that, from
 * `<entity>_id` / `<entity>Id` field names. Returns null for other tables.
 */
import { emptyIR, type DiagramIR, type IREdge, type IRField, type IRNode } from '../ir'

const ROW = /^\s*\|.*\|\s*$/
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/
const NAME_COL = /^(field|fields|column|columns|col|name|attribute|attributes|attr|property|column name|field name|key)$/i
const TYPE_COL = /^(type|types|data ?type|datatype|sql type|db type|kind)$/i

interface Table {
	title?: string
	header: string[]
	rows: string[][]
	line: number
}

function cells(line: string): string[] {
	const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
	return t.split(/(?<!\\)\|/).map((c) => c.trim())
}

const unmark = (s: string) =>
	s
		.replace(/\*\*|__|`/g, '')
		.replace(/<\/?[a-z]+>/gi, '')
		.trim()

function titleOf(line: string | undefined): string | undefined {
	if (!line) return undefined
	const tick = /`([^`]+)`/.exec(line)
	let t = line
		.replace(/^\s*#{1,6}\s*/, '')
		.replace(/^\s*[-*]\s+/, '')
		.replace(/^\s*\d+[.)]\s+/, '')
	t = unmark(t)
		.replace(/^(table|entity|model|collection)\s*[:\-–]\s*/i, '')
		.replace(/\s*[:：]\s*$/, '')
		.replace(/\s+(table|entity|model)$/i, '')
		.replace(/\s*\(.*\)\s*$/, '')
		.trim()
	if (tick && (t.length > 40 || /\s/.test(t))) return tick[1].trim()
	if (!t || t.length > 40 || /[.!?]\s/.test(t)) return undefined
	return t
}

export function findTables(lines: string[]): Table[] {
	const out: Table[] = []
	for (let i = 0; i + 1 < lines.length; i++) {
		if (!ROW.test(lines[i]) || !SEP.test(lines[i + 1])) continue
		const header = cells(lines[i]).map(unmark)
		const rows: string[][] = []
		let j = i + 2
		for (; j < lines.length && ROW.test(lines[j]) && !SEP.test(lines[j]); j++) rows.push(cells(lines[j]))
		let k = i - 1
		while (k >= 0 && !lines[k].trim()) k--
		const title = k >= 0 && i - k <= 3 && !ROW.test(lines[k]) ? titleOf(lines[k]) : undefined
		out.push({ title, header, rows, line: i })
		i = j - 1
	}
	return out
}

/** True when the text holds at least one markdown table with a name and a type column. */
export function looksMarkdownErd(text: string): boolean {
	return findTables(text.split('\n')).some((t) => t.header.some((h) => TYPE_COL.test(h)) && t.rows.length > 0)
}

interface FkRef {
	entity: string
	field?: string
}

export function parseMarkdownErd(text: string): { ir: DiagramIR; confidence: number } | null {
	const lines = text.split('\n')
	const tables = findTables(lines).filter((t) => t.header.some((h) => TYPE_COL.test(h)) && t.rows.length)
	if (!tables.length) return null
	const ir = emptyIR('erd')
	const refs: { from: string; field: string; ref?: FkRef }[] = []
	const used = new Set<string>()
	let n = 0
	for (const t of tables) {
		n++
		let key = t.title ?? `Table ${n}`
		for (let k = 2; used.has(key); k++) key = `${t.title ?? 'Table'} ${k}`
		used.add(key)
		const nameIdx = Math.max(0, t.header.findIndex((h) => NAME_COL.test(h)))
		const typeIdx = t.header.findIndex((h) => TYPE_COL.test(h))
		const fields: IRField[] = []
		for (const row of t.rows) {
			const rawName = row[nameIdx] ?? ''
			const name = unmark(rawName)
				.replace(/\s*\((pk|fk|pk, fk)\)\s*$/i, '')
				.replace(/[🔑🗝️]/gu, '')
				.trim()
			if (!name) continue
			const type = unmark(row[typeIdx] ?? '').replace(/\s+/g, '_') || undefined
			const extra = row.filter((_, i) => i !== typeIdx).join(' | ')
			const meta: string[] = []
			if (/\bPK\b|primary\s*key|🔑/i.test(extra)) meta.push('pk')
			const fkText = /\bFK\b|foreign\s*key|references?\b|\brefs?\b|→|->/i.test(extra)
			if (fkText) meta.push('fk')
			if (/\bunique\b|\bUQ\b/i.test(extra)) meta.push('unique')
			const field: IRField = { name }
			if (type) field.type = type
			if (meta.length) field.meta = meta
			fields.push(field)
			if (fkText || /^[a-z][\w]*?(_id|Id|ID)$/.test(name)) refs.push({ from: key, field: name, ref: fkText ? parseRef(extra) : undefined })
		}
		const node: IRNode = { key, fields }
		ir.nodes.push(node)
	}
	const byLower = new Map(ir.nodes.map((nd) => [nd.key.toLowerCase(), nd]))
	const resolve = (name: string): IRNode | undefined => {
		const l = name.toLowerCase()
		for (const c of [l, `${l}s`, `${l}es`, l.replace(/y$/, 'ies'), l.replace(/s$/, ''), l.replace(/_/g, '')]) {
			const hit = byLower.get(c)
			if (hit) return hit
		}
		return undefined
	}
	const pairCount = new Map<string, number>()
	for (const r of refs) {
		const target = (r.ref && resolve(r.ref.entity)) || resolve(r.field.replace(/_?(id|Id|ID)$/, ''))
		if (!target || target.key === r.from) continue
		const toField =
			(r.ref?.field && target.fields?.some((f) => f.name === r.ref!.field) ? r.ref.field : undefined) ??
			target.fields?.find((f) => f.meta?.includes('pk'))?.name ??
			target.fields?.find((f) => f.name === 'id')?.name
		const pair = `${r.from}->${target.key}`
		const k = pairCount.get(pair) ?? 0
		pairCount.set(pair, k + 1)
		const e: IREdge = {
			key: `${pair}#${k}`,
			from: r.from,
			to: target.key,
			arrow: { start: 'none', end: 'none' },
			line: { dash: 'solid' },
			cardinality: 'n-1',
			fromField: r.field,
		}
		if (toField) e.toField = toField
		ir.edges.push(e)
		const f = ir.nodes.find((nd) => nd.key === r.from)?.fields?.find((x) => x.name === r.field)
		if (f && !f.meta?.includes('fk')) f.meta = [...(f.meta ?? []), 'fk']
	}
	const titled = tables.filter((t) => t.title).length / tables.length
	return { ir, confidence: Math.round((0.7 + 0.25 * titled) * 1000) / 1000 }
}

function parseRef(s: string): FkRef | undefined {
	const m =
		/(?:references?|refs?|→|->|FK\s*(?:to)?)\s*:?\s*`?([A-Za-z_][\w]*)`?\s*(?:\.\s*`?([A-Za-z_]\w*)`?|\(\s*`?([A-Za-z_]\w*)`?\s*\))?/i.exec(s) ??
		/`?([A-Za-z_][\w]*)`?\.`?([A-Za-z_]\w*)`?/.exec(s)
	if (!m) return undefined
	const entity = m[1]
	if (/^(fk|pk|key|foreign|to)$/i.test(entity)) return undefined
	return { entity, field: m[2] ?? m[3] }
}
