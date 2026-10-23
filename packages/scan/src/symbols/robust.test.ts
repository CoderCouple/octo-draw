import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractSymbols } from './index'

const ROOT = resolve(import.meta.dirname, '../../../..')
const FIX = resolve(import.meta.dirname, '../../fixtures/symbols')

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (e === 'node_modules') continue
		const p = join(dir, e)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (/\.tsx?$/.test(e)) out.push(p)
	}
	return out
}

/** Deterministic pseudo-random numbers (no flaky tests). */
function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff
		return seed / 0x7fffffff
	}
}

describe('robustness', () => {
	it('never throws on truncated or mangled fixtures', () => {
		const rand = rng(42)
		for (const f of readdirSync(FIX)) {
			const text = readFileSync(join(FIX, f), 'utf8')
			for (let k = 0; k < 40; k++) {
				const cut = Math.floor(rand() * text.length)
				const variants = [text.slice(0, cut), text.slice(cut), text.slice(0, cut) + text.slice(Math.min(text.length, cut + 7)), text.slice(0, cut) + '{(`"\'/' + text.slice(cut)]
				for (const v of variants) expect(() => extractSymbols(f, v)).not.toThrow()
			}
		}
	})

	it('stays fast on large and pathological input', () => {
		const big = Array.from({ length: 3000 }, (_, i) => `export function f${i}(x: number) { return f${(i + 1) % 3000}(x) + \`\${x}\` }`).join('\n')
		const t0 = Date.now()
		const r = extractSymbols('big.ts', big)
		expect(Date.now() - t0).toBeLessThan(5000)
		expect(r.symbols.length).toBe(2000) // capped
		for (const src of ['{'.repeat(5000), '('.repeat(5000), '`${'.repeat(500), '<a>'.repeat(2000), '/'.repeat(5000), "'".repeat(5000)]) {
			for (const p of ['a.tsx', 'a.py', 'a.go', 'a.rs']) expect(() => extractSymbols(p, src)).not.toThrow()
		}
	})
})

describe('smoke: this repo', () => {
	const files = [...walk(join(ROOT, 'packages/core/src')), ...walk(join(ROOT, 'packages/scan/src'))]

	it('extracts plausible symbols from every core and scan source file', () => {
		let total = 0
		for (const f of files) {
			const r = extractSymbols(f, readFileSync(f, 'utf8'))
			total += r.symbols.length
			for (const s of r.symbols) {
				expect(s.name, relative(ROOT, f)).not.toBe('')
				expect(s.line, `${relative(ROOT, f)} ${s.name}`).toBeGreaterThan(0)
				expect(s.endLine).toBeGreaterThanOrEqual(s.line)
			}
		}
		expect(files.length).toBeGreaterThan(50)
		expect(total).toBeGreaterThan(files.length * 2)
	})

	it('reads packages/core/src/dsl/parse.ts', () => {
		const r = extractSymbols('parse.ts', readFileSync(join(ROOT, 'packages/core/src/dsl/parse.ts'), 'utf8'))
		const by = (n: string) => r.symbols.find((s) => s.name === n)
		expect(by('Parser')).toMatchObject({ kind: 'class', exported: true })
		const members = by('Parser')!.members!.map((m) => m.name)
		expect(members).toEqual(expect.arrayContaining(['run', 'parseStatement', 'parseDirective', 'parseItem', 'parseBlock', 'peek', 'next', 'parseProps']))
		expect(by('Parser')!.members!.find((m) => m.name === 'run')!.memberRefs).toContain('parseBlock')
		expect(by('tokenize')).toMatchObject({ kind: 'function', exported: false })
		expect(by('analyzeOcto')).toMatchObject({ kind: 'function', exported: true, calls: ['tokenize', 'Parser'] })
		expect(by('parseOcto')!.calls).toEqual(['analyzeOcto'])
		expect(by('OPS')).toMatchObject({ kind: 'const', exported: true })
		expect(by('DIRECTIVES')!.kind).toBe('const')
		expect(by('Token')!.kind).toBe('interface')
		expect(by('Statement')!.kind).toBe('type')
		expect(r.imports.some((b) => b.local === 'parseSeqStatement' && b.spec === './sequence')).toBe(true)
	})
})
