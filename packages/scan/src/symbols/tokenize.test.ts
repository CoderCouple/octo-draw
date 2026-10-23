import { describe, expect, it } from 'vitest'
import { tokenizeJs } from './index'

const vals = (src: string, opts?: { jsx?: boolean }) => tokenizeJs(src, opts).map((t) => t.value)
const types = (src: string, opts?: { jsx?: boolean }) => tokenizeJs(src, opts).map((t) => `${t.type}:${t.value}`)

describe('tokenizeJs', () => {
	it('drops line and block comments', () => {
		expect(vals('a // b c\n/* d\ne */ f')).toEqual(['a', 'f'])
		expect(vals('x /* unterminated')).toEqual(['x'])
	})

	it('reads strings with escapes as single tokens', () => {
		expect(types(`'it\\'s' "a \\" b" c`)).toEqual([`string:'it\\'s'`, 'string:"a \\" b"', 'ident:c'])
		// an unterminated string stops at the line end
		expect(types(`'oops\nnext`)).toEqual([`string:'oops`, 'ident:next'])
	})

	it('tokenizes template expressions, including nested templates', () => {
		const t = types('`a ${b + `c ${d}`} e`')
		expect(t).toEqual(['template:`a ${', 'ident:b', 'punct:+', 'template:`c ${', 'ident:d', 'template:`', 'template: e`'])
		// braces inside expressions keep their balance
		expect(vals('`${ {a: 1}.a }` x')).toEqual(['`${', '{', 'a', ':', '1', '}', '.', 'a', '`', 'x'])
	})

	it('tells regex literals from division', () => {
		expect(types('a = /x\\/y[/]/g')).toEqual(['ident:a', 'punct:=', 'regex:/x\\/y[/]/g'])
		expect(types('a / b / c')).toEqual(['ident:a', 'punct:/', 'ident:b', 'punct:/', 'ident:c'])
		expect(types('f(x) / 2')).toContain('punct:/')
		expect(types('return /"/.test(s)')[1]).toBe('regex:/"/')
		expect(types('x = 1 /= 2')).toContain('punct:/=')
		expect(types('this / 2')[1]).toBe('punct:/')
		expect(types('if (a) /re/.test(b)')).toContain('punct:/') // after `)`: division (documented limitation)
	})

	it('reads numbers, private names and multi-char punctuation', () => {
		expect(types('1_000 0xff 10n 1.5e-3 .5')).toEqual(['number:1_000', 'number:0xff', 'number:10n', 'number:1.5e-3', 'number:.5'])
		expect(types('this.#x ?? y?.z ??= w => ...r')).toEqual(['keyword:this', 'punct:.', 'private:#x', 'punct:??', 'ident:y', 'punct:?.', 'ident:z', 'punct:??=', 'ident:w', 'punct:=>', 'punct:...', 'ident:r'])
		expect(types('a ? .5 : 1')[2]).toBe('number:.5')
	})

	it('marks line starts and lines', () => {
		const t = tokenizeJs('a b\n\n  c')
		expect(t.map((x) => [x.value, x.line, x.nl])).toEqual([['a', 1, true], ['b', 1, false], ['c', 3, true]])
	})

	it('skips a shebang', () => {
		expect(vals('#!/usr/bin/env node\nfoo()')).toEqual(['foo', '(', ')'])
	})

	describe('JSX', () => {
		it('emits component tag names as identifiers and skips text', () => {
			const t = tokenizeJs(`const x = <Foo bar="it's" baz={a / 2}>Don't {b} stop</Foo>`, { jsx: true })
			expect(t.filter((x) => x.jsx).map((x) => x.value)).toEqual(['Foo'])
			expect(t.filter((x) => x.type === 'ident').map((x) => x.value)).toEqual(['x', 'Foo', 'a', 'b'])
			expect(t.filter((x) => x.type === 'jsx-text').map((x) => x.value)).toEqual([`Don't`, 'stop'])
			expect(t.some((x) => x.type === 'string' && x.value === `"it's"`)).toBe(true)
		})

		it('handles fragments, self-closing, dotted and nested elements', () => {
			const t = tokenizeJs(`f(<><A.B x /><div><C>{y}</C></div></>)`, { jsx: true })
			expect(t.filter((x) => x.type === 'ident').map((x) => x.value)).toEqual(['f', 'A', 'B', 'C', 'y'])
			expect(t[t.length - 1].value).toBe(')')
		})

		it('treats <T,> and <T extends ...> as generics', () => {
			expect(tokenizeJs('const id = <T,>(x: T) => x', { jsx: true }).some((x) => x.jsx)).toBe(false)
			expect(tokenizeJs('const id = <K extends string>(k: K) => k', { jsx: true }).some((x) => x.jsx)).toBe(false)
		})

		it('is off without opts.jsx (TS casts / generics)', () => {
			expect(tokenizeJs('const a = <T>b').some((x) => x.jsx)).toBe(false)
		})

		it('keeps comparisons as comparisons', () => {
			expect(tokenizeJs('if (a < b) c()', { jsx: true }).some((x) => x.jsx)).toBe(false)
		})
	})

	it('never throws on garbage', () => {
		for (const src of ['`${', '/[', '<', '<a b={', "'", '"\\', '#', '{{{', '}}}', '`${`${`', '/*', '<><><>', 'x = /']) {
			expect(() => tokenizeJs(src, { jsx: true })).not.toThrow()
		}
	})
})
