/**
 * ASCII / Unicode sequence diagrams as chat models print them:
 *
 *   Client            API              DB          ┌────────┐     ┌─────┐
 *     |                |                |          │ Client │     │ API │
 *     |--- POST /x --->|                |          └───┬────┘     └──┬──┘
 *     |                |---- query ---->|              │  GET /me    │
 *     |                |<- - - rows - - |              │────────────▶│
 *     |<-- 200 OK -----|                |              │◀ ─ ─ ─ ─ ─ ─│
 *
 * Participants: a header row (plain names or boxes) above two or more long
 * vertical lifelines. Messages: horizontal arrows whose ends sit on
 * lifelines, read top to bottom; labels inside the line or on the row above.
 * Produces kind 'sequence' IR. Returns null when the text is not one.
 */
import { emptyIR, type DiagramIR, type SeqMessage } from '../ir'
import { FILLER } from './width'

export interface SeqBox {
	top: number
	bottom: number
	left: number
	right: number
}

export interface SequenceParse {
	ir: DiagramIR
	confidence: number
}

const VCH = new Set([...'│┃║┆┇┊┋╎╏|:'])
const THROUGH = new Set([...'-─━═┄┅┈┉╌╍.~=+┼╋├┤┬┴<>◀▶►◄*'])
const HCH = new Set([...'-─━═┄┅┈┉╌╍.~=·'])
const RHEAD = new Set([...'>▶►▸→⟶⇒'])
const LHEAD = new Set([...'<◀◄◂←⟵⇐'])
const DOTTED = /[.┄┅┈┉╌╍·]|- -|─ ─/

interface Lifeline {
	col: number
	top: number
	bottom: number
	verts: number
	name?: string
}

export function parseSequence(g: string[][], boxes: SeqBox[], isBorder: (r: number, c: number) => boolean): SequenceParse | null {
	const R = g.length
	const at = (r: number, c: number): string => (r >= 0 && r < R && c >= 0 ? (g[r][c] ?? ' ') : ' ')
	const width = Math.max(0, ...g.map((row) => row.length))

	// --- lifelines: longest vertical run per column (crossed by arrows allowed)
	const cands: Lifeline[] = []
	for (let c = 0; c < width; c++) {
		let best: Lifeline | undefined
		let start = -1
		let verts = 0
		let lastV = -1
		const close = () => {
			if (start >= 0 && verts >= 3 && (!best || verts > best.verts)) best = { col: c, top: start, bottom: lastV, verts }
			start = -1
			verts = 0
		}
		for (let r = 0; r <= R; r++) {
			const ch = at(r, c)
			const border = r < R && isBorder(r, c)
			if (!border && VCH.has(ch)) {
				if (start < 0) start = r
				verts++
				lastV = r
			} else if (start >= 0 && !border && THROUGH.has(ch) && ch !== ' ') {
				// an arrow crossing or ending on the lifeline
			} else close()
		}
		if (best && best.bottom - best.top >= 3) cands.push(best)
	}
	// Merge neighbouring columns (±1 jitter), keep the strongest.
	const lifelines: Lifeline[] = []
	for (const l of cands) {
		const prev = lifelines[lifelines.length - 1]
		if (prev && l.col - prev.col <= 2) {
			if (l.verts > prev.verts) lifelines[lifelines.length - 1] = l
		} else lifelines.push(l)
	}
	if (lifelines.length < 2) return null
	const top = Math.min(...lifelines.map((l) => l.top))
	const bottom = Math.max(...lifelines.map((l) => l.bottom))
	// Lifelines must run side by side.
	for (const l of lifelines) if (Math.min(l.bottom, bottom) - Math.max(l.top, top) < 3 || l.top - top > 3) return null
	// No real boxes inside the lifeline area (activation bars ≤ 4 wide are fine).
	if (boxes.some((b) => b.top > top && b.bottom <= bottom + 1 && b.right - b.left > 4)) return null

	// --- participant names
	const cols = lifelines.map((l) => l.col)
	for (let i = 0; i < lifelines.length; i++) {
		const l = lifelines[i]
		const lo = i ? (cols[i - 1] + l.col) / 2 : -Infinity
		const hi = i + 1 < cols.length ? (cols[i + 1] + l.col) / 2 : Infinity
		const box = boxes.find((b) => b.bottom < l.top && l.top - b.bottom <= 2 && b.left < l.col && b.right > l.col)
		if (box) {
			const rows: string[] = []
			for (let r = box.top + 1; r < box.bottom; r++) {
				const t = rowText(g[r], box.left + 1, box.right)
				if (t && !/^[─━═\-=]+$/.test(t)) rows.push(t)
			}
			l.name = rows.join(' ').replace(/\s+/g, ' ').trim() || undefined
		}
		for (let r = l.top - 1; !l.name && r >= Math.max(0, l.top - 3); r--) {
			const segs = segments(g[r] ?? []).filter((s) => s.c1 >= lo && s.c0 <= hi)
			if (!segs.length) continue
			const pick = segs.find((s) => s.c0 <= l.col && s.c1 >= l.col) ?? segs.sort((a, b) => dist(a, l.col) - dist(b, l.col))[0]
			const name = pick.text.replace(/[┌┐└┘├┤┬┴─│+|]/g, '').trim()
			if (name) l.name = name
		}
		if (!l.name) return null
	}

	// --- messages
	const ir = emptyIR('sequence')
	const keys = new Map<string, string>()
	const used = new Set<string>()
	for (const l of lifelines) {
		let key = l.name!
		for (let n = 2; used.has(key); n++) key = `${l.name} ${n}`
		used.add(key)
		keys.set(String(l.col), key)
		ir.nodes.push(key === l.name ? { key } : { key, label: l.name })
	}
	const events: SeqMessage[] = []
	const labelRows = new Set<number>()
	const msgRows = new Set<number>()
	let unexplained = 0
	for (let r = top; r <= bottom + 1; r++) {
		const segs: Seg[] = []
		for (let i = 0; i + 1 < cols.length; i++) segs.push(classify(rowSlice(g[r] ?? [], cols[i] + 1, cols[i + 1])))
		let i = 0
		while (i < segs.length) {
			if (!segs[i].line) {
				i++
				continue
			}
			// Extend through intermediate lifelines while the line continues.
			let j = i
			while (j + 1 < segs.length && segs[j + 1].line && !segs[j].rhead && !segs[j + 1].lhead && !VCH.has(at(r, cols[j + 1]))) j++
			const first = segs[i]
			const last = segs[j]
			const lh = first.lhead
			const rh = last.rhead
			const parts = segs.slice(i, j + 1)
			let label = parts
				.map((s) => s.label)
				.filter(Boolean)
				.join(' ')
			if (!lh && !rh && !label) {
				unexplained++
				i = j + 1
				continue
			}
			if (!label && r - 1 >= 0 && !labelRows.has(r - 1) && !msgRows.has(r - 1)) {
				const pieces: string[] = []
				let ok = true
				for (let k = i; k <= j; k++) {
					const raw = rowSlice(g[r - 1] ?? [], cols[k] + 1, cols[k + 1])
					if (classify(raw).line || /[-─━═]{2}|[│|┌┐└┘]/.test(raw)) ok = false
					const t = raw.replace(/\s+/g, ' ').trim()
					if (t) pieces.push(t)
				}
				if (ok && pieces.length) {
					label = pieces.join(' ')
					labelRows.add(r - 1)
				}
			}
			msgRows.add(r)
			const a = keys.get(String(cols[i]))!
			const b = keys.get(String(cols[j + 1]))!
			const leftward = lh && !rh
			const m: SeqMessage = {
				kind: 'message',
				from: leftward ? b : a,
				to: leftward ? a : b,
				arrow: { start: lh && rh ? 'arrow' : 'none', end: lh || rh ? 'arrow' : 'none' },
				dash: parts.some((s) => s.dotted) ? 'dotted' : 'solid',
			}
			if (label) m.label = label
			events.push(m)
			i = j + 1
		}
	}
	if (!events.length) return null
	ir.sequence = { events }
	let confidence = 0.95
	if (unexplained) confidence -= Math.min(0.3, unexplained * 0.1)
	return { ir, confidence }
}

interface Seg {
	line: boolean
	lhead: boolean
	rhead: boolean
	dotted: boolean
	label: string
}

function rowSlice(row: string[], c0: number, c1: number): string {
	return row
		.slice(c0, c1)
		.filter((ch) => ch !== FILLER)
		.join('')
}

function rowText(row: string[], c0: number, c1: number): string {
	return rowSlice(row, c0, c1).replace(/\s+/g, ' ').trim()
}

/** Classifies the text between two neighbouring lifelines on one row. */
function classify(s: string): Seg {
	const t = s.trim()
	const none: Seg = { line: false, lhead: false, rhead: false, dotted: false, label: '' }
	if (!t) return none
	const chars = [...t]
	const lhead = LHEAD.has(chars[0])
	const rhead = RHEAD.has(chars[chars.length - 1])
	const isH = (ch: string) => HCH.has(ch) || LHEAD.has(ch) || RHEAD.has(ch)
	const hcount = chars.filter((ch) => HCH.has(ch)).length
	// The run must touch both lifelines (only spaces between the line and each lifeline are tolerated if short).
	const lead = s.length - s.trimStart().length
	const trail = s.length - s.trimEnd().length
	if (lead > 1 || trail > 1) return none
	if (!isH(chars[0]) || !isH(chars[chars.length - 1]) || hcount < 2) return none
	const label = t
		.replace(/^[<◀◄◂←⟵⇐]?[-─━═┄┅┈┉╌╍.~=·\s]*/u, '')
		.replace(/[-─━═┄┅┈┉╌╍.~=·\s]*[>▶►▸→⟶⇒]?$/u, '')
		.trim()
	return { line: true, lhead, rhead, dotted: DOTTED.test(t.replace(label, '')), label }
}

interface Segment {
	c0: number
	c1: number
	text: string
}

/** Text segments of a row, split on runs of 2+ spaces. */
function segments(row: string[]): Segment[] {
	const out: Segment[] = []
	let c0 = -1
	let gap = 0
	let buf = ''
	const flush = (end: number) => {
		if (c0 >= 0 && buf.trim()) out.push({ c0, c1: end, text: buf.trim() })
		c0 = -1
		buf = ''
	}
	for (let c = 0; c <= row.length; c++) {
		const ch = row[c] ?? ' '
		if (ch === ' ' || ch === FILLER) {
			if (ch === ' ') gap++
			if (gap >= 2 && c0 >= 0) flush(c - gap)
			else if (c0 >= 0 && ch === ' ') buf += ' '
			continue
		}
		gap = 0
		if (c0 < 0) c0 = c
		buf += ch
	}
	flush(row.length - 1)
	return out
}

function dist(s: Segment, col: number): number {
	return Math.abs((s.c0 + s.c1) / 2 - col)
}
