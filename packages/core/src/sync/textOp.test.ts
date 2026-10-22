import { describe, expect, it } from 'vitest'
import {
	apply,
	baseLength,
	compose,
	diffText,
	fromChanges,
	invert,
	isTextOp,
	normalize,
	OpBuilder,
	targetLength,
	toChanges,
	transform,
	transformIndex,
	type TextOp,
} from './textOp'

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
	let s = seed >>> 0
	return () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const ALPHABET = 'ab\nc d>éx'

function randomString(r: () => number, max: number) {
	let s = ''
	const n = Math.floor(r() * max)
	for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)]
	return s
}

function randomOp(r: () => number, text: string): TextOp {
	const b = new OpBuilder()
	let left = text.length
	while (left > 0) {
		const n = 1 + Math.floor(r() * Math.min(left, 5))
		const p = r()
		if (p < 0.2) b.insert(randomString(r, 4) || 'z')
		else if (p < 0.5) b.delete(n)
		else b.retain(n)
		if (p >= 0.2) left -= n
	}
	if (r() < 0.4) b.insert(randomString(r, 4))
	return b.ops
}

describe('text OT basics', () => {
	it('applies retain / insert / delete', () => {
		expect(apply('hello world', [6, 'big ', 5])).toBe('hello big world')
		expect(apply('hello world', [5, -6])).toBe('hello')
		expect(() => apply('abc', [2])).toThrow()
	})

	it('builder keeps ops normalised (insert before delete, merged)', () => {
		const b = new OpBuilder().retain(1).retain(2).delete(1).insert('x').insert('y').delete(2)
		expect(b.ops).toEqual([3, 'xy', -3])
		expect(normalize([1, 1, 'a', -1, 'b'])).toEqual([2, 'ab', -1])
	})

	it('validates untrusted ops', () => {
		expect(isTextOp([1, 'a', -2])).toBe(true)
		expect(isTextOp([0])).toBe(false)
		expect(isTextOp([''])).toBe(false)
		expect(isTextOp([1.5])).toBe(false)
		expect(isTextOp('x')).toBe(false)
	})

	it('inserts at the same position: the first op wins', () => {
		const s = 'AB'
		const a: TextOp = [1, 'x', 1]
		const b: TextOp = [1, 'y', 1]
		const [a1, b1] = transform(a, b)
		expect(apply(apply(s, a), b1)).toBe('AxyB')
		expect(apply(apply(s, b), a1)).toBe('AxyB')
	})

	it('a whole-line insert goes before a partial one at the same position', () => {
		const s = 'title T\nA > B\n'
		const human: TextOp = [8, 'W', 6] // starts typing a new line
		const agent: TextOp = [8, 'Cache\n', 6] // adds a declaration line
		for (const [a, b] of [
			[human, agent],
			[agent, human],
		]) {
			const [a1, b1] = transform(a, b)
			expect(apply(apply(s, a), b1)).toBe('title T\nCache\nWA > B\n')
			expect(apply(apply(s, b), a1)).toBe('title T\nCache\nWA > B\n')
		}
	})

	it('overlapping deletes delete once', () => {
		const s = 'abcdef'
		const a: TextOp = [1, -3, 2] // bcd
		const b: TextOp = [2, -3, 1] // cde
		const [a1, b1] = transform(a, b)
		expect(apply(apply(s, a), b1)).toBe('af')
		expect(apply(apply(s, b), a1)).toBe('af')
	})

	it('maps CodeMirror changes both ways', () => {
		const text = 'Users > API\nAPI > DB\n'
		const changes = [
			{ from: 12, to: 15, insert: 'Gateway' },
			{ from: 0, to: 0, insert: '// top\n' },
		]
		const op = fromChanges(text.length, changes)
		expect(apply(text, op)).toBe('// top\nUsers > API\nGateway > DB\n')
		expect(toChanges(op)).toEqual([
			{ from: 0, to: 0, insert: '// top\n' },
			{ from: 12, to: 15, insert: 'Gateway' },
		])
		expect(() => fromChanges(3, [{ from: 2, to: 5, insert: '' }])).toThrow()
	})

	it('transforms positions', () => {
		const op: TextOp = [2, 'xx', -2, 3] // "abcdefg" -> "abxxefg"
		expect(transformIndex(op, 0)).toBe(0)
		expect(transformIndex(op, 2)).toBe(4)
		expect(transformIndex(op, 2, -1)).toBe(2)
		expect(transformIndex(op, 3)).toBe(4)
		expect(transformIndex(op, 5)).toBe(5)
		expect(transformIndex(op, 7)).toBe(7)
	})

	it('diffs line-wise so separate lines stay separate', () => {
		const a = 'A > B\nB > C\nC > D\n'
		const b = 'A > B\nB > X\nC > D\nD > E\n'
		const op = diffText(a, b)
		expect(apply(a, op)).toBe(b)
		expect(op).toEqual([10, 'X', -1, 7, 'D > E\n'])
		expect(diffText('', 'x')).toEqual(['x'])
		expect(diffText('same', 'same')).toEqual([4])
	})
})

describe('text OT properties (random)', () => {
	const RUNS = 3000

	it('TP1: transform converges', () => {
		const r = rng(1)
		for (let i = 0; i < RUNS; i++) {
			const s = randomString(r, 20)
			const a = randomOp(r, s)
			const b = randomOp(r, s)
			const [a1, b1] = transform(a, b)
			expect(apply(apply(s, a), b1)).toBe(apply(apply(s, b), a1))
			expect(baseLength(a1)).toBe(targetLength(b))
		}
	})

	it('compose matches sequential application', () => {
		const r = rng(2)
		for (let i = 0; i < RUNS; i++) {
			const s = randomString(r, 20)
			const a = randomOp(r, s)
			const b = randomOp(r, apply(s, a))
			expect(apply(s, compose(a, b))).toBe(apply(apply(s, a), b))
		}
	})

	it('invert undoes', () => {
		const r = rng(4)
		for (let i = 0; i < RUNS; i++) {
			const s = randomString(r, 20)
			const a = randomOp(r, s)
			expect(apply(apply(s, a), invert(a, s))).toBe(s)
		}
	})

	it('diffText round-trips and toChanges/fromChanges round-trip', () => {
		const r = rng(5)
		for (let i = 0; i < RUNS; i++) {
			const s = randomString(r, 30)
			const t = randomString(r, 30)
			const d = diffText(s, t)
			expect(apply(s, d)).toBe(t)
			const op = randomOp(r, s)
			expect(apply(s, fromChanges(s.length, toChanges(op)))).toBe(apply(s, op))
		}
	})

	it('transformIndex never leaves the text', () => {
		const r = rng(6)
		for (let i = 0; i < 1000; i++) {
			const s = randomString(r, 20)
			const op = randomOp(r, s)
			const idx = Math.floor(r() * (s.length + 1))
			const out = transformIndex(op, idx)
			expect(out).toBeGreaterThanOrEqual(0)
			expect(out).toBeLessThanOrEqual(targetLength(op))
		}
	})
})
