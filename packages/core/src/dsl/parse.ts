/**
 * octo DSL parser — hand-written tokenizer + recursive descent.
 *
 * Never throws. Problems become diagnostics (with source offsets) and the
 * parser recovers at the next line. Besides the IR, `analyzeOcto` exposes a
 * statement-level view of the source (declaration items, prop entries, group
 * braces, connection statements) used by the text patchers.
 */

import {
	NODE_SHAPES,
	emptyIR,
	type ArrowHead,
	type ColorMode,
	type DiagramIR,
	type DiagramKind,
	type Diagnostic,
	type Direction,
	type IREdge,
	type IRNode,
	type NodeShape,
	type ParseResult,
	type SourceSpan,
	type StyleMode,
	type Typeface,
	type SeqEvent,
} from '../ir'
import { parseSeqStatement } from './sequence'
import { parseErdStatement } from './erd'

export const OPS = ['>', '<', '<>', '-', '--', '-->'] as const
export type EdgeOp = (typeof OPS)[number]

export const OP_STYLE: Record<EdgeOp, { start: ArrowHead; end: ArrowHead; dash: 'solid' | 'dotted' }> = {
	'>': { start: 'none', end: 'arrow', dash: 'solid' },
	'<': { start: 'arrow', end: 'none', dash: 'solid' },
	'<>': { start: 'arrow', end: 'arrow', dash: 'solid' },
	'-': { start: 'none', end: 'none', dash: 'solid' },
	'--': { start: 'none', end: 'none', dash: 'dotted' },
	'-->': { start: 'none', end: 'arrow', dash: 'dotted' },
}

export const DIRECTIVES = ['title', 'direction', 'colorMode', 'styleMode', 'typeface'] as const

export const KIND_HEADERS: Record<string, DiagramKind> = {
	flowchart: 'flowchart',
	architecture: 'architecture',
	sequence: 'sequence',
	erd: 'erd',
	'flowchart-diagram': 'flowchart',
	'architecture-diagram': 'architecture',
	'cloud-architecture-diagram': 'architecture',
	'sequence-diagram': 'sequence',
	'erd-diagram': 'erd',
	'entity-relationship-diagram': 'erd',
}

const DIRECTIONS: Direction[] = ['down', 'up', 'right', 'left']
const COLOR_MODES: ColorMode[] = ['pastel', 'bold', 'outline']
const STYLE_MODES: StyleMode[] = ['shadow', 'plain', 'watercolor']
const TYPEFACES: Typeface[] = ['rough', 'clean', 'mono']
const DASHES = ['solid', 'dotted', 'dashed'] as const

// ---------------------------------------------------------------------------
// Analysis types (consumed by patch.ts / agent/apply.ts)

export interface PropEntry {
	key: string
	value: string
	/** Range of the whole entry (`key: value`). */
	from: number
	to: number
	/** End of the key text. Replacing `[keyTo, to)` rewrites the value. */
	keyTo: number
}

export interface PropsBlock {
	/** Offset of `[`. */
	from: number
	/** After `]` (or end of the last token when unclosed). */
	to: number
	closed: boolean
	entries: PropEntry[]
}

export interface DeclItem {
	key: string
	nameFrom: number
	nameTo: number
	props?: PropsBlock
	from: number
	to: number
}

export interface StatementBase {
	from: number
	to: number
	/** Enclosing group key, undefined at top level. */
	parent?: string
}

export type Statement =
	| (StatementBase & { kind: 'directive'; name: string; valueFrom: number; valueTo: number })
	| (StatementBase & { kind: 'header' })
	| (StatementBase & { kind: 'decl'; items: DeclItem[] })
	| (StatementBase & { kind: 'group'; item: DeclItem; open: number; close: number })
	| (StatementBase & {
			kind: 'connection'
			items: DeclItem[]
			edges: { edge: IREdge; explicitId: boolean }[]
	  })

export interface OctoAnalysis {
	result: ParseResult
	statements: Statement[]
	/** First declaration of each node (explicit, not implied by a connection). */
	decls: Map<string, DeclItem>
}

// ---------------------------------------------------------------------------
// Tokenizer

export type TokType = 'word' | 'string' | 'op' | '[' | ']' | '{' | '}' | ',' | ':' | 'nl' | 'eof'

export interface Token {
	type: TokType
	from: number
	to: number
	value: string
}

const DELIMS = '[]{},:'

function isWs(c: string | undefined): boolean {
	return c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v'
}

function tokenize(src: string, diags: Diagnostic[]): Token[] {
	const toks: Token[] = []
	const n = src.length
	let i = 0
	let lineHasContent = false
	while (i < n) {
		const c = src[i]
		if (c === '\n') {
			toks.push({ type: 'nl', from: i, to: i + 1, value: '\n' })
			i++
			lineHasContent = false
			continue
		}
		if (isWs(c)) {
			i++
			continue
		}
		const prevWs = i === 0 || isWs(src[i - 1])
		const isLineComment = c === '/' && src[i + 1] === '/' && prevWs
		const isHashComment = c === '#' && (!lineHasContent || (prevWs && (i + 1 >= n || isWs(src[i + 1]))))
		if (isLineComment || isHashComment) {
			while (i < n && src[i] !== '\n') i++
			continue
		}
		lineHasContent = true
		if (DELIMS.includes(c)) {
			toks.push({ type: c as TokType, from: i, to: i + 1, value: c })
			i++
			continue
		}
		if (c === '"') {
			let j = i + 1
			let val = ''
			let closed = false
			while (j < n && src[j] !== '\n') {
				const d = src[j]
				if (d === '\\' && (src[j + 1] === '"' || src[j + 1] === '\\')) {
					val += src[j + 1]
					j += 2
					continue
				}
				if (d === '"') {
					closed = true
					j++
					break
				}
				val += d
				j++
			}
			if (!closed) diags.push({ from: i, to: j, severity: 'error', message: 'Unclosed string' })
			toks.push({ type: 'string', from: i, to: j, value: val })
			i = j
			continue
		}
		let j = i
		while (j < n && !isWs(src[j]) && !DELIMS.includes(src[j]) && src[j] !== '"') j++
		const w = src.slice(i, j)
		toks.push({ type: (OPS as readonly string[]).includes(w) ? 'op' : 'word', from: i, to: j, value: w })
		i = j
	}
	toks.push({ type: 'eof', from: n, to: n, value: '' })
	return toks
}

// ---------------------------------------------------------------------------
// Parser

/** Exported (type-only use) so the sequence / ERD statement parsers in sibling files can drive it. */
export class Parser {
	pos = 0
	lastTo = 0
	private sawStatement = false
	private directionSet = false
	private readonly lineStarts: number[] = [0]
	readonly nodes = new Map<string, IRNode>()
	readonly edges: IREdge[] = []
	readonly pairCount = new Map<string, number>()
	readonly ids = new Set<string>()
	readonly ir: DiagramIR = emptyIR()
	readonly decls = new Map<string, DeclItem>()
	readonly statements: Statement[] = []
	/** Top-level sequence events (kind 'sequence'). */
	readonly seqEvents: SeqEvent[] = []
	autoNumber: boolean | undefined
	notation: 'crows-feet' | 'chen' | undefined

	constructor(
		readonly src: string,
		readonly toks: Token[],
		private readonly diags: Diagnostic[],
	) {
		for (let i = 0; i < src.length; i++) if (src[i] === '\n') this.lineStarts.push(i + 1)
	}

	run(): DiagramIR {
		this.parseBlock(undefined)
		const ir = this.ir
		if (!this.directionSet) ir.direction = ir.kind === 'architecture' || ir.kind === 'erd' ? 'right' : 'down'
		if (ir.kind === 'sequence') ir.sequence = { events: this.seqEvents, ...(this.autoNumber !== undefined ? { autoNumber: this.autoNumber } : {}) }
		if (ir.kind === 'erd' && this.notation) ir.erd = { notation: this.notation }
		ir.nodes = [...this.nodes.values()]
		ir.edges = this.edges
		return ir
	}

	// -- token helpers

	peek(k = 0): Token {
		return this.toks[Math.min(this.pos + k, this.toks.length - 1)]
	}

	next(): Token {
		const t = this.toks[this.pos]
		if (t.type !== 'eof') this.pos++
		this.lastTo = t.to
		return t
	}

	atEnd(t: Token = this.peek()): boolean {
		return t.type === 'nl' || t.type === 'eof' || t.type === '}'
	}

	skipLine(): void {
		while (!this.atEnd()) this.next()
	}

	err(from: number, to: number, message: string, severity: Diagnostic['severity'] = 'error'): void {
		this.diags.push({ from, to: Math.max(to, from), severity, message })
	}

	private lineOf(offset: number): number {
		let lo = 0
		let hi = this.lineStarts.length - 1
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1
			if (this.lineStarts[mid] <= offset) lo = mid
			else hi = mid - 1
		}
		return lo + 1
	}

	span(from: number, to: number): SourceSpan {
		return { from, to, line: this.lineOf(from) }
	}

	/** Text of a run of tokens: a lone string gives its value, otherwise the raw source slice. */
	textOf(toks: Token[]): string {
		if (toks.length === 0) return ''
		if (toks.length === 1 && toks[0].type === 'string') return toks[0].value
		return this.src.slice(toks[0].from, toks[toks.length - 1].to)
	}

	// -- structure

	private parseBlock(parent: string | undefined): void {
		for (;;) {
			const t = this.peek()
			if (t.type === 'nl') {
				this.next()
				continue
			}
			if (t.type === 'eof') return
			if (t.type === '}') {
				if (parent !== undefined) return
				this.err(t.from, t.to, 'Unexpected "}"')
				this.next()
				continue
			}
			const before = this.pos
			this.parseStatement(parent)
			if (this.pos === before) {
				// Defensive: never loop without progress.
				this.next()
			}
		}
	}

	private parseStatement(parent: string | undefined): void {
		const t = this.peek()
		const first = !this.sawStatement
		this.sawStatement = true
		if (t.type === 'word') {
			const nx = this.peek(1)
			// `source <connector input>`: top level only, and only with a value (a lone `source` stays a node)
			if (t.value === 'source' && parent === undefined && (nx.type === 'word' || nx.type === 'string')) {
				this.parseDirective(parent)
				return
			}
			if ((DIRECTIVES as readonly string[]).includes(t.value)) {
				if (this.atEnd(nx)) {
					this.next()
					this.err(t.from, t.to, `Missing value for "${t.value}"`, 'warning')
					return
				}
				if (nx.type === 'word' || nx.type === 'string') {
					this.parseDirective(parent)
					return
				}
			}
			const headerOk = first || (parent === undefined && !this.statements.some((s) => s.kind !== 'directive'))
			if (headerOk && KIND_HEADERS[t.value] && this.atEnd(nx) && nx.type !== '}') {
				this.next()
				this.ir.kind = KIND_HEADERS[t.value]
				this.statements.push({ kind: 'header', from: t.from, to: t.to, parent })
				return
			}
			// `diagramType sequence`
			if (headerOk && t.value === 'diagramType' && nx.type === 'word' && this.atEnd(this.peek(2))) {
				this.next()
				this.next()
				if (KIND_HEADERS[nx.value]) this.ir.kind = KIND_HEADERS[nx.value]
				else this.err(nx.from, nx.to, `Unknown diagram type "${nx.value}" (expected flowchart, architecture, sequence, erd)`, 'warning')
				this.statements.push({ kind: 'header', from: t.from, to: nx.to, parent })
				return
			}
		}
		if (this.ir.kind === 'sequence') {
			const ev = parseSeqStatement(this)
			if (ev) this.seqEvents.push(ev)
			return
		}
		if (this.ir.kind === 'erd') {
			parseErdStatement(this)
			return
		}
		this.parseConnectionOrDecl(parent)
	}

	private parseDirective(parent: string | undefined): void {
		const kw = this.next()
		const vals: Token[] = []
		while (!this.atEnd()) vals.push(this.next())
		const value = this.textOf(vals)
		const valueFrom = vals[0].from
		const valueTo = vals[vals.length - 1].to
		this.statements.push({ kind: 'directive', name: kw.value, from: kw.from, to: valueTo, valueFrom, valueTo, parent })
		const bad = (allowed: readonly string[]) =>
			this.err(valueFrom, valueTo, `Unknown ${kw.value} "${value}" (expected ${allowed.join(', ')})`, 'warning')
		switch (kw.value) {
			case 'title':
				this.ir.title = value
				break
			case 'source':
				this.ir.source = value
				break
			case 'direction':
				if ((DIRECTIONS as string[]).includes(value)) {
					this.ir.direction = value as Direction
					this.directionSet = true
				} else bad(DIRECTIONS)
				break
			case 'colorMode':
				if ((COLOR_MODES as string[]).includes(value)) this.ir.style.colorMode = value as ColorMode
				else bad(COLOR_MODES)
				break
			case 'styleMode':
				if ((STYLE_MODES as string[]).includes(value)) this.ir.style.styleMode = value as StyleMode
				else bad(STYLE_MODES)
				break
			case 'typeface':
				if ((TYPEFACES as string[]).includes(value)) this.ir.style.typeface = value as Typeface
				else bad(TYPEFACES)
				break
		}
	}

	parseItem(): DeclItem | null {
		const nameToks: Token[] = []
		while (this.peek().type === 'word' || this.peek().type === 'string') nameToks.push(this.next())
		if (nameToks.length === 0) return null
		const key =
			nameToks.length === 1 && nameToks[0].type === 'string'
				? nameToks[0].value
				: nameToks.map((t) => t.value).join(' ')
		const nameFrom = nameToks[0].from
		const nameTo = nameToks[nameToks.length - 1].to
		if (key === '') this.err(nameFrom, nameTo, 'Empty name', 'warning')
		const item: DeclItem = { key, nameFrom, nameTo, from: nameFrom, to: nameTo }
		if (this.peek().type === '[') {
			item.props = this.parseProps()
			item.to = item.props.to
		}
		return item
	}

	private parseItemList(): DeclItem[] | null {
		const items: DeclItem[] = []
		for (;;) {
			const item = this.parseItem()
			if (!item) {
				if (items.length > 0) {
					const t = this.peek()
					this.err(t.from, t.to, 'Expected a name after ","')
				}
				break
			}
			items.push(item)
			if (this.peek().type === ',') {
				this.next()
				continue
			}
			break
		}
		return items.length ? items : null
	}

	parseProps(): PropsBlock {
		const open = this.next()
		const inner: Token[] = []
		let closed = false
		let to = open.to
		for (;;) {
			const t = this.peek()
			if (t.type === ']') {
				this.next()
				closed = true
				to = t.to
				break
			}
			if (t.type === 'nl' || t.type === 'eof') break
			inner.push(this.next())
			to = t.to
		}
		if (!closed) this.err(open.from, to, 'Unclosed "["')
		const entries: PropEntry[] = []
		let seg: Token[] = []
		const flush = () => {
			if (seg.length === 0) return
			const colon = seg.findIndex((t) => t.type === ':')
			const keyToks = colon < 0 ? seg : seg.slice(0, colon)
			if (keyToks.length === 0) {
				this.err(seg[0].from, seg[seg.length - 1].to, 'Property is missing a name', 'warning')
			} else {
				const valToks = colon < 0 ? [] : seg.slice(colon + 1)
				entries.push({
					key: keyToks.map((t) => t.value).join(' '),
					value: colon < 0 ? 'true' : this.textOf(valToks),
					from: seg[0].from,
					to: seg[seg.length - 1].to,
					keyTo: keyToks[keyToks.length - 1].to,
				})
			}
			seg = []
		}
		for (const t of inner) {
			if (t.type === ',') flush()
			else seg.push(t)
		}
		flush()
		return { from: open.from, to, closed, entries }
	}

	private parseConnectionOrDecl(parent: string | undefined): void {
		const start = this.peek()
		const segments: DeclItem[][] = []
		const ops: Token[] = []
		for (;;) {
			const list = this.parseItemList()
			if (!list) {
				const t = this.peek()
				if (ops.length) {
					const op = ops.pop()!
					this.err(op.from, op.to, `Expected a name after "${op.value}"`)
				} else {
					this.err(t.from, t.to, t.type === 'op' ? `Expected a name before "${t.value}"` : `Unexpected "${t.value}"`)
				}
				break
			}
			segments.push(list)
			if (this.peek().type === 'op') {
				ops.push(this.next())
				continue
			}
			break
		}
		if (segments.length === 0) {
			this.skipLine()
			return
		}

		// Group block.
		if (this.peek().type === '{') {
			if (ops.length === 0 && segments[0].length === 1) {
				this.parseGroup(segments[0][0], parent)
				return
			}
			const t = this.peek()
			this.err(t.from, t.to, 'A group needs exactly one name before "{"')
		}

		if (ops.length === 0) {
			const items = segments[0]
			for (const item of items) this.declare(item, parent, true)
			this.statements.push({ kind: 'decl', items, from: items[0].from, to: items[items.length - 1].to, parent })
			if (this.peek().type === ':') {
				const t = this.peek()
				this.err(t.from, t.to, 'Labels (":") are only allowed on connections')
			}
		} else {
			this.parseConnectionTail(start.from, segments, ops, parent)
		}

		const t = this.peek()
		if (t.type === '{') {
			// Recover: parse the body at the current level.
			this.next()
			this.parseBlock(parent ?? '')
			if (this.peek().type === '}') this.next()
			return
		}
		if (!this.atEnd(t)) {
			this.err(t.from, t.to, `Unexpected "${t.value}"`)
			this.skipLine()
		}
	}

	private parseGroup(item: DeclItem, parent: string | undefined): void {
		const node = this.declare(item, parent, true)
		node.isContainer = true
		const open = this.next()
		const stmt: Statement = { kind: 'group', item, parent, from: item.from, to: open.to, open: open.from, close: -1 }
		this.statements.push(stmt)
		this.parseBlock(item.key)
		const t = this.peek()
		if (t.type === '}') {
			this.next()
			stmt.close = t.from
			stmt.to = t.to
		} else {
			this.err(open.from, open.to, `Unclosed "{" for group "${item.key}"`)
		}
	}

	private parseConnectionTail(from: number, segments: DeclItem[][], ops: Token[], parent: string | undefined): void {
		let label: string | undefined
		let edgeProps: PropsBlock | undefined
		const last = segments[segments.length - 1]
		const lastItem = last[last.length - 1]
		if (this.peek().type === ':') {
			this.next()
			const toks: Token[] = []
			while (!this.atEnd() && this.peek().type !== '[') toks.push(this.next())
			const text = this.textOf(toks)
			if (text !== '') label = text
			if (this.peek().type === '[') edgeProps = this.parseProps()
		} else if (lastItem.props) {
			// `A > B [color: red]` — trailing props belong to the connection.
			edgeProps = lastItem.props
			lastItem.props = undefined
			lastItem.to = lastItem.nameTo
		}
		const to = this.lastTo
		const span = this.span(from, to)

		for (const seg of segments) {
			for (const item of seg) {
				if (item.props) this.declare(item, undefined, true)
				else this.ensure(item.key)
			}
		}

		const stmtEdges: { edge: IREdge; explicitId: boolean }[] = []
		let id: string | undefined
		let color: string | undefined
		let dash: (typeof DASHES)[number] | undefined
		if (edgeProps) {
			for (const e of edgeProps.entries) {
				switch (e.key) {
					case 'id':
						id = e.value
						break
					case 'color':
						color = e.value
						break
					case 'label':
						label = e.value
						break
					case 'dash':
						if ((DASHES as readonly string[]).includes(e.value)) dash = e.value as (typeof DASHES)[number]
						else this.err(e.from, e.to, `Unknown dash "${e.value}" (expected ${DASHES.join(', ')})`, 'warning')
						break
					default:
						this.err(e.from, e.to, `Unknown connection property "${e.key}"`, 'warning')
				}
			}
		}

		let ordinal = 0
		for (let i = 0; i < ops.length; i++) {
			const op = OP_STYLE[ops[i].value as EdgeOp]
			for (const a of segments[i]) {
				for (const b of segments[i + 1]) {
					const edge: IREdge = {
						key: '',
						from: a.key,
						to: b.key,
						arrow: { start: op.start, end: op.end },
						line: { dash: op.dash },
						span: { ...span },
					}
					if (label !== undefined) edge.label = label
					if (color !== undefined || dash !== undefined) {
						edge.style = {}
						if (color !== undefined) edge.style.color = color
						if (dash !== undefined) edge.style.dash = dash
					}
					if (id !== undefined) {
						edge.key = ordinal === 0 ? id : `${id}#${ordinal}`
						if (this.ids.has(edge.key)) this.err(from, to, `Duplicate connection id "${edge.key}"`, 'warning')
					} else {
						const pair = `${a.key}->${b.key}`
						const n = this.pairCount.get(pair) ?? 0
						this.pairCount.set(pair, n + 1)
						edge.key = `${pair}#${n}`
					}
					this.ids.add(edge.key)
					ordinal++
					this.edges.push(edge)
					stmtEdges.push({ edge, explicitId: id !== undefined })
				}
			}
		}
		this.statements.push({ kind: 'connection', items: segments.flat(), edges: stmtEdges, from, to, parent })
	}

	// -- nodes

	ensure(key: string): IRNode {
		let n = this.nodes.get(key)
		if (!n) {
			n = { key }
			this.nodes.set(key, n)
		}
		return n
	}

	private isAncestorOrSelf(key: string, of: string): boolean {
		const seen = new Set<string>()
		let cur: string | undefined = of
		while (cur !== undefined && !seen.has(cur)) {
			if (cur === key) return true
			seen.add(cur)
			cur = this.nodes.get(cur)?.parent
		}
		return false
	}

	declare(item: DeclItem, parent: string | undefined, isDecl: boolean): IRNode {
		const n = this.ensure(item.key)
		if (isDecl) {
			if (!n.span) n.span = this.span(item.from, item.to)
			if (!this.decls.has(item.key)) this.decls.set(item.key, item)
		}
		if (parent !== undefined && parent !== '') {
			if (this.isAncestorOrSelf(item.key, parent)) {
				this.err(item.nameFrom, item.nameTo, `"${item.key}" cannot be placed inside itself`, 'warning')
			} else {
				n.parent = parent
			}
		}
		if (item.props) this.applyNodeProps(n, item.props)
		return n
	}

	private applyNodeProps(n: IRNode, props: PropsBlock): void {
		for (const e of props.entries) {
			switch (e.key) {
				case 'shape':
					if ((NODE_SHAPES as readonly string[]).includes(e.value)) {
						n.shape = e.value as NodeShape
						if (n.ext) delete n.ext.shape
					} else {
						this.err(e.from, e.to, `Unknown shape "${e.value}" (expected ${NODE_SHAPES.join(', ')})`, 'warning')
						n.ext = { ...n.ext, shape: e.value }
					}
					break
				case 'icon':
					n.icon = e.value
					break
				case 'label':
					n.label = e.value
					break
				case 'link':
					n.link = e.value
					break
				case 'color':
					n.style = { ...n.style, color: e.value }
					break
				default:
					n.ext = { ...n.ext, [e.key]: e.value }
			}
		}
	}
}

export function analyzeOcto(src: string): OctoAnalysis {
	const diagnostics: Diagnostic[] = []
	try {
		const toks = tokenize(src, diagnostics)
		const p = new Parser(src, toks, diagnostics)
		const ir = p.run()
		diagnostics.sort((a, b) => a.from - b.from)
		return { result: { ir, diagnostics }, statements: p.statements, decls: p.decls }
	} catch (e) {
		// The parser is designed not to throw; this is a last-resort guard.
		diagnostics.push({ from: 0, to: src.length, severity: 'error', message: `Internal parser error: ${String(e)}` })
		return { result: { ir: emptyIR(), diagnostics }, statements: [], decls: new Map() }
	}
}

export function parseOcto(src: string): ParseResult {
	return analyzeOcto(src).result
}
