/**
 * mermaid `erDiagram` ↔ DiagramIR (kind 'erd'). Hand-written, never throws.
 */
import { emptyIR, type Cardinality, type DiagramIR, type Diagnostic, type IREdge, type IRField, type IRNode, type ParseResult } from '../ir'
import { cleanLabel } from './parse'
import { mermaidLines, type Line } from './sequence'

const DIRS: Record<string, DiagramIR['direction']> = { TB: 'down', TD: 'down', BT: 'up', LR: 'right', RL: 'left' }

const NAME = String.raw`("[^"]+"|[A-Za-z_][\w-]*)(?:\[\s*"?([^"\]]*)"?\s*\])?`
const REL_RE = new RegExp(String.raw`^${NAME}\s*([|}][o|])(--|\.\.|\.-|-\.)([o|][|{])\s*${NAME}\s*(?::\s*(.*))?$`)
const ENTITY_RE = new RegExp(String.raw`^${NAME}\s*\{\s*(\}?)\s*$`)

const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s)

export function parseMermaidErd(src: string, title?: string): ParseResult {
	const ir = emptyIR('erd')
	if (title) ir.title = title
	const diagnostics: Diagnostic[] = []
	const nodes = new Map<string, IRNode>()
	const pairCount = new Map<string, number>()
	const span = (l: Line) => ({ from: l.from, to: l.from + l.text.length, line: l.line })
	const touch = (raw: string, alias: string | undefined, l: Line): IRNode => {
		const key = unquote(raw)
		let n = nodes.get(key)
		if (!n) {
			n = { key, span: span(l) }
			nodes.set(key, n)
			ir.nodes.push(n)
		}
		if (alias && alias !== key) n.label = cleanLabel(alias)
		return n
	}
	const lines = mermaidLines(src)
	let entity: IRNode | null = null
	let m: RegExpExecArray | null
	for (let i = 1; i < lines.length; i++) {
		const l = lines[i]
		const t = l.text
		const end = l.from + t.length
		if (entity) {
			if (t === '}') {
				entity = null
				continue
			}
			// type name [PK, FK] ["comment"]
			const am = /^([\w[\]()*.-]+)\s+([\w[\]()*.-]+)\s*((?:\s*(?:PK|FK|UK)\s*,?)*)\s*(?:"([^"]*)")?\s*$/i.exec(t)
			if (!am) {
				diagnostics.push({ from: l.from, to: end, severity: 'error', message: `Could not parse attribute '${t}'` })
				continue
			}
			const f: IRField = { name: am[2], type: am[1] }
			const keys = am[3].split(/[\s,]+/).filter(Boolean).map((k) => k.toLowerCase())
			if (keys.length) f.meta = keys
			entity.fields!.push(f)
			continue
		}
		if ((m = /^direction\s+(TB|TD|BT|LR|RL)$/i.exec(t))) {
			ir.direction = DIRS[m[1].toUpperCase()]
			continue
		}
		if ((m = /^title\s*:?\s*(.*)$/.exec(t))) {
			ir.title = cleanLabel(m[1])
			continue
		}
		if (/^(accTitle|accDescr|style|classDef|class)\b/.test(t)) continue
		if ((m = ENTITY_RE.exec(t))) {
			const n = touch(m[1], m[2], l)
			n.fields ??= []
			if (!m[3]) entity = n
			continue
		}
		if ((m = REL_RE.exec(t))) {
			const a = touch(m[1], m[2], l)
			const b = touch(m[6], m[7], l)
			const left = m[3].includes('}') ? 'n' : '1'
			const right = m[5].includes('{') ? 'n' : '1'
			const pair = `${a.key}->${b.key}`
			const k = pairCount.get(pair) ?? 0
			pairCount.set(pair, k + 1)
			const edge: IREdge = {
				key: `${pair}#${k}`,
				from: a.key,
				to: b.key,
				arrow: { start: 'none', end: 'none' },
				line: { dash: m[4] === '--' ? 'solid' : 'dotted' },
				cardinality: `${left}-${right}` as Cardinality,
				span: span(l),
			}
			const label = m[8] !== undefined ? cleanLabel(m[8]) : ''
			if (label) edge.label = label
			ir.edges.push(edge)
			continue
		}
		if ((m = /^("[^"]+"|[A-Za-z_][\w-]*)$/.exec(t))) {
			touch(m[1], undefined, l)
			continue
		}
		diagnostics.push({ from: l.from, to: end, severity: 'error', message: `Could not parse erDiagram statement '${t}'` })
	}
	if (entity) diagnostics.push({ from: src.length, to: src.length, severity: 'error', message: `Unclosed '{' for entity '${entity.key}'` })
	return { ir, diagnostics }
}

// ---------------------------------------------------------------------------

const CARD: Record<Cardinality, [string, string]> = { '1-1': ['||', '||'], '1-n': ['||', 'o{'], 'n-1': ['}o', '||'], 'n-n': ['}o', 'o{'] }
const word = (s: string, fallback: string) => s.replace(/[^\w[\]()-]+/g, '_').replace(/^_+|_+$/g, '') || fallback

export function erdToMermaid(ir: DiagramIR): string {
	const ids = new Map<string, string>()
	const used = new Set<string>()
	const idFor = (key: string) => {
		const hit = ids.get(key)
		if (hit) return hit
		let base = key.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[_-]+|[_-]+$/g, '') || 'entity'
		if (!/^[A-Za-z_]/.test(base)) base = `e_${base}`
		let id = base
		for (let n = 2; used.has(id); n++) id = `${base}_${n}`
		used.add(id)
		ids.set(key, id)
		return id
	}
	const lines = ['erDiagram']
	if (ir.title) lines.push(`\ttitle ${ir.title.replace(/\r?\n/g, ' ')}`)
	const mermaidDir: Record<string, string> = { down: 'TB', up: 'BT', right: 'LR', left: 'RL' }
	if (ir.direction !== 'right') lines.push(`\tdirection ${mermaidDir[ir.direction]}`)
	for (const n of ir.nodes) {
		const id = idFor(n.key)
		const label = n.label ?? n.key
		const head = label !== id ? `${id}["${label.replace(/"/g, "'")}"]` : id
		const fields = n.fields ?? []
		if (!fields.length) {
			lines.push(`\t${head}`)
			continue
		}
		lines.push(`\t${head} {`)
		for (const f of fields) {
			const keys = (f.meta ?? [])
				.map((k) => (k === 'unique' ? 'uk' : k))
				.filter((k) => k === 'pk' || k === 'fk' || k === 'uk')
				.map((k) => k.toUpperCase())
			lines.push(`\t\t${word(f.type ?? 'string', 'string')} ${word(f.name, 'field')}${keys.length ? ' ' + [...new Set(keys)].join(', ') : ''}`)
		}
		lines.push('\t}')
	}
	for (const e of ir.edges) {
		const [l, r] = CARD[e.cardinality ?? '1-1'] ?? CARD['1-1']
		const line = e.line.dash === 'dotted' ? '..' : '--'
		lines.push(`\t${idFor(e.from)} ${l}${line}${r} ${idFor(e.to)} : "${(e.label ?? '').replace(/"/g, "'")}"`)
	}
	return lines.join('\n') + '\n'
}
