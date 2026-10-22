/**
 * Deterministic parser for ASCII / Unicode box diagrams as produced by chat
 * LLMs (ChatGPT, Claude, Gemini): boxes, arrows, labels, groups, bracket nodes,
 * inline arrow chains and directory trees.
 *
 * Pre-passes: markdown schema tables (→ ERD, `table.ts`) and directory trees.
 * Pipeline: normalise → char grid (per-line wide-char choice, `width.ts`) →
 * rectangles (corner tracing, border drift up to ±4 cols) + diamonds
 * (`diamond.ts`) → sequence check (`sequence.ts`) → cell classification →
 * line graph (┼ / + start as crossings, merged back when they are forks) →
 * terminals (what each line end touches) → inline labels / text nodes (step
 * numbers stripped) → edges → nearby / branch labels.
 *
 * Never throws. `confidence` (0..1) says how much of the text was explained.
 */
import { emptyIR, type Diagnostic, type IREdge, type IRNode, type NodeShape, type ParseResult } from '../ir'
import type { CellRect } from '../import/pins'
import { findDiamonds } from './diamond'
import { parseSequence } from './sequence'
import { parseMarkdownErd } from './table'
import { buildGrid, FILLER } from './width'

export type AsciiResult = ParseResult & {
	confidence: number
	/** Where each node sat in the text grid (node key → cell rectangle); feeds layout pins. */
	cells?: Record<string, CellRect>
}

// ---------------------------------------------------------------------------
// Directions and glyph tables

const N = 1
const E = 2
const S = 4
const W = 8
const DIRS = [N, E, S, W] as const
const DR: Record<number, number> = { [N]: -1, [E]: 0, [S]: 1, [W]: 0 }
const DC: Record<number, number> = { [N]: 0, [E]: 1, [S]: 0, [W]: -1 }
const OPP: Record<number, number> = { [N]: S, [E]: W, [S]: N, [W]: E }
const isVert = (d: number) => d === N || d === S

const UNI: Record<string, number> = {}
const addUni = (chars: string, mask: number) => {
	for (const ch of chars) UNI[ch] = mask
}
addUni('─━═┄┅┈┉╌╍╴╶╼╾', E | W)
addUni('│┃║┆┇┊┋╎╏╵╷╽╿', N | S)
addUni('┌┏╔╭┍┎╒╓', E | S)
addUni('┐┓╗╮┑┒╕╖', W | S)
addUni('└┗╚╰┕┖╘╙', N | E)
addUni('┘┛╝╯┙┚╛╜', N | W)
addUni('├┣╠┝┞┟┠┡┢╞╟', N | S | E)
addUni('┤┫╣┥┦┧┨┩┪╡╢', N | S | W)
addUni('┬┳╦┯┭┮┰┱┲╤╥', E | W | S)
addUni('┴┻╩┷┵┶┸┹┺╧╨', E | W | N)
addUni('┼╋╬┿╀╁╂╃╄╅╆╇╈╉╊╪╫', N | E | S | W)

const DASHED = new Set([...'┄┅┈┉╌╍┆┇┊┋╎╏'])

/** Unicode arrowheads → the direction they point. */
const UNI_HEADS: Record<string, number> = {}
const addHead = (chars: string, d: number) => {
	for (const ch of chars) UNI_HEADS[ch] = d
}
addHead('▶►▸▷→⟶⇒⮕➜➔➝➞➡⟹', E)
addHead('◀◄◂◁←⟵⇐⬅⟸', W)
addHead('▲▴△↑⬆⇑', N)
addHead('▼▾▽↓⬇⇓', S)

const TL = new Set([...'┌┏╔╭┍┎╒╓+.', ...'├┬┼╠╦╬┣┳╋'])
const TR = new Set([...'┐┓╗╮┑┒╕╖+.', ...'┤┬┼╣╦╬┫┳╋'])
const BL = new Set([...'└┗╚╰┕┖╘╙+\'`', ...'├┴┼╠╩╬┣┻╋'])
const BR = new Set([...'┘┛╝╯┙┚╛╜+\'', ...'┤┴┼╣╩╬┫┻╋'])
const JUNCTION = new Set([...'├┤┬┴┼╠╣╦╩╬┣┫┳┻╋'])
const CROSS_CHARS = new Set([...'┼╋╬┿╂╪╫+'])
const HB = new Set([...'─━═┄┅┈┉╌╍-=~_', ...'┬┴┼╦╩╬┳┻╋┯┷┿╤╧╪+'])
const VB = new Set([...'│┃║┆┇┊┋╎╏|:', ...'├┤┼╠╣╬┣┫╋┝┥┿╞╡╟╢+'])

const ASCII_H = new Set([...'-=~'])

const isAlnum = (ch: string) => /[\p{L}\p{N}]/u.test(ch)

// ---------------------------------------------------------------------------
// Normalisation

export function stripFence(text: string): string {
	const m = /^\s*(```+|~~~+)[^\n]*\n([\s\S]*?)(?:\n\s*\1[ \t]*(?:\n[\s\S]*)?)?$/.exec(text)
	return m ? m[2] : text
}

interface Prepared {
	lines: string[]
	/** Original offset of each prepared line's first column. */
	offsets: number[]
}

function prepare(text: string): Prepared {
	const fenceOff = (() => {
		const m = /^\s*(```+|~~~+)[^\n]*\n/.exec(text)
		return m ? m[0].length : 0
	})()
	const body = stripFence(text)
	const raw = body.split('\n')
	let off = fenceOff
	const items: { line: string; off: number }[] = []
	for (const l of raw) {
		const cleaned = l
			.replace(/\r$/, '')
			.replace(/[‍︎️​]/g, '')
		let expanded = ''
		for (const ch of cleaned) {
			if (ch === '\t') expanded += ' '.repeat(4 - (expanded.length % 4))
			else if (ch === ' ') expanded += ' '
			else expanded += ch
		}
		items.push({ line: expanded.replace(/\s+$/, ''), off })
		off += l.length + 1
	}
	while (items.length && !items[0].line) items.shift()
	while (items.length && !items[items.length - 1].line) items.pop()
	let indent = Infinity
	for (const it of items) if (it.line) indent = Math.min(indent, it.line.length - it.line.trimStart().length)
	if (!isFinite(indent)) indent = 0
	return {
		lines: items.map((it) => it.line.slice(indent)),
		offsets: items.map((it) => it.off + indent),
	}
}

// ---------------------------------------------------------------------------
// Directory trees

const TREE_RE = /^([\s│|]*)(├──|└──|├─|└─|┣━|┗━|\|--|\|──|\+--|\+──|`--|`──|\\--)[-─━]*[ \t]?([\p{L}\p{N}._@~$\[(\/"'].*)$/u
const isTreeLine = (l: string) => {
	const m = TREE_RE.exec(l)
	return !!m && !/[+|│┐┘┤>▶]\s*$/.test(m[3]) && !/(-->|->|──▶|─>)/.test(m[3])
}

function cleanTreeName(s: string): string {
	return s
		.split(/\s+(?:#|\/\/|<-+|←|⟵|—|--)\s*/)[0]
		.trim()
}

function parseTree(lines: string[]): AsciiResult | null {
	const nonEmpty = lines.filter((l) => l.trim())
	const treeLines = nonEmpty.filter(isTreeLine)
	if (treeLines.length < 2) return null
	const other = nonEmpty.filter((l) => !isTreeLine(l) && !/^[\s│|]+$/.test(l))
	// Allow root lines (no connector) but not much else.
	if (other.length > Math.max(1, treeLines.length / 3)) return null

	const ir = emptyIR('flowchart')
	ir.direction = 'right'
	const keys = new KeyAllocator()
	const stack: { col: number; key: string }[] = []
	const cells: Record<string, CellRect> = {}
	let root: string | undefined
	let pairs = 0
	let row = 0
	for (const line of lines) {
		row++
		if (!line.trim() || /^[\s│|]+$/.test(line)) continue
		const m = isTreeLine(line) ? TREE_RE.exec(line) : null
		let col: number
		let name: string
		if (m) {
			col = [...m[1]].length
			name = cleanTreeName(m[3])
		} else {
			col = -1
			name = cleanTreeName(line.trim())
		}
		if (!name) continue
		const key = keys.unique(name)
		const node: IRNode = { key }
		if (key !== name) node.label = name
		ir.nodes.push(node)
		cells[key] = { row: row - 1, col: Math.max(0, col) + (m ? m[2].length + 1 : 0), rows: 1, cols: [...name].length }
		if (col < 0) {
			stack.length = 0
			root = key
			stack.push({ col: -1, key })
			continue
		}
		while (stack.length && stack[stack.length - 1].col >= col) stack.pop()
		const parent = stack[stack.length - 1]?.key ?? root
		if (parent) {
			ir.edges.push({
				key: `${parent}->${key}#0`,
				from: parent,
				to: key,
				arrow: { start: 'none', end: 'none' },
				line: { dash: 'solid' },
			})
			pairs++
		}
		stack.push({ col, key })
	}
	return { ir, diagnostics: [], confidence: pairs ? 0.95 : 0.5, cells }
}

class KeyAllocator {
	used = new Set<string>()
	unique(label: string): string {
		const base = label || 'Box'
		if (!this.used.has(base) && label) {
			this.used.add(base)
			return base
		}
		for (let n = label ? 2 : 1; ; n++) {
			const k = `${base} ${n}`
			if (!this.used.has(k)) {
				this.used.add(k)
				return k
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Boxes

interface Box {
	id: number
	top: number
	bottom: number
	/** Left / right border column per row (top..bottom). */
	lefts: number[]
	rights: number[]
	title: string
	dividers: number[]
	parent?: number
	children: number[]
	key?: string
	cost: number
	shape?: NodeShape
}

const leftAt = (b: Box, r: number) => b.lefts[r - b.top]
const rightAt = (b: Box, r: number) => b.rights[r - b.top]
const minLeft = (b: Box) => Math.min(...b.lefts)
const maxRight = (b: Box) => Math.max(...b.rights)

function inInterior(b: Box, r: number, c: number): boolean {
	return r > b.top && r < b.bottom && c > leftAt(b, r) && c < rightAt(b, r)
}

// ---------------------------------------------------------------------------
// Main

interface Terminal {
	comp: number
	r: number
	c: number
	dir: number
	head: boolean
	kind: 'box' | 'text' | 'dangling'
	box?: number
	run?: number
}

interface Run {
	id: number
	r: number
	c0: number
	c1: number
	text: string
	box?: number
	consumed?: 'leaf' | 'title' | 'node' | 'label'
	nodeKey?: string
}

export function parseAscii(text: string): AsciiResult {
	try {
		return parseAsciiInner(text)
	} catch (e) {
		return {
			ir: emptyIR('flowchart'),
			diagnostics: [{ from: 0, to: text.length, severity: 'error', message: `ASCII parser failed: ${(e as Error).message}` }],
			confidence: 0,
		}
	}
}

function parseAsciiInner(text: string): AsciiResult {
	const { lines, offsets } = prepare(text)
	const diagnostics: Diagnostic[] = []
	const fail = (message: string): AsciiResult => ({
		ir: emptyIR('flowchart'),
		diagnostics: [{ from: 0, to: text.length, severity: 'error', message }],
		confidence: 0,
	})
	if (!lines.length) return fail('No diagram found: empty text')

	const erd = parseMarkdownErd(lines.join('\n'))
	if (erd) return { ir: erd.ir, diagnostics: [], confidence: erd.confidence }

	const tree = parseTree(lines)
	if (tree) return tree

	const g = buildGrid(lines)
	const R = g.length
	const at = (r: number, c: number): string => (r >= 0 && r < R && c >= 0 ? (g[r][c] ?? ' ') : ' ')
	const posOffset = (r: number, c: number) => (offsets[r] ?? 0) + Math.min(c, (lines[r] ?? '').length)

	// --- 1. Boxes ------------------------------------------------------------
	const boxes = findBoxes(g, at)
	const borderOf = new Map<number, number>()
	const W_ = Math.max(...g.map((row) => row.length), 0) + 4
	const cid = (r: number, c: number) => r * W_ + c
	for (const b of boxes) {
		for (let r = b.top; r <= b.bottom; r++) {
			const l = leftAt(b, r)
			const rr = rightAt(b, r)
			if (r === b.top || r === b.bottom || b.dividers.includes(r)) {
				for (let c = l; c <= rr; c++) borderOf.set(cid(r, c), b.id)
			} else {
				borderOf.set(cid(r, l), b.id)
				borderOf.set(cid(r, rr), b.id)
			}
		}
	}
	// Containment tree.
	for (const b of boxes) {
		let best: Box | undefined
		for (const o of boxes) {
			if (o === b) continue
			if (o.top < b.top && o.bottom > b.bottom && minLeft(o) < minLeft(b) && maxRight(o) > maxRight(b)) {
				if (!best || (best.bottom - best.top) * (maxRight(best) - minLeft(best)) > (o.bottom - o.top) * (maxRight(o) - minLeft(o))) best = o
			}
		}
		if (best) {
			b.parent = best.id
			best.children.push(b.id)
		}
	}
	const seq = parseSequence(
		g,
		boxes.map((b) => ({ top: b.top, bottom: b.bottom, left: minLeft(b), right: maxRight(b) })),
		(r, c) => borderOf.has(cid(r, c)),
	)
	if (seq) return { ir: seq.ir, diagnostics: [], confidence: seq.confidence }
	const boxById = new Map(boxes.map((b) => [b.id, b]))
	const leafAt = (r: number, c: number): Box | undefined => {
		for (const b of boxes) if (!b.children.length && inInterior(b, r, c)) return b
		return undefined
	}
	const innermostAt = (r: number, c: number): Box | undefined => {
		let best: Box | undefined
		for (const b of boxes) if (inInterior(b, r, c) && (!best || isInside(b, best))) best = b
		return best
	}
	const isInside = (a: Box, b: Box): boolean => {
		let p = a.parent
		while (p !== undefined) {
			if (p === b.id) return true
			p = boxById.get(p)?.parent
		}
		return false
	}
	const leafCell = new Set<number>()
	for (const b of boxes) {
		if (b.children.length) continue
		for (let r = b.top + 1; r < b.bottom; r++) for (let c = leftAt(b, r) + 1; c < rightAt(b, r); c++) leafCell.add(cid(r, c))
	}

	// --- 2. Cell classification ----------------------------------------------
	const conn = new Map<number, number>()
	const tip = new Map<number, number>()
	const dashed = new Set<number>()
	const isBorder = (r: number, c: number) => borderOf.has(cid(r, c))
	const usable = (r: number, c: number) => !isBorder(r, c) && !leafCell.has(cid(r, c))

	/** Does the raw glyph at (r,c) offer a connection in direction d? */
	const offers = (r: number, c: number, d: number, strict = false): boolean => {
		const ch = at(r, c)
		if (UNI[ch] !== undefined) return (UNI[ch] & d) !== 0
		if (ASCII_H.has(ch)) return d === E || d === W
		if (ch === '|') return d === N || d === S
		if (ch === '+') return !strict
		const h = UNI_HEADS[ch]
		if (h !== undefined) return OPP[h] === d
		if (ch === '>') return d === W
		if (ch === '<') return d === E
		if (ch === '^') return d === S
		if ((ch === 'v' || ch === 'V') && !isAlnum(at(r, c - 1)) && !isAlnum(at(r, c + 1))) return d === N
		return false
	}
	const vertOffer = (r: number, c: number, d: number) => {
		// Allow ±1 column jitter for vertical neighbours.
		return offers(r, c, d) || offers(r, c - 1, d, true) || offers(r, c + 1, d, true)
	}

	// Dashed ASCII runs: `- - ->`, `<- - -`, `.....>`, `-.-.->`.
	const dashedAscii = new Set<number>()
	for (let r = 0; r < R; r++) {
		const row = g[r]
		for (let c = 0; c < row.length; c++) {
			if (row[c] === '-' && at(r, c + 1) === ' ') {
				let k = c
				let n = 0
				while (at(r, k) === '-' && at(r, k + 1) === ' ' && (at(r, k + 2) === '-' || at(r, k + 2) === '>')) {
					k += 2
					n++
				}
				if (n >= 2 && (at(r, k) === '>' || at(r, k + 1) === '>' || at(r, c - 1) === '<' || at(r, c - 2) === '<')) {
					for (let x = c; x <= k; x += 2) if (at(r, x) === '-') dashedAscii.add(cid(r, x))
					c = k
				}
			} else if (row[c] === '.' && at(r, c + 1) === '.') {
				let k = c
				while (at(r, k + 1) === '.' || at(r, k + 1) === '-') k++
				if (k - c >= 2 && (at(r, k + 1) === '>' || at(r, c - 1) === '<' || at(r, c - 1) === '-')) {
					for (let x = c; x <= k; x++) dashedAscii.add(cid(r, x))
					c = k
				}
			}
		}
	}

	for (let r = 0; r < R; r++) {
		for (let c = 0; c < g[r].length; c++) {
			const ch = g[r][c]
			if (ch === ' ' || ch === FILLER || !usable(r, c)) continue
			const id = cid(r, c)
			if (dashedAscii.has(id)) {
				conn.set(id, E | W)
				dashed.add(id)
				continue
			}
			if (UNI[ch] !== undefined) {
				conn.set(id, UNI[ch])
				if (DASHED.has(ch)) dashed.add(id)
				continue
			}
			if (UNI_HEADS[ch] !== undefined) {
				tip.set(id, UNI_HEADS[ch])
				conn.set(id, OPP[UNI_HEADS[ch]])
				continue
			}
			if (ASCII_H.has(ch)) {
				if (offers(r, c - 1, E) || offers(r, c + 1, W)) conn.set(id, E | W)
				continue
			}
			if (ch === '|') {
				const alone = g[r].every((x, k) => k === c || x === ' ')
				if (alone || vertOffer(r - 1, c, S) || vertOffer(r + 1, c, N) || isBorder(r - 1, c) || isBorder(r + 1, c)) conn.set(id, N | S)
				continue
			}
			if (ch === '+') {
				let m = 0
				for (const d of DIRS) {
					const nr = r + DR[d]
					const nc = c + DC[d]
					if (offers(nr, nc, OPP[d], true)) m |= d
				}
				if (popcount(m) >= 2) conn.set(id, m)
				continue
			}
			if (ch === '>' || ch === '<') {
				const d = ch === '>' ? E : W
				const body = OPP[d]
				const br = c + DC[body]
				const isH = (cc: number) =>
					ASCII_H.has(at(r, cc)) || dashedAscii.has(cid(r, cc)) || (UNI[at(r, cc)] !== undefined && (UNI[at(r, cc)] & d) !== 0)
				if (isH(br) || (at(r, br) === ' ' && isH(br + DC[body]) && ASCII_H.has(at(r, br + DC[body])))) {
					tip.set(id, d)
					conn.set(id, body)
				}
				continue
			}
			if (ch === '^') {
				if (vertOffer(r + 1, c, N)) {
					tip.set(id, N)
					conn.set(id, S)
				}
				continue
			}
			if (ch === 'v' || ch === 'V') {
				if (!isAlnum(at(r, c - 1)) && !isAlnum(at(r, c + 1)) && vertOffer(r - 1, c, S)) {
					tip.set(id, S)
					conn.set(id, N)
				}
				continue
			}
			if (ch === '.' || ch === "'" || ch === '`' || ch === ',') {
				let h = 0
				let v = 0
				if (offers(r, c - 1, E, true) && at(r, c - 1) !== '+') h |= W
				if (offers(r, c + 1, W, true) && at(r, c + 1) !== '+') h |= E
				if (at(r - 1, c) === '|' || (UNI[at(r - 1, c)] ?? 0) & S) v |= N
				if (at(r + 1, c) === '|' || (UNI[at(r + 1, c)] ?? 0) & N) v |= S
				if (h && v) conn.set(id, h | v)
				continue
			}
		}
	}
	// Second pass for ASCII H runs adjacent only to other ASCII H cells already resolved.
	// (Handled by `offers`, which treats any '-' as offering E/W.)

	const isLine = (r: number, c: number) => conn.has(cid(r, c))
	const connAt = (r: number, c: number) => conn.get(cid(r, c)) ?? 0

	// --- 3. Line graph -------------------------------------------------------
	const parent = new Map<number, number>()
	const find = (x: number): number => {
		let p = parent.get(x) ?? x
		if (p !== x) {
			p = find(p)
			parent.set(x, p)
		}
		return p
	}
	const union = (a: number, b: number) => {
		const ra = find(a)
		const rb = find(b)
		if (ra !== rb) parent.set(ra, rb)
	}
	const linked = new Map<number, number>()
	// Four-way cells (┼, +) start out as crossings: the horizontal and the
	// vertical line through them are separate components (`part`). They are
	// merged back into a junction after terminals are known (see 6b).
	const HALF = (R + 4) * W_
	const crossing = new Set<number>()
	for (const [id, m] of conn) {
		if (m !== (N | E | S | W)) continue
		const [r, c] = [Math.floor(id / W_), id % W_]
		if (CROSS_CHARS.has(at(r, c))) crossing.add(id)
	}
	const part = (id: number, d: number) => (crossing.has(id) && !isVert(d) ? id + HALF : id)
	const markLink = (a: number, d: number, b: number, bd: number) => {
		linked.set(a, (linked.get(a) ?? 0) | d)
		linked.set(b, (linked.get(b) ?? 0) | bd)
		union(part(a, d), part(b, bd))
	}
	const cellsByComp = new Map<number, number[]>()
	const coords = (id: number): [number, number] => [Math.floor(id / W_), id % W_]

	for (const [id, m] of conn) {
		const [r, c] = coords(id)
		for (const d of DIRS) {
			if (!(m & d)) continue
			if ((linked.get(id) ?? 0) & d) continue
			const nr = r + DR[d]
			const nc = c + DC[d]
			if (isLine(nr, nc) && connAt(nr, nc) & OPP[d]) {
				markLink(id, d, cid(nr, nc), OPP[d])
				continue
			}
			if (isVert(d)) {
				// ±1 column jitter on vertical runs.
				for (const dc of [-1, 1]) {
					const jc = c + dc
					if (isLine(nr, jc) && connAt(nr, jc) & OPP[d] && !isLine(r, jc) && !isLine(nr, c)) {
						markLink(id, d, cid(nr, jc), OPP[d])
						break
					}
				}
			} else {
				// Bridge a one-cell gap: `──── ▶`, `- - ->`.
				const gc = c + 2 * DC[d]
				if (at(nr, nc) === ' ' && isLine(r, gc) && connAt(r, gc) & OPP[d]) {
					markLink(id, d, cid(r, gc), OPP[d])
					dashed.add(id)
					continue
				}
			}
			// Pass through a container border: `──│──` → one line.
			const bId = borderOf.get(cid(nr, nc))
			if (bId !== undefined && boxById.get(bId)!.children.length) {
				const br = r + 2 * DR[d]
				const bc = c + 2 * DC[d]
				if (isLine(br, bc) && connAt(br, bc) & OPP[d]) markLink(id, d, cid(br, bc), OPP[d])
			}
		}
	}
	for (const id of conn.keys()) {
		for (const p of crossing.has(id) ? [id, id + HALF] : [id]) {
			const root = find(p)
			const list = cellsByComp.get(root) ?? []
			list.push(id)
			cellsByComp.set(root, list)
		}
	}

	// --- 4. Text runs --------------------------------------------------------
	const runs: Run[] = []
	const runAt = new Map<number, number>()
	const isTextCell = (r: number, c: number) => {
		const ch = at(r, c)
		return ch !== ' ' && ch !== FILLER && !isBorder(r, c) && !isLine(r, c)
	}
	for (let r = 0; r < R; r++) {
		let c = 0
		const len = g[r].length
		while (c < len) {
			if (!isTextCell(r, c)) {
				c++
				continue
			}
			const c0 = c
			let c1 = c
			const box = leafAt(r, c) ?? innermostAt(r, c)
			while (c1 + 1 < len) {
				if (isTextCell(r, c1 + 1)) c1++
				else if (at(r, c1 + 1) === ' ' && isTextCell(r, c1 + 2) && !isBorder(r, c1 + 1)) c1 += 2
				else if (g[r][c1 + 1] === FILLER) c1++
				else break
			}
			const textStr = g[r]
				.slice(c0, c1 + 1)
				.filter((ch) => ch !== FILLER)
				.join('')
				.trim()
			const run: Run = { id: runs.length, r, c0, c1, text: textStr, box: box?.id }
			runs.push(run)
			for (let k = c0; k <= c1; k++) runAt.set(cid(r, k), run.id)
			c = c1 + 1
		}
	}

	// --- 5. Box labels -------------------------------------------------------
	const ir = emptyIR('flowchart')
	const keys = new KeyAllocator()
	const nodeByKey = new Map<string, IRNode>()
	const keyByLabel = new Map<string, string>()
	const ordered = [...boxes].sort((a, b) => a.top - b.top || minLeft(a) - minLeft(b))
	for (const b of ordered) {
		let label = ''
		if (!b.children.length) {
			const sections: string[][] = [[]]
			for (let r = b.top + 1; r < b.bottom; r++) {
				if (b.dividers.includes(r)) {
					sections.push([])
					continue
				}
				const row = g[r].slice(leftAt(b, r) + 1, rightAt(b, r)).filter((ch) => ch !== FILLER).join('').trim()
				if (row && !/^[─━═\-=┄╌]+$/.test(row)) sections[sections.length - 1].push(row)
			}
			const first = sections.find((s) => s.length) ?? []
			label = b.title || first.join(' ')
			for (const run of runs) if (run.box === b.id) run.consumed = 'leaf'
		} else {
			label = b.title
			if (!label) {
				const childTop = Math.min(...b.children.map((id) => boxById.get(id)!.top))
				const own = runs.filter((run) => run.box === b.id && run.r < childTop)
				if (own.length) {
					const firstRow = Math.min(...own.map((run) => run.r))
					const titleRuns = own.filter((run) => run.r === firstRow)
					label = titleRuns.map((run) => run.text).join(' ')
					for (const run of titleRuns) run.consumed = 'title'
				}
			}
		}
		label = label.replace(/\s+/g, ' ').trim()
		const key = keys.unique(label)
		b.key = key
		const node: IRNode = { key }
		if (label && key !== label) node.label = label
		if (b.children.length) node.isContainer = true
		if (b.shape) node.shape = b.shape
		node.span = { from: posOffset(b.top, leftAt(b, b.top)), to: posOffset(b.bottom, rightAt(b, b.bottom) + 1), line: b.top + 1 }
		nodeByKey.set(key, node)
		if (label && !keyByLabel.has(label)) keyByLabel.set(label, key)
		ir.nodes.push(node)
	}
	for (const b of boxes) if (b.parent !== undefined) nodeByKey.get(b.key!)!.parent = boxById.get(b.parent)!.key

	// --- 6. Terminals --------------------------------------------------------
	const terminals: Terminal[] = []
	const probe = (r: number, c: number, d: number): Omit<Terminal, 'comp' | 'r' | 'c' | 'dir' | 'head'> | null => {
		const maxK = isVert(d) ? 2 : 3
		for (let k = 1; k <= maxK; k++) {
			const pr = r + DR[d] * k
			const pc = c + DC[d] * k
			const cands: [number, number][] = [[pr, pc]]
			if (isVert(d) && k === 1) cands.push([pr, pc - 1], [pr, pc + 1])
			for (let i = 0; i < cands.length; i++) {
				const [qr, qc] = cands[i]
				const b = borderOf.get(cid(qr, qc))
				if (b !== undefined) return { kind: 'box', box: b }
				const leaf = leafCell.has(cid(qr, qc)) ? leafAt(qr, qc) : undefined
				if (leaf && at(qr, qc) !== ' ') return { kind: 'box', box: leaf.id }
				const run = runAt.get(cid(qr, qc))
				if (run !== undefined) {
					const rr = runs[run]
					if (rr.consumed === 'leaf' && rr.box !== undefined) return { kind: 'box', box: rr.box }
					return { kind: 'text', run }
				}
				if (i === 0 && isLine(qr, qc)) return null
			}
			if (pr < 0 || pr >= R) break
		}
		return { kind: 'dangling' }
	}
	for (const [id, m] of conn) {
		const [r, c] = coords(id)
		const open = (m & ~(linked.get(id) ?? 0)) | (tip.get(id) ?? 0)
		for (const d of DIRS) {
			if (!(open & d)) continue
			const res = probe(r, c, d)
			if (!res) continue
			terminals.push({ comp: find(part(id, d)), r, c, dir: d, head: tip.get(id) === d, ...res })
		}
	}

	// --- 6b. Crossing or junction? A four-way cell is a junction (fork/bus)
	// when either line through it would be dangling or would fan out to ends
	// that all leave in the same direction (`┌──┼──┐` turning down to children).
	for (const id of crossing) {
		const v = find(id)
		const h = find(id + HALF)
		if (v === h) continue
		const ends = (root: number) => terminals.filter((t) => find(t.comp) === root)
		const tv = ends(v)
		const th = ends(h)
		const fork = (ts: Terminal[]) => ts.length < 2 || ts.every((t) => t.dir === ts[0].dir)
		if (fork(tv) || fork(th)) union(v, h)
	}

	// --- 7. Inline labels: `── yes ──▶`, `--yes-->`, vertical text between runs.
	const compLabel = new Map<number, string>()
	const dead = new Set<Terminal>()
	for (const t1 of terminals) {
		if (dead.has(t1) || t1.kind !== 'text' || t1.head) continue
		if (t1.dir !== E && t1.dir !== S) continue
		const run = runs[t1.run!]
		if (run.consumed || isBracket(run.text)) continue
		const otherEnds = (root: number) => terminals.filter((t) => find(t.comp) === root && t.run !== t1.run)
		const t2 = terminals.find(
			(t) =>
				t !== t1 &&
				!dead.has(t) &&
				t.kind === 'text' &&
				t.run === t1.run &&
				t.dir === OPP[t1.dir] &&
				!t.head &&
				find(t.comp) !== find(t1.comp) &&
				(t1.dir === E ? t.c > run.c1 : t.r > run.r),
		)
		if (!t2) continue
		// `A --- B --- C` is a chain; a label sits inside a directed line or
		// between two boxes (`┌─┐── uses ──┌─┐`).
		const outer = [...otherEnds(find(t1.comp)), ...otherEnds(find(t2.comp))]
		const directed = outer.some((t) => t.head)
		const boxed = outer.length >= 2 && outer.every((t) => t.kind === 'box')
		if (!directed && !boxed) continue
		const label = run.text
		union(t1.comp, t2.comp)
		dead.add(t1)
		dead.add(t2)
		run.consumed = 'label'
		compLabel.set(find(t1.comp), label)
	}
	// Re-key components after merges.
	const compOf = (t: Terminal) => find(t.comp)
	const merged = new Map<number, number[]>()
	for (const [root, cells] of cellsByComp) {
		const nr = find(root)
		const list = merged.get(nr) ?? []
		list.push(...cells)
		merged.set(nr, list)
	}
	const labels = new Map<number, string>()
	for (const [k, v] of compLabel) labels.set(find(k), v)

	// --- 8. Text nodes ------------------------------------------------------
	const textNodeKey = (run: Run): string => {
		if (run.nodeKey) return run.nodeKey
		const { label, shape } = bracketShape(run.text)
		let key = keyByLabel.get(label)
		if (!key) {
			key = keys.unique(label)
			const node: IRNode = { key }
			if (key !== label) node.label = label
			if (shape) node.shape = shape
			if (run.box !== undefined) node.parent = boxById.get(run.box)!.key
			node.span = { from: posOffset(run.r, run.c0), to: posOffset(run.r, run.c1 + 1), line: run.r + 1 }
			nodeByKey.set(key, node)
			keyByLabel.set(label, key)
			ir.nodes.push(node)
		}
		run.consumed = run.consumed ?? 'node'
		run.nodeKey = key
		return key
	}

	// --- 9. Edges ------------------------------------------------------------
	const byComp = new Map<number, Terminal[]>()
	for (const t of terminals) {
		if (dead.has(t)) continue
		const k = compOf(t)
		const list = byComp.get(k) ?? []
		list.push(t)
		byComp.set(k, list)
	}
	const pairCount = new Map<string, number>()
	const edgeComp = new Map<IREdge, number>()
	let attachedEnds = 0
	let totalEnds = 0
	const usedComps = new Set<number>()
	const edgeEnd = new Map<IREdge, [number, number]>()
	const addEdge = (from: string, to: string, start: boolean, end: boolean, comp: number, label?: string, toAt?: [number, number]) => {
		const pair = `${from}->${to}`
		const n = pairCount.get(pair) ?? 0
		pairCount.set(pair, n + 1)
		const cells = merged.get(comp) ?? []
		const dash = cells.length && cells.filter((x) => dashed.has(x)).length / cells.length > 0.4 ? 'dotted' : 'solid'
		const edge: IREdge = {
			key: `${pair}#${n}`,
			from,
			to,
			arrow: { start: start ? 'arrow' : 'none', end: end ? 'arrow' : 'none' },
			line: { dash },
		}
		if (label) edge.label = label
		ir.edges.push(edge)
		edgeComp.set(edge, comp)
		if (toAt) edgeEnd.set(edge, toAt)
		usedComps.add(comp)
	}
	const compEntries = [...byComp.entries()].sort((a, b) => firstCell(a[1]) - firstCell(b[1]))
	function firstCell(ts: Terminal[]) {
		return Math.min(...ts.map((t) => t.r * W_ + t.c))
	}
	for (const [comp, ts] of compEntries) {
		const ends = new Map<string, { key: string; head: boolean; r: number; c: number }>()
		const rank = (d: number) => (d === N ? 0 : d === W ? 1 : d === E ? 2 : 3)
		for (const t of [...ts].sort((a, b) => a.r - b.r || a.c - b.c || rank(a.dir) - rank(b.dir))) {
			totalEnds++
			let key: string | undefined
			if (t.kind === 'box') key = boxById.get(t.box!)!.key
			else if (t.kind === 'text') key = textNodeKey(runs[t.run!])
			if (!key) {
				diagnostics.push({
					from: posOffset(t.r, t.c),
					to: posOffset(t.r, t.c + 1),
					severity: 'warning',
					message: 'Line end is not connected to a box or label',
				})
				continue
			}
			attachedEnds++
			const prev = ends.get(key)
			if (prev) prev.head = prev.head || t.head
			else ends.set(key, { key, head: t.head, r: t.r, c: t.c })
		}
		const list = [...ends.values()].sort((a, b) => a.r - b.r || a.c - b.c)
		if (list.length < 2) continue
		const label = labels.get(comp)
		if (list.length === 2) {
			let [a, b] = list
			if (a.head && !b.head) [a, b] = [b, a]
			addEdge(a.key, b.key, a.head && b.head, b.head, comp, label, [b.r, b.c])
			continue
		}
		const sources = list.filter((x) => !x.head)
		const targets = list.filter((x) => x.head)
		if (sources.length && targets.length) {
			for (const s of sources) for (const t of targets) addEdge(s.key, t.key, false, true, comp, undefined, [t.r, t.c])
		} else {
			const [hub, ...rest] = list
			for (const t of rest) addEdge(hub.key, t.key, hub.head, t.head, comp, undefined, [t.r, t.c])
		}
	}

	// --- 10. Nearby labels --------------------------------------------------
	const edgesByComp = new Map<number, IREdge[]>()
	for (const [e, c] of edgeComp) {
		const l = edgesByComp.get(c) ?? []
		l.push(e)
		edgesByComp.set(c, l)
	}
	for (const run of runs) {
		if (run.consumed) continue
		let best: { comp: number; dist: number } | undefined
		for (let c = run.c0; c <= run.c1; c++) {
			for (const dr of [-1, 1]) {
				const id = cid(run.r + dr, c)
				if (connAt(run.r + dr, c) & (E | W)) {
					const comp = find(part(id, E))
					if (!best || best.dist > 1) best = { comp, dist: 1 }
				}
			}
		}
		for (const [dc, from] of [
			[-1, run.c0],
			[1, run.c1],
		] as const) {
			for (let k = 1; k <= 3; k++) {
				const c = from + dc * k
				const id = cid(run.r, c)
				if (conn.has(id)) {
					if (connAt(run.r, c) & (N | S)) {
						const comp = find(part(id, N))
						if (!best || best.dist > k) best = { comp, dist: k }
					}
					break
				}
				if (at(run.r, c) !== ' ') break
			}
		}
		if (!best) continue
		const es = edgesByComp.get(best.comp)
		if (!es) continue
		if (es.length === 1) {
			if (es[0].label) continue
			es[0].label = run.text
			run.consumed = 'label'
			continue
		}
		// Branch labels (`yes │ no` over a split): the edge whose target end is nearest.
		const mid = (run.c0 + run.c1) / 2
		const ranked = es
			.filter((e) => !e.label && edgeEnd.has(e))
			.map((e) => {
				const [er, ec] = edgeEnd.get(e)!
				return { e, d: Math.abs(ec - mid) + Math.abs(er - run.r) * 0.5 }
			})
			.sort((a, b) => a.d - b.d)
		if (!ranked.length || (ranked.length > 1 && ranked[1].d - ranked[0].d < 2)) continue
		ranked[0].e.label = run.text
		run.consumed = 'label'
	}

	// --- 11. Direction, confidence -----------------------------------------
	const centers = new Map<string, [number, number]>()
	for (const b of boxes) centers.set(b.key!, [(b.top + b.bottom) / 2, (minLeft(b) + maxRight(b)) / 2])
	for (const run of runs) if (run.nodeKey && !centers.has(run.nodeKey)) centers.set(run.nodeKey, [run.r, (run.c0 + run.c1) / 2])
	let horiz = 0
	let vert = 0
	for (const e of ir.edges) {
		const a = centers.get(e.from)
		const b = centers.get(e.to)
		if (!a || !b) continue
		const dy = Math.abs(a[0] - b[0])
		const dx = Math.abs(a[1] - b[1]) / 2
		if (dx > dy) horiz++
		else vert++
	}
	if (horiz > vert) ir.direction = 'right'
	else if (!ir.edges.length && centers.size > 1) {
		const ys = [...centers.values()].map((p) => p[0])
		const xs = [...centers.values()].map((p) => p[1])
		if ((Math.max(...xs) - Math.min(...xs)) / 2 > Math.max(...ys) - Math.min(...ys)) ir.direction = 'right'
	}

	let nonSpace = 0
	let explained = 0
	for (let r = 0; r < R; r++) {
		for (let c = 0; c < g[r].length; c++) {
			const ch = g[r][c]
			if (ch === ' ' || ch === FILLER) continue
			nonSpace++
			const id = cid(r, c)
			if (borderOf.has(id)) explained++
			else if (conn.has(id)) {
				if (usedComps.has(find(id)) || (crossing.has(id) && usedComps.has(find(id + HALF)))) explained++
			} else {
				const run = runAt.get(id)
				if (run !== undefined && runs[run].consumed) explained++
			}
		}
	}
	const explainedFrac = nonSpace ? explained / nonSpace : 0
	const attachedFrac = totalEnds ? attachedEnds / totalEnds : boxes.length ? 0.6 : 0
	let confidence = 0.55 * explainedFrac + 0.45 * attachedFrac
	if (!boxes.length && !ir.edges.length) confidence *= 0.3
	// Long, sentence-like free-text nodes mean we probably parsed prose.
	const textNodes = runs.filter((run) => run.consumed === 'node')
	if (textNodes.length) {
		const prosy = textNodes.filter((run) => {
			const t = stripStep(run.text)
			return t.length > 36 || /[.,;!?]\s|\.$/.test(t)
		}).length
		if (prosy) confidence *= Math.max(0.2, 0.6 - 0.4 * (prosy / textNodes.length))
	}
	if (boxes.length) confidence = Math.min(1, confidence + 0.05)
	if (!ir.nodes.length) return fail('No diagram found: no boxes, arrows or tree lines detected')

	const cells: Record<string, CellRect> = {}
	for (const b of boxes) cells[b.key!] = { row: b.top, col: minLeft(b), rows: b.bottom - b.top + 1, cols: maxRight(b) - minLeft(b) + 1 }
	for (const run of runs) {
		if (run.consumed === 'node' && run.nodeKey && !cells[run.nodeKey]) cells[run.nodeKey] = { row: run.r, col: run.c0, rows: 1, cols: run.c1 - run.c0 + 1 }
	}
	return { ir, diagnostics, confidence: Math.round(confidence * 1000) / 1000, cells }
}

function popcount(m: number): number {
	let n = 0
	for (const d of DIRS) if (m & d) n++
	return n
}

function isBracket(s: string): boolean {
	return /^(\[.*\]|\(.*\)|\{.*\}|<[^<>]+>)$/.test(s)
}

function bracketShape(s: string): { label: string; shape?: NodeShape } {
	const t = s.trim()
	let m: RegExpExecArray | null
	if ((m = /^\[\((.*)\)\]$/.exec(t))) return { label: m[1].trim(), shape: 'cylinder' }
	if ((m = /^\(\((.*)\)\)$/.exec(t))) return { label: m[1].trim(), shape: 'ellipse' }
	if ((m = /^\{\{(.*)\}\}$/.exec(t))) return { label: m[1].trim(), shape: 'hexagon' }
	if ((m = /^\[\[(.*)\]\]$/.exec(t))) return { label: m[1].trim(), shape: 'rectangle' }
	if ((m = /^\[(.*)\]$/.exec(t))) return { label: m[1].trim(), shape: 'rectangle' }
	if ((m = /^\((.*)\)$/.exec(t))) return { label: m[1].trim(), shape: 'oval' }
	if ((m = /^\{(.*)\}$/.exec(t))) return { label: m[1].trim(), shape: 'diamond' }
	if ((m = /^<([^<>]+)>$/.exec(t))) return { label: m[1].trim(), shape: 'diamond' }
	const plain = t.replace(/^["'`]+|["'`:]+$/g, '').trim() || t
	return { label: stripStep(plain) }
}

/** `1. Parse`, `2) Validate`, `Step 3: Save`, `(4) Ship`, `① Plan` → the step's text. */
export function stripStep(s: string): string {
	const m = /^(?:step\s*\d{1,2}\s*[:.)\-–]?|\d{1,2}[.):]|\(\d{1,2}\)|[①-⑳])\s+(\S.*)$/iu.exec(s)
	return m ? m[1].trim() : s
}

// ---------------------------------------------------------------------------
// Box detection by corner tracing

function findBoxes(g: string[][], at: (r: number, c: number) => string): Box[] {
	const found: Box[] = []
	const R = g.length
	for (let r = 0; r < R; r++) {
		for (let c = 0; c < g[r].length; c++) {
			if (!TL.has(g[r][c])) continue
			const b = traceFrom(r, c)
			if (b) found.push({ ...b, id: found.length })
		}
	}
	// Drop boxes whose top-left sits on another box's non-corner border (section dividers).
	const isNonCornerBorder = (o: Box, r: number, c: number) => {
		if (r <= o.top || r >= o.bottom) return false
		return c === leftAt(o, r) && (o.dividers.includes(r) || JUNCTION.has(at(r, c)))
	}
	const keep = found.filter((b) => !found.some((o) => o !== b && isNonCornerBorder(o, b.top, b.lefts[0])))
	// Dedupe identical rectangles.
	const seen = new Set<string>()
	const out: Box[] = []
	for (const b of keep) {
		const k = `${b.top},${b.bottom},${b.lefts[0]},${b.rights[0]}`
		if (seen.has(k)) continue
		seen.add(k)
		out.push({ ...b, id: out.length })
	}
	for (const d of findDiamonds(g, at)) {
		const overlaps = out.some((o) => d.top <= o.bottom && d.bottom >= o.top && Math.min(...d.lefts) <= maxRight(o) && Math.max(...d.rights) >= minLeft(o))
		if (overlaps) continue
		out.push({ ...d, id: out.length, title: '', dividers: [], children: [], cost: 0, shape: 'diamond' })
	}
	return out

	function traceFrom(r: number, c: number): Omit<Box, 'id'> | null {
		const first = at(r, c + 1)
		if (!HB.has(first)) return null
		let j = c + 1
		let title = ''
		let titleChars = 0
		const tl = at(r, c)
		while (j < g[r].length) {
			const ch = at(r, j)
			if (TR.has(ch) && j >= c + 2 && (tl !== '.' || ch === '.') && (tl === '.' || ch !== '.')) {
				const box = tryClose(r, c, j)
				if (box) return { ...box, title: title.trim() }
				if (!JUNCTION.has(ch) && ch !== '+' && ch !== '.') return null
				j++
				continue
			}
			if (HB.has(ch)) {
				if (titleChars) title += ' '
				j++
				continue
			}
			if (ch === ' ') {
				if (at(r, j + 1) === ' ') return null
				title += ' '
				j++
				continue
			}
			if (VB.has(ch) && ch !== ':') return null
			title += ch
			titleChars++
			j++
		}
		return null
	}

	/** A missing side-border cell: blank, or a line crossing the border. */
	function isGapCell(ch: string) {
		return ch === ' ' || HB.has(ch) || UNI_HEADS[ch] !== undefined || ch === '>' || ch === '<'
	}

	function tryClose(r: number, c: number, cr: number): Omit<Box, 'id' | 'title'> | null {
		const lefts = [c]
		const rights = [cr]
		const dividers: number[] = []
		let lc = c
		let rc = cr
		let cost = 0
		let gapsL = 0
		let gapsR = 0
		let fallback: Omit<Box, 'id' | 'title'> | null = null
		const bottomOk = (rr: number, l: number, rgt: number) => {
			let bad = 0
			for (let k = l + 1; k < rgt; k++) if (!HB.has(at(rr, k))) bad++
			return bad <= 1 && rgt - l >= 2
		}
		const pick = (rr: number, col: number, set: Set<string>, alt: Set<string>, spread: number[]) => {
			for (const dc of spread) {
				const ch = at(rr, col + dc)
				if ((set.has(ch) || alt.has(ch)) && (Math.abs(dc) < 3 || farDriftOk(rr, col, col + dc))) return col + dc
			}
			return -1
		}
		/**
		 * Drift of 3–4 columns (wide chars miscounted, a long label pushing the
		 * border out) is accepted only when the candidate is not another box's
		 * border: nothing vertical sits in that column on this box's top row or
		 * on the row above, and the skipped cells hold text (or blanks past the line end).
		 */
		const farDriftOk = (rr: number, from: number, to: number) => {
			const k = to
			if (k !== cr && (TL.has(at(r, k)) || TR.has(at(r, k)) || VB.has(at(r, k)) || VB.has(at(rr - 1, k)))) return false
			if (VB.has(at(rr, from))) return false
			const lo = Math.min(from, to)
			const hi = Math.max(from, to)
			for (let x = lo + 1; x < hi; x++) if (VB.has(at(rr, x)) || TL.has(at(rr, x))) return false
			return true
		}
		const RIGHT_SPREAD = [0, 1, -1, 2, -2, 3, -3, 4, -4]
		for (let rr = r + 1; rr < g.length; rr++) {
			const l = pick(rr, lc, VB, BL, [0, -1, 1])
			const rg = pick(rr, rc, VB, BR, RIGHT_SPREAD)
			if (l < 0) {
				if (gapsL < 1 && isGapCell(at(rr, lc)) && VB.has(at(rr + 1, lc))) {
					gapsL++
					cost++
					lefts.push(lc)
					rights.push(rg < 0 ? rc : rg)
					if (rg >= 0) rc = rg
					continue
				}
				return fallback
			}
			if (rg < 0) {
				if (gapsR < 1 && isGapCell(at(rr, rc)) && (VB.has(at(rr + 1, rc)) || BR.has(at(rr + 1, rc)))) {
					gapsR++
					cost++
					lefts.push(l)
					rights.push(rc)
					lc = l
					continue
				}
				// Bottom row with a drifting right corner.
				if (BL.has(at(rr, l)) && rr >= r + 2) {
					for (const dk of RIGHT_SPREAD) {
						const k = rc + dk
						if (BR.has(at(rr, k)) && bottomOk(rr, l, k)) {
							lefts.push(l)
							rights.push(k)
							return { top: r, bottom: rr, lefts, rights, dividers, children: [], cost: cost + 1 }
						}
					}
				}
				return fallback
			}
			cost += Math.abs(l - lc) + Math.abs(rg - rc)
			lc = l
			rc = rg
			lefts.push(l)
			rights.push(rg)
			const lch = at(rr, l)
			const rch = at(rr, rg)
			if (BL.has(lch) && BR.has(rch) && bottomOk(rr, l, rg)) {
				// A box needs an interior row.
				if (rr < r + 2) return null
				const isJunctionRow = JUNCTION.has(lch) && JUNCTION.has(rch)
				const done = { top: r, bottom: rr, lefts: [...lefts], rights: [...rights], dividers: [...dividers], children: [], cost }
				if (!isJunctionRow) return done
				fallback = fallback ?? done
				dividers.push(rr)
				continue
			}
			if (!VB.has(lch) || !VB.has(rch)) {
				if (BL.has(lch) && !JUNCTION.has(lch) && lch !== '+') return fallback
			}
		}
		return fallback
	}
}
