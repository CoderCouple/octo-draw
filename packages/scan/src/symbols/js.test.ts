import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractSymbols, type CodeSymbol, type FileSymbols } from './index'

const FIX = resolve(import.meta.dirname, '../../fixtures/symbols')
const load = (f: string) => extractSymbols(f, readFileSync(join(FIX, f), 'utf8'))
const sym = (r: FileSymbols, name: string): CodeSymbol => {
	const s = r.symbols.find((x) => x.name === name)
	if (!s) throw new Error(`no symbol ${name} in ${r.symbols.map((x) => x.name).join(', ')}`)
	return s
}
const mem = (s: CodeSymbol, name: string, kind?: string): CodeSymbol => {
	const m = s.members?.find((x) => x.name === name && (!kind || x.kind === kind))
	if (!m) throw new Error(`no member ${name} in ${s.members?.map((x) => x.name).join(', ')}`)
	return m
}
const names = (r: FileSymbols) => r.symbols.map((s) => s.name)
const ex = (src: string, path = 'x.ts') => extractSymbols(path, src)

describe('TS fixture (kitchen.ts)', () => {
	const r = load('kitchen.ts')

	it('finds every top-level declaration in order', () => {
		expect(names(r)).toEqual([
			'VERSION', 'Config', 'Mode', 'Pair', 'Color', 'Flags', 'legacy', 'compute', 'compute2', 'square', 'LIMIT', 'OTHER', 'handler', 'format',
			'counter', 'legacyVar', 'alpha', 'gamma', 'restProps', 'first', 'second', 'gen', 'Base', 'Engine', 'Internal', 'decorator',
		])
	})

	it('reports kinds, exports and flags', () => {
		expect(sym(r, 'VERSION')).toMatchObject({ kind: 'const', exported: true, line: 11, endLine: 11 })
		expect(sym(r, 'Config')).toMatchObject({ kind: 'interface', exported: true, heritage: ['Options', 'Shape'] })
		expect(sym(r, 'Mode')).toMatchObject({ kind: 'type', exported: true, line: 20, endLine: 21 })
		expect(sym(r, 'Pair')).toMatchObject({ kind: 'type', exported: false })
		expect(sym(r, 'Color').kind).toBe('enum')
		expect(sym(r, 'Flags').kind).toBe('enum')
		expect(sym(r, 'legacy').kind).toBe('function')
		expect(sym(r, 'square')).toMatchObject({ kind: 'function', exported: false, line: 45, endLine: 47 })
		expect(sym(r, 'handler')).toMatchObject({ kind: 'function', exported: true, flags: ['async', 'arrow'] })
		expect(sym(r, 'format').flags).toEqual(['arrow'])
		expect(sym(r, 'counter').kind).toBe('variable')
		expect(sym(r, 'gen').flags).toEqual(['generator'])
		expect(sym(r, 'Base')).toMatchObject({ kind: 'class', exported: true, heritage: ['Shape'] })
		expect(sym(r, 'Base').flags).toEqual(expect.arrayContaining(['decorated', 'abstract']))
		expect(sym(r, 'Engine')).toMatchObject({ kind: 'class', exported: true, heritage: ['Base'], line: 76, endLine: 125 })
		expect(sym(r, 'Engine').flags).toContain('default')
		expect(sym(r, 'Internal').kind).toBe('namespace')
		expect(sym(r, 'decorator').exported).toBe(false)
	})

	it('merges overloads into one symbol', () => {
		expect(r.symbols.filter((s) => s.name === 'compute2')).toHaveLength(1)
		expect(sym(r, 'compute2')).toMatchObject({ line: 39, endLine: 43, exported: true })
		expect(mem(sym(r, 'Engine'), 'load')).toMatchObject({ kind: 'method', line: 107, endLine: 110 })
	})

	it('splits multiple declarators and destructuring', () => {
		expect(sym(r, 'LIMIT').kind).toBe('const')
		expect(sym(r, 'OTHER').refs).toEqual(['LIMIT'])
		for (const n of ['alpha', 'gamma', 'restProps']) {
			expect(sym(r, n)).toMatchObject({ kind: 'const', exported: true, refs: [], importRefs: ['defaultThing'] })
		}
		expect(r.symbols.some((s) => s.name === 'beta')).toBe(false)
		expect(sym(r, 'first').refs).toEqual([])
	})

	it('collects refs, calls and import refs', () => {
		expect(sym(r, 'compute')).toMatchObject({ refs: ['square', 'LIMIT'], calls: ['square'] })
		expect(sym(r, 'handler')).toMatchObject({ refs: ['Config', 'format', 'compute'], calls: ['format', 'compute'], importRefs: ['h'] })
		expect(sym(r, 'gen').calls).toEqual(['square'])
		expect(sym(r, 'square').refs).toEqual([])
		// comments never produce refs
		expect(sym(r, 'VERSION').refs).toEqual([])
	})

	it('reads class members with kinds, flags and memberRefs', () => {
		const e = sym(r, 'Engine')
		expect(e.members!.map((m) => `${m.kind} ${m.name}`)).toEqual([
			'property instances', 'property id', 'property #secret', 'property cache', 'method handle', 'property opts', 'property name', 'constructor constructor',
			'getter size', 'setter size', 'method area', 'method run', 'method load', 'method #tick', 'method reset', 'method create', 'method [Symbol.iterator]',
		])
		expect(mem(e, 'instances').flags).toEqual(['static'])
		expect(mem(e, 'id').flags).toEqual(['readonly'])
		expect(mem(e, '#secret').flags).toEqual(['private'])
		expect(mem(e, 'handle')).toMatchObject({ kind: 'method', memberRefs: ['run'] })
		expect(mem(e, 'handle').flags).toEqual(expect.arrayContaining(['arrow', 'protected']))
		expect(mem(e, 'opts').flags).toEqual(['private', 'readonly'])
		expect(mem(e, 'constructor')).toMatchObject({ memberRefs: ['id'], importRefs: ['path'] })
		expect(mem(e, 'size', 'getter').memberRefs).toEqual(['cache'])
		expect(mem(e, 'size', 'setter').memberRefs).toEqual(['reset'])
		expect(mem(e, 'area')).toMatchObject({ memberRefs: ['#secret'], calls: ['square'] })
		expect(mem(e, 'run')).toMatchObject({ memberRefs: ['#tick', 'load'], importRefs: ['other'], flags: ['async'] })
		expect(mem(e, 'create')).toMatchObject({ flags: ['static'], calls: ['Engine'] })
		expect(mem(sym(r, 'Base'), 'area').flags).toEqual(['abstract'])
		expect(mem(sym(r, 'Base'), 'describe').memberRefs).toEqual(['area'])
	})

	it('reads interface and enum members', () => {
		const c = sym(r, 'Config')
		expect(c.members!.map((m) => `${m.kind} ${m.name}`)).toEqual(['property name', 'property retries', 'method load'])
		expect(mem(c, 'retries').flags).toEqual(['optional'])
		expect(sym(r, 'Color').members!.map((m) => m.name)).toEqual(['Red', 'Green', 'Blue'])
		expect(sym(r, 'Flags').members!.map((m) => m.name)).toEqual(['A', 'B'])
	})

	it('reads imports, specs and re-exports', () => {
		expect(r.imports).toEqual([
			{ local: 'defaultThing', spec: './util', imported: 'default' },
			{ local: 'h', spec: './util', imported: 'helper' },
			{ local: 'Shape', spec: './util', imported: 'Shape', typeOnly: true },
			{ local: 'other', spec: './util', imported: 'other' },
			{ local: 'Options', spec: '../types', imported: 'Options', typeOnly: true },
			{ local: 'path', spec: 'node:path', imported: '*' },
		])
		expect(r.specs).toEqual(['./util', '../types', 'node:path', './side-effect', './re', './all', './ns'])
		expect(r.reexports).toEqual([
			{ spec: './re', names: ['reexported'] },
			{ spec: './all', names: ['*'] },
			{ spec: './ns', names: ['ns'] },
		])
	})
})

describe('TSX fixture (component.tsx)', () => {
	const r = load('component.tsx')

	it('finds components, generic arrows and interfaces', () => {
		expect(names(r)).toEqual(['Props', 'identity', 'pick', 'Greeting', 'Badge', 'Icon', 'App'])
		expect(sym(r, 'identity')).toMatchObject({ kind: 'function', flags: ['arrow'] })
		expect(sym(r, 'pick')).toMatchObject({ kind: 'function', refs: ['Props'] })
		expect(sym(r, 'App')).toMatchObject({ exported: true, flags: ['default'], calls: ['Greeting'] })
	})

	it('counts JSX tags as calls and ignores JSX text, comments and attribute strings', () => {
		const g = sym(r, 'Greeting')
		expect(g.refs).toEqual(['Props', 'Icon', 'Badge', 'identity'])
		expect(g.calls).toEqual(['Icon', 'Badge', 'identity'])
		expect(g.importRefs).toEqual(['useState', 'formatName', 'Button'])
		expect(g.endLine).toBe(27)
		// `Hidden()` only appears in a JSX comment; apostrophes in text don't break later declarations
		expect(sym(r, 'Badge')).toMatchObject({ line: 29, endLine: 31 })
	})
})

describe('JS fixture (tricky.js)', () => {
	const r = load('tricky.js')

	it('ignores imports inside templates, strings and comments', () => {
		expect(r.specs).toEqual(['./real.js', './lazy.js', './config', './ab'])
		expect(r.imports.map((b) => b.local)).toEqual(['real', 'cfg', 'a', 'bee'])
		expect(r.imports.find((b) => b.local === 'bee')).toEqual({ local: 'bee', spec: './ab', imported: 'b' })
	})

	it('keeps statement boundaries across regex literals and templates', () => {
		expect(names(r)).toEqual(['fake', 'nested', 're1', 're2', 're3', 'div', 'quote', 'useAll', 'helper', 'lazy', 'tpl'])
		expect(sym(r, 'nested').importRefs).toEqual(['real'])
		expect(sym(r, 'useAll')).toMatchObject({ refs: ['re1', 'quote', 're2', 'fake', 'helper', 'div', 'nested'], calls: ['helper'], exported: true })
		expect(sym(r, 'helper')).toMatchObject({ refs: ['re3', 'useAll'], calls: [] })
		expect(sym(r, 'tpl').exported).toBe(true)
	})
})

describe('CommonJS fixture (legacy.cjs)', () => {
	const r = load('legacy.cjs')
	it('reads require bindings and module.exports', () => {
		expect(r.imports).toEqual([
			{ local: 'fs', spec: 'fs', imported: 'default' },
			{ local: 'join', spec: 'path', imported: 'join' },
		])
		expect(sym(r, 'read')).toMatchObject({ exported: true, importRefs: ['fs', 'join'] })
		expect(sym(r, 'parse').exported).toBe(true)
		expect(sym(r, 'Store')).toMatchObject({ exported: true, kind: 'class' })
		expect(mem(sym(r, 'Store'), 'constructor').calls).toEqual(['parse', 'read'])
		expect(sym(r, 'version')).toMatchObject({ exported: true, kind: 'const' })
	})
})

describe('TS/JS constructs (inline)', () => {
	it('ends statements without semicolons', () => {
		const r = ex('const a = 1\nconst b = a\nfoo()\nexport function c() { return b }\nlet d = c\n  .call(null)\nlet e = d')
		expect(names(r)).toEqual(['a', 'b', 'c', 'd', 'e'])
		expect(sym(r, 'd')).toMatchObject({ line: 5, endLine: 6, refs: ['c'] })
		expect(sym(r, 'e').refs).toEqual(['d'])
	})

	it('handles `as const`, generics and object types in annotations', () => {
		const r = ex("export const A = ['x'] as const\nexport type B = (typeof A)[number]\nconst C: Record<B, { k: string, v: number }> = {} as never\nconst D = 1")
		expect(names(r)).toEqual(['A', 'B', 'C', 'D'])
		expect(sym(r, 'C').refs).toEqual(['B'])
	})

	it('reads export lists, default exports and anonymous defaults', () => {
		const r = ex('function a() {}\nconst b = 1\nexport { a, b as bee }\nexport default b')
		expect(sym(r, 'a').exported).toBe(true)
		expect(sym(r, 'b')).toMatchObject({ exported: true, flags: ['default'] })
		expect(names(ex('export default function () { helper() }\nfunction helper() {}'))).toEqual(['default', 'helper'])
		expect(sym(ex('export default class { x = 1 }'), 'default').kind).toBe('class')
	})

	it('reads function and class expressions bound to consts', () => {
		const r = ex('const f = function* () {}\nconst g = async function () {}\nconst K = class extends Base { m() {} }\nconst h = x => x\nconst i = async () => 1')
		expect(sym(r, 'f')).toMatchObject({ kind: 'function', flags: ['generator'] })
		expect(sym(r, 'g')).toMatchObject({ kind: 'function', flags: ['async'] })
		expect(sym(r, 'K')).toMatchObject({ kind: 'class', heritage: ['Base'] })
		expect(mem(sym(r, 'K'), 'm').kind).toBe('method')
		expect(sym(r, 'h').flags).toEqual(['arrow'])
		expect(sym(r, 'i').flags).toEqual(['async', 'arrow'])
	})

	it('excludes property accesses, object keys and parameter names from refs', () => {
		const r = ex('const a = 1\nconst b = 2\nfunction f(a: number) { return { b: x.a, c: obj?.b } }')
		expect(sym(r, 'f').refs).toEqual([])
		const r2 = ex('const a = 1\nfunction g() { return cond ? a : 0 }')
		expect(sym(r2, 'g').refs).toEqual(['a'])
	})

	it('detects calls: plain, new, generic and tagged templates', () => {
		const r = ex('class A {}\nfunction b() {}\nfunction c<T>() {}\nconst tag = (s: any) => s\nfunction user() { new A(); b(); c<string>(); tag`x`; return b }')
		expect(sym(r, 'user')).toMatchObject({ refs: ['A', 'b', 'c', 'tag'], calls: ['A', 'b', 'c', 'tag'] })
	})

	it('ignores fake declarations in strings, templates, comments and regexes', () => {
		const r = ex("const s = 'function no() {}'\nconst t = `class Nope {}`\n// function nope2() {}\nconst re = /function nope3\\(\\) {}/\nfunction yes() {}")
		expect(names(r)).toEqual(['s', 't', 're', 'yes'])
	})

	it('parses decorators, static blocks and modifiers in classes', () => {
		const r = ex('@Injectable({ x: 1 })\nexport class S {\n  static { init() }\n  @Input() value = 1\n  public static async load() {}\n  protected abstract get x(): number\n  declare y: string\n  override z() {}\n  get = 1\n  static set(v) {}\n}')
		const s = sym(r, 'S')
		expect(s.flags).toEqual(['decorated'])
		expect(s.members!.map((m) => `${m.kind} ${m.name}`)).toEqual(['property value', 'method load', 'getter x', 'property y', 'method z', 'property get', 'method set'])
		expect(mem(s, 'value').flags).toEqual(['decorated'])
		expect(mem(s, 'load').flags).toEqual(['static', 'async'])
		expect(mem(s, 'x').flags).toEqual(expect.arrayContaining(['protected', 'abstract']))
	})

	it('reads import forms: default+named, type modifiers, import = require', () => {
		const r = ex("import a, { b, type C, D as E } from 'm'\nimport type F from 'n'\nimport G = require('o')\nconst x = import('p')\nimport.meta.url")
		expect(r.imports).toEqual([
			{ local: 'a', spec: 'm', imported: 'default' },
			{ local: 'b', spec: 'm', imported: 'b' },
			{ local: 'C', spec: 'm', imported: 'C', typeOnly: true },
			{ local: 'E', spec: 'm', imported: 'D' },
			{ local: 'F', spec: 'n', imported: 'default', typeOnly: true },
			{ local: 'G', spec: 'o', imported: 'default' },
		])
		expect(r.specs).toEqual(['m', 'n', 'o', 'p'])
	})

	it('reads namespaces and declare module', () => {
		const r = ex("declare module 'x' { export const a: number }\nnamespace A.B { export const y = 1 }\ndeclare global { interface Window { z: 1 } }\nconst after = 1")
		expect(names(r)).toEqual(['x', 'A.B', 'after'])
	})

	it('reads parameter properties and interface signatures', () => {
		const r = ex('interface I {\n  (x: number): string\n  new (): I\n  [k: string]: any\n  a?: number\n  m<T>(x: T): T\n}')
		expect(sym(r, 'I').members!.map((m) => `${m.kind} ${m.name}`)).toEqual(['property a', 'method m'])
	})

	it('handles vue and svelte script blocks', () => {
		const r = extractSymbols('a.vue', '<template><div>{{ x }}</div></template>\n<script setup lang="ts">\nimport { ref } from "vue"\nconst count = ref(0)\nfunction inc() { count.value++ }\n</script>')
		expect(names(r)).toEqual(['count', 'inc'])
		expect(sym(r, 'inc')).toMatchObject({ line: 5, refs: ['count'] })
		expect(r.specs).toEqual(['vue'])
	})

	it('returns empty results for unknown languages', () => {
		expect(extractSymbols('a.txt', 'function x() {}')).toEqual({ lang: 'unknown', symbols: [], imports: [], specs: [], reexports: [] })
	})
})
