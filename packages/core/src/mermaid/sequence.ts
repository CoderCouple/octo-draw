/**
 * mermaid `sequenceDiagram` ↔ DiagramIR (kind 'sequence'). Hand-written,
 * no mermaid dependency, never throws.
 */
import {
	emptyIR,
	type ArrowHead,
	type DiagramIR,
	type Diagnostic,
	type IRNode,
	type ParseResult,
	type SeqBlock,
	type SeqBlockType,
	type SeqEvent,
	type SeqSection,
} from '../ir'
import { cleanLabel } from './parse'

export interface Line {
	text: string
	from: number
	line: number
}

/** Physical lines with `%%` comments removed, trimmed, offsets kept. */
export function mermaidLines(src: string): Line[] {
	const out: Line[] = []
	let start = 0
	let n = 1
	for (let i = 0; i <= src.length; i++) {
		if (i === src.length || src[i] === '\n') {
			let raw = src.slice(start, i)
			const c = raw.search(/(^|\s)%%/)
			if (c >= 0) raw = raw.slice(0, c)
			const t = raw.trim()
			if (t) out.push({ text: t.replace(/;$/, '').trim(), from: start + (raw.length - raw.trimStart().length), line: n })
			start = i + 1
			n++
		}
	}
	return out
}

const ARROWS: [string, { start: ArrowHead; end: ArrowHead; dash: 'solid' | 'dotted' }][] = [
	['<<-->>', { start: 'arrow', end: 'arrow', dash: 'dotted' }],
	['<<->>', { start: 'arrow', end: 'arrow', dash: 'solid' }],
	['-->>', { start: 'none', end: 'arrow', dash: 'dotted' }],
	['->>', { start: 'none', end: 'arrow', dash: 'solid' }],
	['--x', { start: 'none', end: 'arrow', dash: 'dotted' }],
	['-x', { start: 'none', end: 'arrow', dash: 'solid' }],
	['--)', { start: 'none', end: 'arrow', dash: 'dotted' }],
	['-)', { start: 'none', end: 'arrow', dash: 'solid' }],
	['-->', { start: 'none', end: 'none', dash: 'dotted' }],
	['->', { start: 'none', end: 'none', dash: 'solid' }],
]
const ARROW_RE = new RegExp(
	String.raw`^(.+?)\s*(${ARROWS.map(([a]) => a.replace(/[()|]/g, '\\$&')).join('|')})\s*([+-]?)\s*([^:]+?)\s*(?::(.*))?$`,
)

const BLOCK_KW: Record<string, SeqBlockType> = { loop: 'loop', alt: 'alt', opt: 'opt', par: 'par', critical: 'critical', break: 'break' }
const CONT_KW = new Set(['else', 'and', 'option'])

interface Frame {
	block?: SeqBlock
	events: SeqEvent[]
}

export function parseMermaidSequence(src: string, title?: string): ParseResult {
	const ir = emptyIR('sequence')
	if (title) ir.title = title
	const diagnostics: Diagnostic[] = []
	const events: SeqEvent[] = []
	ir.sequence = { events }
	const nodes = new Map<string, IRNode>()
	const span = (l: Line) => ({ from: l.from, to: l.from + l.text.length, line: l.line })
	const touch = (id: string, l: Line): IRNode => {
		const key = id.trim()
		let n = nodes.get(key)
		if (!n) {
			n = { key, span: span(l) }
			nodes.set(key, n)
			ir.nodes.push(n)
		}
		return n
	}
	const stack: Frame[] = [{ events }]
	const cur = () => stack[stack.length - 1].events
	const lines = mermaidLines(src)
	let m: RegExpExecArray | null
	for (let i = 1; i < lines.length; i++) {
		const l = lines[i]
		let t = l.text
		const end = l.from + t.length
		const kw = t.split(/\s+/)[0]
		const lower = kw.toLowerCase()
		if (lower === 'autonumber') {
			ir.sequence.autoNumber = true
			continue
		}
		if ((m = /^title\s*:?\s*(.*)$/.exec(t))) {
			ir.title = cleanLabel(m[1])
			continue
		}
		if (/^(accTitle|accDescr)\b/.test(t)) continue
		if (/^(create|destroy)\s+/.test(t)) {
			if (t.startsWith('destroy')) continue
			t = t.replace(/^create\s+/, '')
		}
		if ((m = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/.exec(t))) {
			const id = m[2].replace(/@\{[\s\S]*\}$/, '').trim()
			const n = touch(id, l)
			if (m[3]) {
				const label = cleanLabel(m[3])
				if (label !== n.key) n.label = label
			}
			const type = /@\{[^}]*["']?type["']?\s*:\s*["']?(\w+)/.exec(m[2])?.[1]
			if (m[1] === 'actor' || type === 'actor') n.icon = 'user'
			else if (type === 'database') n.icon = 'database'
			else if (type === 'queue') n.icon = 'list'
			continue
		}
		if ((m = /^(activate|deactivate)\s+(.+)$/.exec(t))) {
			cur().push({ kind: m[1] as 'activate' | 'deactivate', target: touch(m[2], l).key, span: span(l) })
			continue
		}
		if ((m = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i.exec(t))) {
			const where = m[1].toLowerCase()
			const targets = m[2].split(',').map((s) => touch(s, l).key)
			cur().push({ kind: 'note', placement: where === 'over' ? 'over' : where === 'left of' ? 'left' : 'right', targets, text: cleanLabel(m[3]), span: span(l) })
			continue
		}
		if (BLOCK_KW[kw]) {
			const label = cleanLabel(t.slice(kw.length))
			const section: SeqSection = { events: [] }
			if (label) section.label = label
			const block: SeqBlock = { kind: 'block', type: BLOCK_KW[kw], sections: [section], span: span(l) }
			cur().push(block)
			stack.push({ block, events: section.events })
			continue
		}
		if (kw === 'rect' || kw === 'box') {
			// visual grouping only: keep the contents inline
			stack.push({ events: cur() })
			continue
		}
		if (CONT_KW.has(kw)) {
			const top = stack[stack.length - 1]
			if (!top.block) {
				diagnostics.push({ from: l.from, to: end, severity: 'warning', message: `'${kw}' outside of a block` })
				continue
			}
			const label = cleanLabel(t.slice(kw.length))
			const section: SeqSection = { events: [] }
			if (label) section.label = label
			top.block.sections.push(section)
			top.events = section.events
			continue
		}
		if (kw === 'end') {
			if (stack.length > 1) {
				const top = stack.pop()!
				if (top.block?.span) top.block.span = { ...top.block.span, to: end }
			} else diagnostics.push({ from: l.from, to: end, severity: 'warning', message: "Unmatched 'end'" })
			continue
		}
		if ((m = ARROW_RE.exec(t))) {
			const style = ARROWS.find(([a]) => a === m![2])![1]
			const from = touch(m[1], l).key
			const to = touch(m[4], l).key
			const ev: SeqEvent = { kind: 'message', from, to, arrow: { start: style.start, end: style.end }, dash: style.dash, span: span(l) }
			const label = m[5] !== undefined ? cleanLabel(m[5]) : ''
			if (label) ev.label = label
			cur().push(ev)
			if (m[3] === '+') cur().push({ kind: 'activate', target: to, span: span(l) })
			if (m[3] === '-') cur().push({ kind: 'deactivate', target: from, span: span(l) })
			continue
		}
		diagnostics.push({ from: l.from, to: end, severity: 'error', message: `Could not parse sequence statement '${t}'` })
	}
	if (stack.length > 1) {
		const last = lines[lines.length - 1]
		diagnostics.push({ from: last.from, to: last.from + last.text.length, severity: 'warning', message: "Missing 'end' for a block" })
	}
	return { ir, diagnostics }
}

// ---------------------------------------------------------------------------

const RESERVED = new Set(['end', 'participant', 'actor', 'loop', 'alt', 'else', 'opt', 'par', 'and', 'critical', 'option', 'break', 'rect', 'note', 'activate', 'deactivate', 'autonumber', 'title', 'box', 'create', 'destroy'])

function esc(s: string): string {
	return s.replace(/\r?\n/g, '<br>').replace(/[#;]/g, (c) => (c === '#' ? '#35;' : '#59;'))
}

export function sequenceToMermaid(ir: DiagramIR): string {
	const ids = new Map<string, string>()
	const used = new Set<string>()
	const idFor = (key: string) => {
		const hit = ids.get(key)
		if (hit) return hit
		let base = key.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'p'
		if (RESERVED.has(base.toLowerCase())) base += '_'
		let id = base
		for (let n = 2; used.has(id); n++) id = `${base}_${n}`
		used.add(id)
		ids.set(key, id)
		return id
	}
	const lines = ['sequenceDiagram']
	if (ir.title) lines.push(`\ttitle ${esc(ir.title)}`)
	if (ir.sequence?.autoNumber) lines.push('\tautonumber')
	for (const n of ir.nodes) {
		const id = idFor(n.key)
		const label = n.label ?? n.key
		const kw = n.icon === 'user' || n.icon === 'users' ? 'actor' : 'participant'
		lines.push(`\t${kw} ${id}${label !== id ? ` as ${esc(label)}` : ''}`)
	}
	const emit = (events: SeqEvent[], depth: number) => {
		const ind = '\t'.repeat(depth)
		for (const ev of events) {
			switch (ev.kind) {
				case 'message': {
					let from = ev.from
					let to = ev.to
					let { start, end } = ev.arrow
					if (start === 'arrow' && end !== 'arrow') {
						;[from, to] = [to, from]
						;[start, end] = [end, start]
					}
					const d = ev.dash === 'dotted'
					const op = start === 'arrow' ? (d ? '<<-->>' : '<<->>') : end === 'arrow' ? (d ? '-->>' : '->>') : d ? '-->' : '->'
					lines.push(`${ind}${idFor(from)}${op}${idFor(to)}: ${ev.label ? esc(ev.label) : ' '}`)
					break
				}
				case 'activate':
				case 'deactivate':
					lines.push(`${ind}${ev.kind} ${idFor(ev.target)}`)
					break
				case 'note': {
					const where = ev.placement === 'over' ? 'over' : `${ev.placement} of`
					const targets = ev.placement === 'over' ? ev.targets.slice(0, 2) : ev.targets.slice(0, 1)
					lines.push(`${ind}Note ${where} ${targets.map(idFor).join(',')}: ${esc(ev.text)}`)
					break
				}
				case 'block': {
					const cont = ev.type === 'par' ? 'and' : ev.type === 'critical' ? 'option' : 'else'
					ev.sections.forEach((s, i) => {
						const kw = i === 0 ? ev.type : cont
						lines.push(`${ind}${kw}${s.label ? ` ${esc(s.label)}` : ''}`)
						emit(s.events, depth + 1)
					})
					if (!ev.sections.length) lines.push(`${ind}${ev.type}`)
					lines.push(`${ind}end`)
					break
				}
			}
		}
	}
	emit(ir.sequence?.events ?? [], 1)
	return lines.join('\n') + '\n'
}
