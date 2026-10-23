import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractSymbols, langOf, type CodeSymbol, type FileSymbols } from './index'

const FIX = resolve(import.meta.dirname, '../../fixtures/symbols')
const load = (f: string) => extractSymbols(f, readFileSync(join(FIX, f), 'utf8'))
const sym = (r: FileSymbols, name: string): CodeSymbol => {
	const s = r.symbols.find((x) => x.name === name)
	if (!s) throw new Error(`no symbol ${name} in ${r.symbols.map((x) => x.name).join(', ')}`)
	return s
}
const mem = (s: CodeSymbol, name: string): CodeSymbol => {
	const m = s.members?.find((x) => x.name === name)
	if (!m) throw new Error(`no member ${name} in ${s.members?.map((x) => x.name).join(', ')}`)
	return m
}

describe('langOf', () => {
	it('maps extensions', () => {
		expect(['a.ts', 'a.tsx', 'a.mts', 'a.js', 'a.cjs', 'a.vue', 'a.py', 'a.pyi', 'a.go', 'a.rs', 'a.md'].map(langOf)).toEqual(['ts', 'ts', 'ts', 'js', 'js', 'js', 'python', 'python', 'go', 'rust', 'unknown'])
	})
})

describe('Python (service.py)', () => {
	const r = load('service.py')

	it('finds top-level defs, classes and assignments', () => {
		expect(r.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(['variable __all__', 'const MAX_USERS', 'variable _cache', 'function make_service', 'function fetch', 'class Base', 'class Service'])
		expect(sym(r, 'make_service')).toMatchObject({ line: 17, endLine: 19, exported: true })
		expect(sym(r, 'fetch')).toMatchObject({ flags: ['async'], exported: false }) // not in __all__
		expect(sym(r, 'Base')).toMatchObject({ line: 28, flags: ['decorated'] })
		expect(sym(r, 'Service')).toMatchObject({ heritage: ['Base'], exported: true, line: 32, endLine: 55 })
	})

	it('collects refs without strings or comments', () => {
		expect(sym(r, 'make_service')).toMatchObject({ refs: ['Service', 'MAX_USERS'], calls: ['Service'] })
		expect(sym(r, 'fetch')).toMatchObject({ refs: [], importRefs: ['utils'] })
	})

	it('reads members, decorators and self.x references', () => {
		const s = sym(r, 'Service')
		expect(s.members!.map((m) => `${m.kind} ${m.name}`)).toEqual(['property kind', 'constructor __init__', 'property name', 'property _users', 'property limit', 'property count', 'method build', 'method add', 'method _log'])
		expect(mem(s, '__init__').memberRefs).toEqual(['name', '_users', 'limit'])
		expect(mem(s, 'count').memberRefs).toEqual(['_users'])
		expect(mem(s, 'build')).toMatchObject({ flags: ['static', 'decorated'], calls: ['make_service'] })
		expect(mem(s, 'add')).toMatchObject({ memberRefs: ['count', 'limit', '_users', '_log'], importRefs: ['User'] })
		expect(mem(s, '_log')).toMatchObject({ flags: ['private'], importRefs: ['osp', 'os', 'Acct'] })
	})

	it('reads imports (multi-line parenthesised too)', () => {
		expect(r.imports).toEqual([
			{ local: 'os', spec: 'os', imported: '*' },
			{ local: 'osp', spec: 'os.path', imported: '*' },
			{ local: 'User', spec: '.models', imported: 'User' },
			{ local: 'Acct', spec: '.models', imported: 'Account' },
			{ local: 'Any', spec: 'typing', imported: 'Any' },
			{ local: 'Optional', spec: 'typing', imported: 'Optional' },
			{ local: 'utils', spec: '.', imported: 'utils' },
		])
		expect(r.specs).toEqual(['os', 'os.path', '.models', 'typing', '.'])
	})

	it('treats names without a leading underscore as exported when there is no __all__', () => {
		const r2 = extractSymbols('m.py', 'def a():\n    return _b()\n\ndef _b():\n    pass\n\nclass C:\n    def m(self):\n        """docstring with a() inside"""\n        return a()\n')
		expect(r2.symbols.map((s) => [s.name, s.exported])).toEqual([['a', true], ['_b', false], ['C', true]])
		expect(sym(r2, 'a').calls).toEqual(['_b'])
		expect(mem(sym(r2, 'C'), 'm').calls).toEqual(['a'])
		expect(sym(r2, 'C').endLine).toBe(10)
	})
})

describe('Go (server.go)', () => {
	const r = load('server.go')

	it('finds funcs, types, consts and vars (grouped too)', () => {
		expect(r.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual([
			'const Version', 'const MaxConns', 'const minConns', 'variable defaultServer', 'variable mu', 'variable lock', 'type Handler', 'interface Store',
			'struct Server', 'type ID', 'function New', 'function helper', 'struct Client',
		])
		expect(sym(r, 'minConns').exported).toBe(false)
		expect(sym(r, 'mu').refs).toEqual([])
		expect(sym(r, 'helper')).toMatchObject({ exported: false, line: 65, endLine: 67 })
	})

	it('reads struct fields, embedded types and interface methods', () => {
		const s = sym(r, 'Server')
		expect(s.heritage).toEqual(['Store', 'Logger'])
		expect(s.members!.map((m) => `${m.kind} ${m.name}`)).toEqual(['property addr', 'property host', 'property router', 'property handlers', 'method routes', 'method Start', 'method index'])
		expect(sym(r, 'Store')).toMatchObject({ heritage: ['Stringer'] })
		expect(mem(sym(r, 'Store'), 'Get').kind).toBe('method')
	})

	it('attaches methods to receivers and reads receiver member refs', () => {
		const s = sym(r, 'Server')
		expect(mem(s, 'routes').memberRefs).toEqual(['router', 'index', 'Start'])
		expect(mem(s, 'Start')).toMatchObject({ exported: true, memberRefs: ['addr', 'router'], importRefs: ['http'] })
		expect(mem(s, 'index').importRefs).toEqual(['http', 'fmt', 'strings'])
		expect(sym(r, 'Client')).toMatchObject({ flags: ['declared-elsewhere'], calls: ['New'] })
		expect(mem(sym(r, 'Client'), 'Do').calls).toEqual(['New'])
	})

	it('counts composite literals as calls and ignores strings', () => {
		expect(sym(r, 'New')).toMatchObject({ refs: ['Server'], calls: ['Server'], importRefs: ['chi'] })
		expect(r.symbols.some((s) => s.name === 'Fake')).toBe(false)
	})

	it('reads imports with aliases, blank imports and /vN paths', () => {
		expect(r.imports).toEqual([
			{ local: 'fmt', spec: 'fmt', imported: '*' },
			{ local: 'http', spec: 'net/http', imported: '*' },
			{ local: 'chi', spec: 'github.com/go-chi/chi/v5', imported: '*' },
			{ local: 'strings', spec: 'strings', imported: '*' },
		])
		expect(r.specs).toEqual(['fmt', 'net/http', 'github.com/go-chi/chi/v5', 'embed', 'strings'])
	})
})

describe('Rust (lib.rs)', () => {
	const r = load('lib.rs')

	it('finds items with visibility', () => {
		expect(r.symbols.map((s) => `${s.kind} ${s.name}`)).toEqual(['const MAX', 'variable COUNTER', 'type Result', 'struct Store', 'enum Error', 'trait Backend', 'function run', 'function build', 'struct Cache'])
		expect(sym(r, 'MAX').exported).toBe(true)
		expect(sym(r, 'COUNTER').exported).toBe(false)
		expect(sym(r, 'run')).toMatchObject({ flags: ['async'], refs: ['Store', 'Result', 'build'], calls: ['build'] })
		expect(sym(r, 'build').calls).toEqual(['Store'])
		// comments (nested), strings, raw strings and chars never declare anything
		expect(r.symbols.some((s) => ['fake', 'hidden', 'raw'].includes(s.name))).toBe(false)
	})

	it('reads struct fields, enum variants and trait methods', () => {
		const s = sym(r, 'Store')
		expect(s).toMatchObject({ line: 16, endLine: 20, heritage: ['Display'] })
		expect(s.members!.map((m) => `${m.kind} ${m.name}`)).toEqual(['property name', 'property items', 'property limit', 'method new', 'method len', 'method helper', 'method fmt'])
		expect(sym(r, 'Error').members!.map((m) => m.name)).toEqual(['NotFound', 'Invalid', 'Other'])
		const b = sym(r, 'Backend')
		expect(b.heritage).toEqual(['Display', 'Send'])
		expect(b.members!.map((m) => m.name)).toEqual(['get', 'put', 'validate'])
		expect(mem(b, 'put').memberRefs).toEqual(['validate'])
	})

	it('attaches impl methods (with self / Self:: refs) and traits', () => {
		const s = sym(r, 'Store')
		expect(mem(s, 'len').memberRefs).toEqual(['items', 'helper'])
		expect(mem(s, 'new')).toMatchObject({ exported: true, calls: ['Store'], importRefs: ['HashMap'] })
		expect(mem(s, 'fmt').memberRefs).toEqual(['name'])
		expect(sym(r, 'Cache')).toMatchObject({ flags: ['declared-elsewhere'], heritage: ['Backend'] })
	})

	it('reads use trees, mod and extern crate', () => {
		expect(r.imports).toEqual([
			{ local: 'HashMap', spec: 'std::collections', imported: 'HashMap' },
			{ local: 'Set', spec: 'std::collections', imported: 'HashSet' },
			{ local: 'fmt', spec: 'std', imported: 'fmt' },
			{ local: 'Display', spec: 'std::fmt', imported: 'Display' },
			{ local: 'Serialize', spec: 'serde', imported: 'Serialize' },
			{ local: 'alloc', spec: 'alloc', imported: '*' },
		])
		expect(r.specs).toEqual(['std::collections::HashMap', 'std::collections::HashSet', 'std::fmt', 'std::fmt::Display', 'crate::config', 'serde::Serialize', 'alloc'])
	})

	it('tells lifetimes from char literals', () => {
		const r2 = extractSymbols('a.rs', "fn a<'x>(s: &'x str) -> char { '{' }\nfn b() { let c = '\\''; }\nfn c() {}")
		expect(r2.symbols.map((s) => s.name)).toEqual(['a', 'b', 'c'])
	})
})
