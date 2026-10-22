/**
 * Operational transform for plain text.
 *
 * A `TextOp` walks the whole base text once, left to right. Each component is
 * - a positive integer `n`: keep the next n characters,
 * - a negative integer `-n`: delete the next n characters,
 * - a non-empty string: insert it here.
 *
 * Ops are normalised: no zero components, adjacent components of the same
 * kind are merged and, where an insert and a delete touch, the insert comes
 * first. Positions are UTF-16 code units (the same as JavaScript strings and
 * CodeMirror).
 *
 * Insert ties (both ops insert at the same position) are decided by
 * `insertsFirst`: a whole-line insert (ending in a newline) goes before a
 * partial one, so an agent adding a line never splits a word a person is in
 * the middle of typing; otherwise `a` goes first. The server always passes its
 * own (earlier) op as `a`.
 */

export type TextOp = (number | string)[]

/** A CodeMirror-style change in coordinates of the text *before* the edit. */
export interface TextChange {
	from: number
	to: number
	insert: string
}

export class TextOpError extends Error {}

const isRetain = (c: number | string): c is number => typeof c === 'number' && c > 0
const isDelete = (c: number | string): c is number => typeof c === 'number' && c < 0
const isInsert = (c: number | string): c is string => typeof c === 'string'

/** Incremental builder that keeps ops normalised. */
export class OpBuilder {
	readonly ops: TextOp = []

	retain(n: number): this {
		if (n <= 0) return this
		const last = this.ops[this.ops.length - 1]
		if (last !== undefined && isRetain(last)) this.ops[this.ops.length - 1] = last + n
		else this.ops.push(n)
		return this
	}

	insert(s: string): this {
		if (!s) return this
		const ops = this.ops
		const last = ops[ops.length - 1]
		if (last !== undefined && isInsert(last)) ops[ops.length - 1] = last + s
		else if (last !== undefined && isDelete(last)) {
			// keep "insert before delete" canonical order
			const prev = ops[ops.length - 2]
			if (prev !== undefined && isInsert(prev)) ops[ops.length - 2] = prev + s
			else ops.splice(ops.length - 1, 0, s)
		} else ops.push(s)
		return this
	}

	delete(n: number): this {
		if (n <= 0) return this
		const last = this.ops[this.ops.length - 1]
		if (last !== undefined && isDelete(last)) this.ops[this.ops.length - 1] = last - n
		else this.ops.push(-n)
		return this
	}
}

/** Length of the text an op applies to. */
export function baseLength(op: TextOp): number {
	let n = 0
	for (const c of op) if (typeof c === 'number') n += Math.abs(c)
	return n
}

/** Length of the text an op produces. */
export function targetLength(op: TextOp): number {
	let n = 0
	for (const c of op) n += isInsert(c) ? c.length : isRetain(c) ? c : 0
	return n
}

/** True when the op changes nothing. */
export function isNoop(op: TextOp): boolean {
	return op.every(isRetain)
}

/** The identity op for a text of length `len`. */
export function identity(len: number): TextOp {
	return new OpBuilder().retain(len).ops
}

/** Checks the shape of untrusted input (e.g. from the network). */
export function isTextOp(v: unknown): v is TextOp {
	if (!Array.isArray(v)) return false
	for (const c of v) {
		if (typeof c === 'string') {
			if (!c) return false
		} else if (typeof c !== 'number' || !Number.isSafeInteger(c) || c === 0) return false
	}
	return true
}

/** Rebuilds `op` in normalised form. */
export function normalize(op: TextOp): TextOp {
	const b = new OpBuilder()
	for (const c of op) {
		if (isInsert(c)) b.insert(c)
		else if (isRetain(c)) b.retain(c)
		else if (isDelete(c)) b.delete(-c)
	}
	return b.ops
}

export function apply(text: string, op: TextOp): string {
	if (baseLength(op) !== text.length) throw new TextOpError(`op base length ${baseLength(op)} does not match text length ${text.length}`)
	let out = ''
	let i = 0
	for (const c of op) {
		if (isInsert(c)) out += c
		else if (isRetain(c)) {
			out += text.slice(i, i + c)
			i += c
		} else i -= c
	}
	return out
}

/** Iterator over components that can split numbers / strings. */
class Cursor {
	private i = 0
	private offset = 0
	constructor(private op: TextOp) {}

	peek(): number | string | undefined {
		const c = this.op[this.i]
		if (c === undefined) return undefined
		if (isInsert(c)) return c.slice(this.offset)
		return c > 0 ? c - this.offset : c + this.offset
	}

	/** Takes up to `max` length of the current component (whole insert if `max` is undefined). */
	take(max?: number): number | string | undefined {
		const c = this.peek()
		if (c === undefined) return undefined
		const len = isInsert(c) ? c.length : Math.abs(c)
		if (max === undefined || max >= len) {
			this.i++
			this.offset = 0
			return c
		}
		this.offset += max
		if (isInsert(c)) return c.slice(0, max)
		return c > 0 ? max : -max
	}
}

const compLen = (c: number | string) => (isInsert(c) ? c.length : Math.abs(c))

/** `apply(apply(s, a), b) === apply(s, compose(a, b))`. */
export function compose(a: TextOp, b: TextOp): TextOp {
	if (targetLength(a) !== baseLength(b)) throw new TextOpError('compose: length mismatch')
	const out = new OpBuilder()
	const ca = new Cursor(a)
	const cb = new Cursor(b)
	for (;;) {
		const pa = ca.peek()
		const pb = cb.peek()
		if (pa === undefined && pb === undefined) break
		// deletes in a and inserts in b pass straight through
		if (pa !== undefined && isDelete(pa)) {
			out.delete(-(ca.take() as number))
			continue
		}
		if (pb !== undefined && isInsert(pb)) {
			out.insert(cb.take() as string)
			continue
		}
		if (pa === undefined || pb === undefined) throw new TextOpError('compose: ops do not line up')
		const n = Math.min(compLen(pa), compLen(pb))
		const xa = ca.take(n) as number | string
		const xb = cb.take(n) as number
		if (isRetain(xb)) {
			if (isInsert(xa)) out.insert(xa)
			else out.retain(xa as number)
		} else if (isRetain(xa)) out.delete(n)
		// insert in a deleted by b: nothing
	}
	return out.ops
}

const endsLine = (s: string) => s.charCodeAt(s.length - 1) === 10

/** Tie-break for two inserts at the same position: does `a`'s text go first? */
export function insertsFirst(a: string, b: string): boolean {
	const la = endsLine(a)
	const lb = endsLine(b)
	return la === lb ? true : la
}

/**
 * Given `a` and `b` made against the same text, returns `[a', b']` so that
 * `apply(apply(s, a), b') === apply(apply(s, b), a')`. See `insertsFirst` for ties.
 */
export function transform(a: TextOp, b: TextOp): [TextOp, TextOp] {
	if (baseLength(a) !== baseLength(b)) throw new TextOpError('transform: base length mismatch')
	const ao = new OpBuilder()
	const bo = new OpBuilder()
	const ca = new Cursor(a)
	const cb = new Cursor(b)
	for (;;) {
		const pa = ca.peek()
		const pb = cb.peek()
		if (pa === undefined && pb === undefined) break
		if (pa !== undefined && isInsert(pa) && (pb === undefined || !isInsert(pb) || insertsFirst(pa, pb))) {
			const s = ca.take() as string
			ao.insert(s)
			bo.retain(s.length)
			continue
		}
		if (pb !== undefined && isInsert(pb)) {
			const s = cb.take() as string
			ao.retain(s.length)
			bo.insert(s)
			continue
		}
		if (pa === undefined || pb === undefined) throw new TextOpError('transform: ops do not line up')
		const n = Math.min(compLen(pa), compLen(pb))
		const xa = ca.take(n) as number
		const xb = cb.take(n) as number
		if (isRetain(xa) && isRetain(xb)) {
			ao.retain(n)
			bo.retain(n)
		} else if (isDelete(xa) && isRetain(xb)) ao.delete(n)
		else if (isRetain(xa) && isDelete(xb)) bo.delete(n)
		// both delete the same range: nothing
	}
	return [ao.ops, bo.ops]
}

/** The op that undoes `op` when applied to `apply(text, op)`. */
export function invert(op: TextOp, text: string): TextOp {
	const out = new OpBuilder()
	let i = 0
	for (const c of op) {
		if (isInsert(c)) out.delete(c.length)
		else if (isRetain(c)) {
			out.retain(c)
			i += c
		} else {
			out.insert(text.slice(i, i - c))
			i -= c
		}
	}
	return out.ops
}

/**
 * Maps a position in the base text to the matching position after `op`.
 * `assoc` < 0 keeps the position before text inserted exactly at it.
 */
export function transformIndex(op: TextOp, index: number, assoc: -1 | 1 = 1): number {
	let pos = 0
	let shift = 0
	for (const c of op) {
		if (isInsert(c)) {
			if (pos < index || (pos === index && assoc > 0)) shift += c.length
			continue
		}
		if (pos >= index) break
		if (isRetain(c)) pos += c
		else {
			const end = pos - c
			shift -= Math.min(end, index) - pos
			pos = end
		}
	}
	return Math.max(0, index + shift)
}

/**
 * Builds an op from CodeMirror-style changes. Changes are in coordinates of the
 * original text (like `ChangeSet.iterChanges`), may come in any order, and must
 * not overlap.
 */
export function fromChanges(length: number, changes: readonly TextChange[]): TextOp {
	const sorted = [...changes].sort((x, y) => x.from - y.from || x.to - y.to)
	const b = new OpBuilder()
	let pos = 0
	for (const ch of sorted) {
		if (!Number.isInteger(ch.from) || !Number.isInteger(ch.to) || ch.from < pos || ch.to < ch.from || ch.to > length) {
			throw new TextOpError(`invalid change ${JSON.stringify({ from: ch.from, to: ch.to })} for text length ${length}`)
		}
		b.retain(ch.from - pos)
		b.insert(ch.insert)
		b.delete(ch.to - ch.from)
		pos = ch.to
	}
	b.retain(length - pos)
	return b.ops
}

/** Inverse of `fromChanges`: changes in coordinates of the op's base text. */
export function toChanges(op: TextOp): TextChange[] {
	const out: TextChange[] = []
	let pos = 0
	for (const c of op) {
		const last = out[out.length - 1]
		const open = last !== undefined && last.to === pos
		if (isRetain(c)) pos += c
		else if (isInsert(c)) {
			if (open) last.insert += c
			else out.push({ from: pos, to: pos, insert: c })
		} else {
			if (open) last.to -= c
			else out.push({ from: pos, to: pos - c, insert: '' })
			pos -= c
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Diff: whole-text replacement → minimal-ish op (used for PUT adapters, agents)

function splitLines(s: string): string[] {
	const out: string[] = []
	let start = 0
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) === 10) {
			out.push(s.slice(start, i + 1))
			start = i + 1
		}
	}
	if (start < s.length) out.push(s.slice(start))
	return out
}

/** Char-level prefix/suffix trim of a replaced region. */
function replaceRegion(b: OpBuilder, a: string, c: string) {
	let p = 0
	const max = Math.min(a.length, c.length)
	while (p < max && a.charCodeAt(p) === c.charCodeAt(p)) p++
	let s = 0
	while (s < max - p && a.charCodeAt(a.length - 1 - s) === c.charCodeAt(c.length - 1 - s)) s++
	b.retain(p)
	b.insert(c.slice(p, c.length - s))
	b.delete(a.length - p - s)
	b.retain(s)
}

const MAX_LCS_CELLS = 4_000_000

/**
 * An op turning `a` into `b`. Line-level LCS in the changed middle, refined to
 * characters inside each changed hunk, so independent edits on different lines
 * stay separate and merge well under OT.
 */
export function diffText(a: string, b: string): TextOp {
	const out = new OpBuilder()
	if (a === b) return out.retain(a.length).ops
	// common line prefix / suffix
	const la = splitLines(a)
	const lb = splitLines(b)
	let pre = 0
	while (pre < la.length && pre < lb.length && la[pre] === lb[pre]) pre++
	let suf = 0
	while (suf < la.length - pre && suf < lb.length - pre && la[la.length - 1 - suf] === lb[lb.length - 1 - suf]) suf++
	const ma = la.slice(pre, la.length - suf)
	const mb = lb.slice(pre, lb.length - suf)
	const len = (ls: string[]) => ls.reduce((n, l) => n + l.length, 0)
	out.retain(len(la.slice(0, pre)))
	if ((ma.length + 1) * (mb.length + 1) > MAX_LCS_CELLS) replaceRegion(out, ma.join(''), mb.join(''))
	else {
		// LCS table over the middle lines
		const n = ma.length
		const m = mb.length
		const dp = new Uint32Array((n + 1) * (m + 1))
		const at = (i: number, j: number) => i * (m + 1) + j
		for (let i = n - 1; i >= 0; i--)
			for (let j = m - 1; j >= 0; j--) dp[at(i, j)] = ma[i] === mb[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
		let i = 0
		let j = 0
		let delBuf = ''
		let insBuf = ''
		const flush = () => {
			if (delBuf || insBuf) replaceRegion(out, delBuf, insBuf)
			delBuf = ''
			insBuf = ''
		}
		while (i < n || j < m) {
			if (i < n && j < m && ma[i] === mb[j]) {
				flush()
				out.retain(ma[i].length)
				i++
				j++
			} else if (j < m && (i === n || dp[at(i, j + 1)] >= dp[at(i + 1, j)])) insBuf += mb[j++]
			else delBuf += ma[i++]
		}
		flush()
	}
	out.retain(len(la.slice(la.length - suf)))
	return out.ops
}
