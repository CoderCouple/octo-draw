/**
 * Sequence-diagram statements for the octo DSL (Eraser syntax), driven by the
 * main `Parser` once a `sequence` header switched the grammar:
 *
 *   Web App [icon: monitor] > DB [icon: database]: Start transaction
 *   DB --> Web App: ok [color: green]
 *   activate DB
 *   loop [label: every 5s] { ... }
 *   alt [label: hit] { ... } else [label: miss] { ... }
 *   par { ... } and { ... }
 *   note over Web App, DB: text
 *   autoNumber on
 *
 * Never throws; problems become diagnostics on the parser.
 */
import type { ArrowHead, SeqBlock, SeqBlockType, SeqEvent, SeqMessage, SeqNote, SeqSection } from '../ir'
import type { DeclItem, Parser, PropsBlock, Token } from './parse'

export const SEQ_BLOCKS: readonly SeqBlockType[] = ['loop', 'alt', 'opt', 'par', 'break', 'critical']
export const SEQ_CONTINUATIONS = ['else', 'and', 'option'] as const
export const SEQ_KEYWORDS = ['activate', 'deactivate', 'note', 'autoNumber', ...SEQ_BLOCKS, ...SEQ_CONTINUATIONS] as const

const MSG_STYLE: Record<string, { start: ArrowHead; end: ArrowHead; dash: 'solid' | 'dotted' }> = {
	'>': { start: 'none', end: 'arrow', dash: 'solid' },
	'<': { start: 'arrow', end: 'none', dash: 'solid' },
	'<>': { start: 'arrow', end: 'arrow', dash: 'solid' },
	'-': { start: 'none', end: 'none', dash: 'solid' },
	'--': { start: 'none', end: 'none', dash: 'dotted' },
	'-->': { start: 'none', end: 'arrow', dash: 'dotted' },
}

/** Tokens from the cursor to the end of the physical line. */
export function restOfLine(p: Parser): Token[] {
	const out: Token[] = []
	for (let k = 0; ; k++) {
		const t = p.peek(k)
		if (t.type === 'nl' || t.type === 'eof') break
		out.push(t)
	}
	return out
}

function useItem(p: Parser, item: DeclItem) {
	if (item.props) p.declare(item, undefined, true)
	else p.ensure(item.key)
}

/** Parses one sequence statement. Returns the event (if any) for the caller's list. */
export function parseSeqStatement(p: Parser): SeqEvent | null {
	const t = p.peek()
	const rest = restOfLine(p)
	const hasOp = rest.some((x) => x.type === 'op')
	if (t.type === 'word' && !hasOp) {
		const nx = p.peek(1)
		if (t.value === 'autoNumber') {
			p.next()
			const val = restOfLine(p).filter((x) => x.type !== '}')
			const v = val.map((x) => x.value).join(' ')
			if (v === '' || v === 'on' || v === 'true' || v === 'nested') p.autoNumber = true
			else if (v === 'off' || v === 'false') p.autoNumber = false
			else p.err(val[0].from, val[val.length - 1].to, `Unknown autoNumber "${v}" (expected on, off, nested)`, 'warning')
			p.skipLine()
			p.statements.push({ kind: 'directive', name: 'autoNumber', from: t.from, to: p.lastTo, valueFrom: val[0]?.from ?? t.to, valueTo: p.lastTo })
			return null
		}
		const opensBrace = rest.some((x) => x.type === '{')
		if ((SEQ_BLOCKS as readonly string[]).includes(t.value) && opensBrace) return parseBlock(p)
		if ((SEQ_CONTINUATIONS as readonly string[]).includes(t.value) && opensBrace) {
			p.err(t.from, t.to, `"${t.value}" must follow the closing "}" of a block`)
			const head = p.next()
			parseSection(p, head)
			return null
		}
		if ((t.value === 'activate' || t.value === 'deactivate') && (nx.type === 'word' || nx.type === 'string')) {
			p.next()
			const item = p.parseItem()
			if (!item) return null
			useItem(p, item)
			if (!p.atEnd()) {
				const u = p.peek()
				p.err(u.from, u.to, `Unexpected "${u.value}"`)
				p.skipLine()
			}
			return { kind: t.value, target: item.key, span: p.span(t.from, p.lastTo) }
		}
		if (t.value === 'note' && rest.some((x) => x.type === ':') && (nx.type === 'word' || nx.type === 'string')) return parseNote(p)
	}
	return parseMessage(p)
}

function parseNote(p: Parser): SeqNote | null {
	const kw = p.next()
	let placement: SeqNote['placement'] = 'over'
	const w = p.peek()
	if (w.type === 'word' && (w.value === 'over' || w.value === 'left' || w.value === 'right')) {
		p.next()
		placement = w.value
		const of = p.peek()
		if (placement !== 'over' && of.type === 'word' && of.value === 'of') p.next()
	}
	const targets: string[] = []
	for (;;) {
		const item = p.parseItem()
		if (!item) break
		useItem(p, item)
		targets.push(item.key)
		if (p.peek().type !== ',') break
		p.next()
	}
	if (targets.length === 0) {
		p.err(kw.from, p.peek().to, 'A note needs a participant: note over A: text')
		p.skipLine()
		return null
	}
	if (placement !== 'over' && targets.length > 1) p.err(kw.from, p.lastTo, `"note ${placement} of" takes one participant`, 'warning')
	let text = ''
	let color: string | undefined
	if (p.peek().type === ':') {
		p.next()
		const toks: Token[] = []
		while (!p.atEnd() && p.peek().type !== '[') toks.push(p.next())
		text = p.textOf(toks)
		if (p.peek().type === '[') {
			for (const e of p.parseProps().entries) {
				if (e.key === 'color') color = e.value
				else p.err(e.from, e.to, `Unknown note property "${e.key}"`, 'warning')
			}
		}
	}
	trailing(p)
	const note: SeqNote = { kind: 'note', placement, targets, text, span: p.span(kw.from, p.lastTo) }
	if (color !== undefined) note.color = color
	return note
}

function trailing(p: Parser) {
	if (!p.atEnd()) {
		const u = p.peek()
		p.err(u.from, u.to, `Unexpected "${u.value}"`)
		p.skipLine()
	}
}

/** `kw [label words] [props] {` body `}`; the caller consumed nothing yet except `head`. */
function parseSection(p: Parser, head: Token): { section: SeqSection; props?: PropsBlock; closed: boolean } {
	const labelToks: Token[] = []
	while (!p.atEnd() && p.peek().type !== '[' && p.peek().type !== '{') labelToks.push(p.next())
	let props: PropsBlock | undefined
	if (p.peek().type === '[') props = p.parseProps()
	const section: SeqSection = { events: [] }
	const label = p.textOf(labelToks.filter((x) => x.type !== ':'))
	if (label) section.label = label
	for (const e of props?.entries ?? []) if (e.key === 'label') section.label = e.value
	if (p.peek().type !== '{') {
		p.err(head.from, p.lastTo, `Expected "{" after "${head.value}"`)
		p.skipLine()
		return { section, props, closed: false }
	}
	const open = p.next()
	for (;;) {
		const t = p.peek()
		if (t.type === 'nl') {
			p.next()
			continue
		}
		if (t.type === 'eof') {
			p.err(open.from, open.to, `Unclosed "{" for "${head.value}"`)
			return { section, props, closed: false }
		}
		if (t.type === '}') {
			p.next()
			return { section, props, closed: true }
		}
		const before = p.pos
		const ev = parseSeqStatement(p)
		if (ev) section.events.push(ev)
		if (p.pos === before) p.next()
	}
}

function parseBlock(p: Parser): SeqBlock {
	const head = p.next()
	const block: SeqBlock = { kind: 'block', type: head.value as SeqBlockType, sections: [] }
	let res = parseSection(p, head)
	block.sections.push(res.section)
	for (const e of res.props?.entries ?? []) {
		if (e.key === 'color') block.color = e.value
		else if (e.key === 'icon') block.icon = e.value
		else if (e.key !== 'label') p.err(e.from, e.to, `Unknown block property "${e.key}"`, 'warning')
	}
	// continuation sections: `} else [label: x] {` on the same or the next line
	while (res.closed) {
		const save = p.pos
		while (p.peek().type === 'nl') p.next()
		const t = p.peek()
		const isCont =
			t.type === 'word' &&
			(SEQ_CONTINUATIONS as readonly string[]).includes(t.value) &&
			restOfLine(p).some((x) => x.type === '{') &&
			!restOfLine(p).some((x) => x.type === 'op')
		if (!isCont) {
			p.pos = save
			break
		}
		const kw = p.next()
		res = parseSection(p, kw)
		block.sections.push(res.section)
		for (const e of res.props?.entries ?? []) if (e.key !== 'label') p.err(e.from, e.to, `Unknown section property "${e.key}"`, 'warning')
	}
	block.span = p.span(head.from, p.lastTo)
	return block
}

function parseMessage(p: Parser): SeqMessage | null {
	const start = p.peek()
	const a = p.parseItem()
	if (!a) {
		p.err(start.from, start.to, start.type === 'op' ? `Expected a participant before "${start.value}"` : `Unexpected "${start.value}"`)
		p.next()
		p.skipLine()
		return null
	}
	if (p.peek().type !== 'op') {
		// participant declaration: fixes column order and props
		p.declare(a, undefined, true)
		p.statements.push({ kind: 'decl', items: [a], from: a.from, to: a.to })
		if (p.peek().type === ':') {
			const t = p.peek()
			p.err(t.from, t.to, 'Labels (":") are only allowed on messages')
		}
		trailing(p)
		return null
	}
	const op = p.next()
	const b = p.parseItem()
	if (!b) {
		p.err(op.from, op.to, `Expected a participant after "${op.value}"`)
		p.skipLine()
		return null
	}
	useItem(p, a)
	useItem(p, b)
	if (p.peek().type === 'op') {
		const t = p.peek()
		p.err(t.from, t.to, 'A message connects exactly two participants (one per line)')
		p.skipLine()
	}
	const style = MSG_STYLE[op.value] ?? MSG_STYLE['>']
	const msg: SeqMessage = { kind: 'message', from: a.key, to: b.key, arrow: { start: style.start, end: style.end }, dash: style.dash }
	if (p.peek().type === ':') {
		p.next()
		const toks: Token[] = []
		while (!p.atEnd() && p.peek().type !== '[') toks.push(p.next())
		const text = p.textOf(toks)
		if (text !== '') msg.label = text
		if (p.peek().type === '[') {
			for (const e of p.parseProps().entries) {
				switch (e.key) {
					case 'color':
						msg.color = e.value
						break
					case 'label':
						msg.label = e.value
						break
					case 'dash':
						if (e.value === 'dotted' || e.value === 'dashed') msg.dash = 'dotted'
						else if (e.value === 'solid') msg.dash = 'solid'
						else p.err(e.from, e.to, `Unknown dash "${e.value}" (expected solid, dotted)`, 'warning')
						break
					default:
						p.err(e.from, e.to, `Unknown message property "${e.key}"`, 'warning')
				}
			}
		}
	}
	trailing(p)
	msg.span = p.span(a.from, p.lastTo)
	p.statements.push({ kind: 'connection', items: [a, b], edges: [], from: a.from, to: p.lastTo })
	return msg
}
