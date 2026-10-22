/**
 * Hand-written parser for the mermaid `flowchart` / `graph` subset.
 * No mermaid dependency. Never throws: problems become diagnostics.
 */
import {
	emptyIR,
	type DiagramIR,
	type Diagnostic,
	type Direction,
	type IREdge,
	type IRNode,
	type IRStyle,
	type NodeShape,
	type ParseResult,
} from '../ir'
import { parseMermaidSequence } from './sequence'
import { parseMermaidErd } from './erd'

/** Common CSS / palette color names → hex. */
export const NAMED_COLORS: Record<string, string> = {
	black: '#000000',
	white: '#ffffff',
	red: '#ef4444',
	orange: '#f97316',
	yellow: '#eab308',
	green: '#22c55e',
	teal: '#14b8a6',
	cyan: '#06b6d4',
	blue: '#3b82f6',
	indigo: '#6366f1',
	purple: '#a855f7',
	violet: '#8b5cf6',
	pink: '#ec4899',
	gray: '#6b7280',
	grey: '#6b7280',
	brown: '#92400e',
	lime: '#84cc16',
	navy: '#000080',
	gold: '#ffd700',
	silver: '#c0c0c0',
	lightblue: '#add8e6',
	lightgreen: '#90ee90',
	lightgray: '#d3d3d3',
	lightgrey: '#d3d3d3',
	darkblue: '#00008b',
	darkgreen: '#006400',
	salmon: '#fa8072',
	coral: '#ff7f50',
	magenta: '#ff00ff',
	beige: '#f5f5dc',
	lavender: '#e6e6fa',
}

/** Normalise a CSS color to lowercase `#rrggbb`; undefined when unknown / `none`. */
export function normalizeColor(raw: string): string | undefined {
	const v = raw.trim().toLowerCase().replace(/\s*!important$/, '')
	let m: RegExpExecArray | null
	if ((m = /^#([0-9a-f]{3,4})$/.exec(v))) {
		const [r, g, b] = m[1]
		return `#${r}${r}${g}${g}${b}${b}`
	}
	if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v))) return `#${m[1]}`
	if ((m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v))) {
		return '#' + [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')
	}
	return NAMED_COLORS[v]
}

interface Stmt {
	text: string
	from: number
}

const UNSUPPORTED = [
	'sequenceDiagram',
	'classDiagram',
	'classDiagram-v2',
	'stateDiagram',
	'stateDiagram-v2',
	'erDiagram',
	'gantt',
	'pie',
	'journey',
	'gitGraph',
	'mindmap',
	'timeline',
	'quadrantChart',
	'requirementDiagram',
	'C4Context',
	'C4Container',
	'C4Component',
	'C4Dynamic',
	'C4Deployment',
	'sankey-beta',
	'sankey',
	'xychart-beta',
	'xychart',
	'block-beta',
	'block',
	'packet-beta',
	'packet',
	'kanban',
	'architecture-beta',
	'architecture',
	'radar-beta',
	'zenuml',
	'treemap-beta',
]

const DIRECTIONS: Record<string, Direction> = {
	TD: 'down',
	TB: 'down',
	BT: 'up',
	LR: 'right',
	RL: 'left',
}

/** v11 `@{ shape: ... }` names → IR shapes. */
const V11_SHAPES: Record<string, NodeShape> = {
	rect: 'rectangle',
	rectangle: 'rectangle',
	proc: 'rectangle',
	process: 'rectangle',
	square: 'rectangle',
	rounded: 'oval',
	event: 'oval',
	stadium: 'oval',
	pill: 'oval',
	terminal: 'oval',
	circle: 'ellipse',
	circ: 'ellipse',
	'dbl-circ': 'ellipse',
	'double-circle': 'ellipse',
	'sm-circ': 'ellipse',
	'small-circle': 'ellipse',
	start: 'ellipse',
	'f-circ': 'ellipse',
	stop: 'ellipse',
	'fr-circ': 'ellipse',
	diam: 'diamond',
	diamond: 'diamond',
	decision: 'diamond',
	question: 'diamond',
	hex: 'hexagon',
	hexagon: 'hexagon',
	prepare: 'hexagon',
	cyl: 'cylinder',
	cylinder: 'cylinder',
	database: 'cylinder',
	db: 'cylinder',
	'h-cyl': 'cylinder',
	das: 'cylinder',
	'lin-cyl': 'cylinder',
	'disk': 'cylinder',
	'lean-r': 'parallelogram',
	'lean-right': 'parallelogram',
	'in-out': 'parallelogram',
	'lean-l': 'parallelogram',
	'lean-left': 'parallelogram',
	'out-in': 'parallelogram',
	'trap-b': 'trapezoid',
	trapezoid: 'trapezoid',
	priority: 'trapezoid',
	'trapezoid-bottom': 'trapezoid',
	'trap-t': 'trapezoid',
	manual: 'trapezoid',
	'inv-trapezoid': 'trapezoid',
	'trapezoid-top': 'trapezoid',
	doc: 'document',
	document: 'document',
	docs: 'document',
	documents: 'document',
	'st-doc': 'document',
	'stacked-document': 'document',
	'lin-doc': 'document',
	'tag-doc': 'document',
	tri: 'triangle',
	triangle: 'triangle',
	extract: 'triangle',
	cloud: 'cloud',
	star: 'star',
}

const ENTITIES: Record<string, string> = {
	quot: '"',
	amp: '&',
	lt: '<',
	gt: '>',
	nbsp: ' ',
	apos: "'",
	hash: '#',
	semi: ';',
	vert: '|',
	colon: ':',
}

export function decodeEntities(s: string): string {
	return s.replace(/#(\w+);/g, (m, name: string) => {
		if (/^\d+$/.test(name)) return String.fromCodePoint(Number(name))
		return ENTITIES[name] ?? m
	})
}

/** Clean a raw label: quotes, markdown-string backticks, `<br>`, entities. */
export function cleanLabel(raw: string): string {
	let s = raw.trim()
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
	if (s.length >= 2 && s.startsWith('`') && s.endsWith('`')) s = s.slice(1, -1)
	s = s.replace(/<br\s*\/?>/gi, ' ')
	s = decodeEntities(s)
	return s.replace(/\s+/g, ' ').trim()
}

/** Replace a leading/trailing ``` fence with spaces so offsets stay valid. */
function blankFences(src: string): string {
	const m = /^(\s*)(```+|~~~+)[^\n]*(\n|$)/.exec(src)
	if (!m) return src
	let out = src.slice(0, m[1].length) + ' '.repeat(m[0].length - m[1].length - m[3].length) + src.slice(m[0].length - m[3].length)
	const fence = m[2]
	const close = new RegExp(`(^|\\n)([ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*)(?=\\n|$)`, 'g')
	let last: RegExpExecArray | null = null
	let mm: RegExpExecArray | null
	close.lastIndex = m[0].length
	while ((mm = close.exec(out))) last = mm
	if (last) {
		const start = last.index + last[1].length
		out = out.slice(0, start) + ' '.repeat(last[2].length) + out.slice(start + last[2].length)
		// Anything after the closing fence is prose: blank it.
		const after = start + last[2].length
		out = out.slice(0, after) + out.slice(after).replace(/[^\n]/g, ' ')
	}
	return out
}

function splitStatements(src: string): Stmt[] {
	const out: Stmt[] = []
	let start = 0
	let i = 0
	let quote = false
	let quoteMd = false
	let brace = 0
	const push = (end: number) => {
		const raw = src.slice(start, end)
		const t = raw.trim()
		if (t) out.push({ text: t, from: start + (raw.length - raw.trimStart().length) })
	}
	while (i < src.length) {
		const ch = src[i]
		if (quote) {
			if (ch === '"') quote = false
			else if (ch === '\n' && !quoteMd && brace === 0) {
				quote = false
				push(i)
				start = i + 1
			}
			i++
			continue
		}
		if (ch === '"') {
			quote = true
			quoteMd = src[i + 1] === '`'
			i++
			continue
		}
		if (ch === '@' && src[i + 1] === '{') {
			brace++
			i += 2
			continue
		}
		if (brace > 0) {
			if (ch === '{') brace++
			else if (ch === '}') brace--
			i++
			continue
		}
		if (ch === '%' && src[i + 1] === '%' && (i === 0 || /\s/.test(src[i - 1]))) {
			push(i)
			while (i < src.length && src[i] !== '\n') i++
			start = i
			continue
		}
		if (ch === '\n' || (ch === ';' && !/#\w+$/.test(src.slice(Math.max(0, i - 12), i)))) {
			push(i)
			start = i + 1
		}
		i++
	}
	push(src.length)
	return out
}

function lineOf(src: string, offset: number): number {
	let line = 1
	for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
	return line
}

interface ShapeInfo {
	shape?: NodeShape
	label?: string
	icon?: string
}

interface LinkInfo {
	start: boolean
	end: boolean
	dotted: boolean
	invisible: boolean
	label?: string
	id?: string
}

/** Split `a: b, c: "d, e"` on commas outside quotes/parens. */
function splitTopLevel(s: string, seps: string): string[] {
	const parts: string[] = []
	let depth = 0
	let quote: string | null = null
	let cur = ''
	for (const ch of s) {
		if (quote) {
			if (ch === quote) quote = null
			cur += ch
			continue
		}
		if (ch === '"' || ch === "'") quote = ch
		else if (ch === '(') depth++
		else if (ch === ')') depth--
		else if (depth === 0 && seps.includes(ch)) {
			parts.push(cur)
			cur = ''
			continue
		}
		cur += ch
	}
	parts.push(cur)
	return parts.map((p) => p.trim()).filter(Boolean)
}

/** Parse `fill:#f9f,stroke:#333` → IRStyle. */
export function parseStyleProps(s: string): IRStyle {
	const style: IRStyle = {}
	let fill: string | undefined
	let stroke: string | undefined
	for (const part of splitTopLevel(s, ',')) {
		const idx = part.indexOf(':')
		if (idx < 0) continue
		const k = part.slice(0, idx).trim().toLowerCase()
		const v = part.slice(idx + 1).trim()
		if (k === 'fill') fill = normalizeColor(v)
		else if (k === 'stroke') stroke = normalizeColor(v)
		else if (k === 'stroke-dasharray') style.dash = 'dashed'
	}
	const color = fill ?? stroke
	if (color) style.color = color
	return style
}

const ID_STOP = /[\s\[\](){}<>|&;:"@,]/

export function parseMermaid(input: string): ParseResult {
	const src = blankFences(input)
	const ir = emptyIR('flowchart')
	const diagnostics: Diagnostic[] = []
	const nodes = new Map<string, IRNode>()
	const nodeClasses = new Map<string, string[]>()
	const directStyles = new Map<string, IRStyle>()
	const classDefs = new Map<string, IRStyle>()
	const pairCount = new Map<string, number>()
	const stack: string[] = []
	let subgraphCounter = 0

	const diag = (from: number, to: number, message: string, severity: 'error' | 'warning' = 'error') => {
		diagnostics.push({ from, to: Math.max(to, from), severity, message })
	}

	// Front matter (`---\ntitle: X\n---`).
	let body = src
	const fm = /^(\s*)---[ \t]*\n([\s\S]*?)\n[ \t]*---[ \t]*(\n|$)/.exec(body)
	if (fm) {
		const t = /^\s*title:\s*(.+)$/m.exec(fm[2])
		if (t) ir.title = cleanLabel(t[1].trim().replace(/^'(.*)'$/, '$1'))
		body = body.slice(0, fm[1].length) + fm[0].slice(fm[1].length).replace(/[^\n]/g, ' ') + body.slice(fm[0].length)
	}

	const touch = (key: string, from: number, to: number): IRNode => {
		let n = nodes.get(key)
		if (!n) {
			n = { key, span: { from, to, line: lineOf(src, from) } }
			nodes.set(key, n)
			ir.nodes.push(n)
		}
		const parent = stack[stack.length - 1]
		if (parent && !n.parent && parent !== key && !isAncestor(key, parent)) n.parent = parent
		return n
	}

	const isAncestor = (maybeAncestor: string, key: string): boolean => {
		let cur: string | undefined = key
		const seen = new Set<string>()
		while (cur && !seen.has(cur)) {
			if (cur === maybeAncestor) return true
			seen.add(cur)
			cur = nodes.get(cur)?.parent
		}
		return false
	}

	const addEdge = (from: string, to: string, link: LinkInfo, from0: number, to0: number) => {
		if (link.invisible) return
		const pair = `${from}->${to}`
		const n = pairCount.get(pair) ?? 0
		pairCount.set(pair, n + 1)
		const edge: IREdge = {
			key: link.id ?? `${pair}#${n}`,
			from,
			to,
			arrow: { start: link.start ? 'arrow' : 'none', end: link.end ? 'arrow' : 'none' },
			line: { dash: link.dotted ? 'dotted' : 'solid' },
			span: { from: from0, to: to0, line: lineOf(src, from0) },
		}
		if (link.label) edge.label = link.label
		ir.edges.push(edge)
	}

	const stmts = splitStatements(body)
	let idx = 0

	// Header.
	const first = stmts[0]
	if (!first) {
		diag(0, 0, 'Empty mermaid diagram', 'warning')
		return { ir, diagnostics }
	}
	const header = /^(flowchart(?:-elk)?|graph)\b\s*([A-Za-z]{2})?\s*(.*)$/.exec(first.text)
	if (header) {
		idx = 1
		const dir = header[2]?.toUpperCase()
		if (dir) {
			if (DIRECTIONS[dir]) ir.direction = DIRECTIONS[dir]
			else diag(first.from, first.from + first.text.length, `Unknown direction '${header[2]}'`, 'warning')
		}
		if (header[3]) {
			// e.g. `graph TD A-->B` on one line: treat the rest as a statement.
			stmts[0] = { text: header[3], from: first.from + first.text.length - header[3].length }
			idx = 0
		}
	} else {
		const kw = first.text.split(/\s+/)[0]
		if (kw === 'sequenceDiagram') return parseMermaidSequence(body, ir.title)
		if (kw === 'erDiagram') return parseMermaidErd(body, ir.title)
		if (UNSUPPORTED.includes(kw)) {
			diag(first.from, first.from + kw.length, `Unsupported mermaid diagram type '${kw}': only flowchart/graph, sequenceDiagram and erDiagram can be imported`)
			return { ir, diagnostics }
		}
		diag(first.from, first.from + first.text.length, "Missing 'flowchart' header; assuming 'flowchart TD'", 'warning')
	}

	for (; idx < stmts.length; idx++) {
		const st = stmts[idx]
		const t = st.text
		const end = st.from + t.length
		let m: RegExpExecArray | null
		if (/^subgraph(\s|$)/.test(t)) {
			parseSubgraph(t.slice(8).trim(), st.from)
		} else if (t === 'end') {
			if (stack.length) stack.pop()
			else diag(st.from, end, "'end' without matching 'subgraph'")
		} else if ((m = /^direction\s+(\w+)\s*$/.exec(t))) {
			if (stack.length === 0) {
				const d = DIRECTIONS[m[1].toUpperCase()]
				if (d) ir.direction = d
				else diag(st.from, end, `Unknown direction '${m[1]}'`, 'warning')
			}
		} else if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(t))) {
			const style = parseStyleProps(m[2])
			for (const name of m[1].split(',')) classDefs.set(name.trim(), style)
		} else if ((m = /^class\s+(.+?)\s+(\S+)\s*$/.exec(t))) {
			const cls = m[2]
			for (const id of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
				addClass(id, cls)
			}
		} else if ((m = /^style\s+(\S+)\s+(.*)$/.exec(t))) {
			directStyles.set(m[1], { ...directStyles.get(m[1]), ...parseStyleProps(m[2]) })
		} else if (/^(linkStyle|click|accTitle|accDescr|callback|call|href)\b/.test(t)) {
			// Intentionally ignored.
		} else {
			parseChain(t, st.from)
		}
	}
	if (stack.length) diag(src.length, src.length, `Unclosed subgraph '${stack[stack.length - 1]}'`)

	// Resolve styles.
	const defaultStyle = classDefs.get('default')
	for (const n of ir.nodes) {
		let style: IRStyle = {}
		if (defaultStyle) style = { ...defaultStyle }
		for (const c of nodeClasses.get(n.key) ?? []) {
			const s = classDefs.get(c)
			if (s) style = { ...style, ...s }
		}
		const d = directStyles.get(n.key)
		if (d) style = { ...style, ...d }
		if (style.color || style.dash) n.style = style
	}

	return { ir, diagnostics }

	function addClass(id: string, cls: string) {
		const list = nodeClasses.get(id) ?? []
		list.push(cls)
		nodeClasses.set(id, list)
	}

	function parseSubgraph(rest: string, from: number) {
		let key: string
		let label: string | undefined
		let m: RegExpExecArray | null
		if (!rest) {
			key = `subgraph_${++subgraphCounter}`
		} else if ((m = /^([^\s\[\]"]+)\s*\[(.*)\]\s*$/.exec(rest))) {
			key = m[1]
			label = cleanLabel(m[2])
		} else if ((m = /^([^\s\[\]"]+)$/.exec(rest))) {
			key = m[1]
		} else {
			label = cleanLabel(rest)
			key = label.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '') || `subgraph_${++subgraphCounter}`
		}
		const n = touch(key, from, from + 8 + rest.length + 1)
		n.isContainer = true
		if (label !== undefined) n.label = label
		stack.push(key)
	}

	function parseChain(s: string, base: number) {
		let i = 0
		const ws = () => {
			while (i < s.length && /\s/.test(s[i])) i++
		}
		const err = (msg: string) => diag(base + i, base + s.length, msg)

		const readId = (): string | null => {
			const start = i
			while (i < s.length) {
				const c = s[i]
				if (ID_STOP.test(c)) break
				if (c === '-' || c === '=' || c === '~' || c === '.') {
					const nx = s[i + 1]
					if (nx === undefined || nx === '-' || nx === '.' || nx === '=' || nx === '>' || nx === '~') break
				}
				i++
			}
			return i > start ? s.slice(start, i) : null
		}

		/** Read a label at i up to one of the closers; returns which closer matched. */
		const readLabel = (closers: string[]): { label: string; closer: string } | null => {
			const save = i
			let j = i
			while (j < s.length && s[j] === ' ') j++
			if (s[j] === '"') {
				const q = s.indexOf('"', j + 1)
				if (q > 0) {
					let k = q + 1
					while (k < s.length && s[k] === ' ') k++
					for (const c of closers) {
						if (s.startsWith(c, k)) {
							i = k + c.length
							return { label: cleanLabel(s.slice(j, q + 1)), closer: c }
						}
					}
				}
			}
			let best = -1
			let bestC = ''
			for (const c of closers) {
				const p = s.indexOf(c, save)
				if (p >= 0 && (best < 0 || p < best)) {
					best = p
					bestC = c
				}
			}
			if (best < 0) return null
			i = best + bestC.length
			return { label: cleanLabel(s.slice(save, best)), closer: bestC }
		}

		const SHAPES: [string, string[], NodeShape | ((closer: string) => NodeShape)][] = [
			['(((', [')))'], 'ellipse'],
			['((', ['))'], 'ellipse'],
			['([', ['])'], 'oval'],
			['(', [')'], 'oval'],
			['[[', [']]'], 'rectangle'],
			['[(', [')]'], 'cylinder'],
			['[/', ['/]', '\\]'], (c) => (c === '/]' ? 'parallelogram' : 'trapezoid')],
			['[\\', ['\\]', '/]'], (c) => (c === '\\]' ? 'parallelogram' : 'trapezoid')],
			['[', [']'], 'rectangle'],
			['{{', ['}}'], 'hexagon'],
			['{', ['}'], 'diamond'],
			['>', [']'], 'rectangle'],
		]

		const readShape = (): ShapeInfo | null => {
			if (s.startsWith('@{', i)) {
				let depth = 0
				let j = i + 1
				let quote = false
				for (; j < s.length; j++) {
					const c = s[j]
					if (quote) {
						if (c === '"') quote = false
						continue
					}
					if (c === '"') quote = true
					else if (c === '{') depth++
					else if (c === '}') {
						depth--
						if (depth === 0) break
					}
				}
				if (j >= s.length) {
					err("Unclosed '@{'")
					i = s.length
					return null
				}
				const inner = s.slice(i + 2, j)
				i = j + 1
				const info: ShapeInfo = { shape: 'rectangle' }
				for (const part of splitTopLevel(inner, ',\n')) {
					const k = part.indexOf(':')
					if (k < 0) continue
					const key = part.slice(0, k).trim()
					const val = cleanLabel(part.slice(k + 1).trim().replace(/^'(.*)'$/, '"$1"'))
					if (key === 'shape') {
						const sh = V11_SHAPES[val.toLowerCase()]
						if (sh) info.shape = sh
						else diag(base, base + s.length, `Unknown mermaid shape '${val}', using rectangle`, 'warning')
					} else if (key === 'label') info.label = val
					else if (key === 'icon') info.icon = val
				}
				return info
			}
			for (const [open, closers, shape] of SHAPES) {
				if (!s.startsWith(open, i)) continue
				i += open.length
				const r = readLabel(closers)
				if (!r) {
					err(`Missing '${closers[0]}' to close node shape`)
					i = s.length
					return null
				}
				return { shape: typeof shape === 'function' ? shape(r.closer) : shape, label: r.label }
			}
			return null
		}

		const readNode = (): string | null => {
			const start = i
			const id = readId()
			if (!id) return null
			const info = readShape()
			const n = touch(id, base + start, base + i)
			if (info) {
				if (info.shape) n.shape = info.shape
				if (info.label !== undefined) n.label = info.label
				if (info.icon) n.icon = info.icon
			}
			const cm = /^:::([\w-]+)/.exec(s.slice(i))
			if (cm) {
				addClass(id, cm[1])
				i += cm[0].length
			}
			return id
		}

		const readGroup = (): string[] | null => {
			const ids: string[] = []
			for (;;) {
				ws()
				const id = readNode()
				if (!id) return ids.length ? ids : null
				ids.push(id)
				ws()
				if (s[i] === '&') {
					i++
					continue
				}
				return ids
			}
		}

		const readLink = (): LinkInfo | null => {
			const rest = s.slice(i)
			let id: string | undefined
			let off = 0
			const idm = /^([A-Za-z_][\w-]*)@(?=[-=<~xo.])/.exec(rest)
			if (idm) {
				id = idm[1]
				off = idm[0].length
			}
			const r = rest.slice(off)
			const full = /^([<xo])?(?:(-{2,})|(={2,})|(-\.+-)|(~{3,}))([>xo])?/.exec(r)
			const startOk = (m: RegExpExecArray) => !m[1] || m[1] === '<' || i === 0 || /\s/.test(s[i - 1])
			if (full && startOk(full)) {
				let len = full[0].length
				let endHead: string | undefined = full[6]
				if (endHead && endHead !== '>' && /[\w]/.test(r[len] ?? '')) {
					endHead = undefined
					len--
				}
				const body = full[2] ?? full[3] ?? full[4] ?? full[5]
				const isTextOpen = !endHead && (body === '--' || body === '==')
				if (!isTextOpen) {
					i += off + len
					const link: LinkInfo = {
						start: !!full[1],
						end: !!endHead,
						dotted: !!full[4],
						invisible: !!full[5],
						id,
					}
					const lm = /^\s*\|\s*("[^"]*"|[^|]*)\s*\|/.exec(s.slice(i))
					if (lm) {
						link.label = cleanLabel(lm[1])
						i += lm[0].length
					}
					return link
				}
			}
			// Text form: `-- text -->`, `== text ==>`, `-. text .->`.
			const open = /^(<)?(--|==|-\.)/.exec(r)
			if (open) {
				const kind = open[2]
				const after = i + off + open[0].length
				const closeRe = kind === '--' ? /-{2,}[>xo]|-{3,}/g : kind === '==' ? /={2,}[>xo]|={3,}/g : /\.-+[>xo]?/g
				closeRe.lastIndex = after
				const cm = closeRe.exec(s)
				if (cm) {
					const label = cleanLabel(s.slice(after, cm.index))
					i = cm.index + cm[0].length
					const last = cm[0][cm[0].length - 1]
					const link: LinkInfo = {
						start: !!open[1],
						end: last === '>' || last === 'x' || last === 'o',
						dotted: kind === '-.',
						invisible: false,
						id,
					}
					if (label) link.label = label
					return link
				}
			}
			return null
		}

		let prev = readGroup()
		if (!prev) {
			err(`Unexpected '${s.slice(i, i + 20)}'`)
			return
		}
		for (;;) {
			ws()
			if (i >= s.length) break
			const linkStart = i
			const link = readLink()
			if (!link) {
				err(`Unexpected '${s.slice(i, i + 20)}'`)
				return
			}
			ws()
			const next = readGroup()
			if (!next) {
				diag(base + linkStart, base + s.length, 'Edge is missing its target node')
				return
			}
			for (const a of prev) for (const b of next) addEdge(a, b, link, base, base + s.length)
			prev = next
		}
	}
}
