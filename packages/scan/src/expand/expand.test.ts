import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pageTree, parseOcto, parseOctoPages, parsePage, sourceDirective, type PageTreeNode } from '@octo-draw/core'
import { scanSource } from '../scan'
import { localFileSource, scanDir, walkDir } from '../node'
import { ConnectorError } from '../connectors/types'
import { applyDeepen, deepenSync } from './deepen'
import { expandCode, expandInFiles, expandNode, registerExpander, type ExpandedPage } from './index'
import { expandConfig } from './config'
import { isChildSrc, parseSrc } from './src'

const FIX = resolve(import.meta.dirname, '../../fixtures')
const DEEP = join(FIX, 'deep-repo')
const ctx = { fetch, env: {} }

async function deepFiles() {
	return (await walkDir(DEEP)).files
}

const nodesOf = (body: string) => parseOcto(body).ir.nodes
const keysOf = (body: string) => nodesOf(body).map((n) => n.key)
const srcOf = (body: string, key: string) => nodesOf(body).find((n) => n.key === key)?.ext?.src

function maxDepth(nodes: PageTreeNode[]): number {
	return Math.max(0, ...nodes.map((n) => Math.max(n.depth, maxDepth(n.children))))
}

describe('src refs', () => {
	it('parses code, cloud, GitHub long form and HF refs', () => {
		expect(parseSrc('local:apps/server/src/sync')).toMatchObject({ kind: 'local', scheme: 'local', path: 'apps/server/src/sync' })
		expect(parseSrc('local:./a/b/#Parser.parseItem')).toMatchObject({ path: 'a/b', fragment: 'Parser.parseItem' })
		expect(parseSrc('local:.')).toMatchObject({ path: '' })
		expect(parseSrc('local:#uses:Postgres')).toMatchObject({ path: '', fragment: 'uses:Postgres' })
		expect(parseSrc('github:o/r@abc123:src/app.ts')).toMatchObject({ kind: 'github', repo: 'o/r', ref: 'abc123', path: 'src/app.ts' })
		expect(parseSrc('aws:arn:aws:lambda:us-east-1:1:function:api#x')).toMatchObject({ kind: 'aws', path: 'arn:aws:lambda:us-east-1:1:function:api#x' })
		expect(parseSrc('hf:org/model#layers.0')).toMatchObject({ kind: 'huggingface', path: 'org/model', fragment: 'layers.0' })
		expect(parseSrc('src/x.ts')).toMatchObject({ kind: '', scheme: '', path: 'src/x.ts' })
	})

	it('knows what is structurally inside what', () => {
		const p = (s: string) => parseSrc(s)
		expect(isChildSrc(p('local:a'), p('local:a/b'))).toBe(true)
		expect(isChildSrc(p('local:a'), p('local:ab'))).toBe(false)
		expect(isChildSrc(p('local:.'), p('local:a'))).toBe(true)
		expect(isChildSrc(p('local:a/x.ts'), p('local:a/x.ts#C'))).toBe(true)
		expect(isChildSrc(p('local:a/x.ts#C'), p('local:a/x.ts#C.m'))).toBe(true)
		expect(isChildSrc(p('local:a/x.ts#C'), p('local:a/x.ts#D'))).toBe(false)
		expect(isChildSrc(p('local:a'), p('local:a#uses:Postgres'))).toBe(false)
		expect(isChildSrc(p('local:a'), p('github:a/b'))).toBe(false)
	})
})

describe('scan with src refs and depth', () => {
	it('depth 1: every scanned node of interest carries src, the root has the source directive', async () => {
		const r = await scanDir(DEEP)
		expect(sourceDirective(r.code)).toBe(r.root)
		const root = parsePage(r.code, '')!.ir
		expect(root.nodes.find((n) => n.key === 'api')?.ext?.src).toBe('local:packages/api')
		expect(root.nodes.find((n) => n.key === 'Postgres')?.ext?.src).toBe('local:#uses:Postgres')
		const mods = parsePage(r.code, 'api modules')!.ir
		expect(mods.nodes.find((n) => n.key === 'routes/users')?.ext?.src).toBe('local:packages/api/src/routes/users.ts')
		expect(mods.nodes.find((n) => n.key === 'db/migrations')?.ext?.src).toBe('local:packages/api/src/db/migrations')
		expect(mods.nodes.find((n) => n.key === 'server')?.ext?.src).toBe('local:packages/api/src/server.ts')
		// no generated pages at depth 1
		expect(parseOctoPages(r.code).pages.map((p) => p.name)).toEqual(['', 'api modules', 'core modules'])
	})

	it('depth 3: root → package → directory → file pages, named <parent> / <label>, with drills', async () => {
		const r = await scanDir(DEEP, { depth: 3 })
		const { pages, diagnostics } = parseOctoPages(r.code)
		expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		const names = pages.map((p) => p.name)
		// package page → directory → file → symbol
		expect(names).toContain('api modules / db/migrations')
		expect(names).toContain('api modules / db/migrations / 001_init.ts')
		expect(names).toContain('api modules / routes/users')
		expect(names).toContain('api modules / routes/users / listUsers')
		expect(names).toContain('api modules / server / Server')
		const dir = parsePage(r.code, 'api modules / db/migrations')!.ir
		expect(dir.nodes.find((n) => n.key === '001_init.ts')?.ext?.drill).toBe('api modules / db/migrations / 001_init.ts')
		expect(parsePage(r.code, 'api modules')!.ir.nodes.find((n) => n.key === 'routes/users')?.ext?.drill).toBe('api modules / routes/users')
		// references (gray files, externals) are not pre-expanded
		expect(names).not.toContain('api modules / routes/users / ../db/index.ts')
		expect(maxDepth(pageTree(r.code))).toBeGreaterThanOrEqual(3)
		// depth 1 pages are unchanged apart from the added drills
		const d1 = await scanDir(DEEP)
		expect(parsePage(d1.code, '')!.ir.nodes.map((n) => n.key)).toEqual(parsePage(r.code, '')!.ir.nodes.map((n) => n.key))
	})

	it('respects the page cap with a warning', async () => {
		const r = await scanDir(DEEP, { depth: 4, maxPages: 5 })
		expect(parseOctoPages(r.code).pages.length).toBeLessThanOrEqual(5)
		expect(r.warnings.some((w) => /page cap reached \(5 pages\)/.test(w))).toBe(true)
	})

	it('respects the time budget with a warning', async () => {
		const r = await scanDir(DEEP, { depth: 4, timeBudgetMs: -1 })
		expect(r.warnings.some((w) => /time budget reached/.test(w))).toBe(true)
	})

	it('scanSource stays pure (in-memory files) and uses the requested scheme', () => {
		const files = new Map([
			['package.json', JSON.stringify({ name: 'x', dependencies: { pg: '1' } })],
			['src/index.ts', "import { a } from './a'\nimport pg from 'pg'\nexport const main = () => a()\n"],
			['src/a.ts', 'export function a() { return 1 }\n'],
		])
		const r = scanSource(files, { srcScheme: 'github', source: 'github.com/o/r/tree/main', depth: 2 })
		expect(sourceDirective(r.code)).toBe('github.com/o/r/tree/main')
		expect(r.code).toContain('src: github:src/index.ts')
		expect(r.code).not.toContain('local:')
	})
})

describe('code expander (pure)', () => {
	it('directory: subdirs and files with aggregated imports, other repo parts and externals', async () => {
		const files = await deepFiles()
		const page = expandCode(files, parseSrc('local:packages/api/src'), {})!
		const keys = keysOf(page.body)
		expect(keys).toEqual(expect.arrayContaining(['db', 'routes', 'index.ts', 'server.ts', 'Postgres', 'core']))
		expect(page.children).toEqual(expect.arrayContaining(['db', 'routes', 'index.ts', 'server.ts']))
		expect(page.children).not.toContain('Postgres')
		const ir = parseOcto(page.body).ir
		expect(ir.edges.some((e) => e.from === 'server.ts' && e.to === 'routes')).toBe(true)
		expect(ir.edges.some((e) => e.from === 'routes' && e.to === 'db')).toBe(true)
		expect(ir.edges.some((e) => e.from === 'db' && e.to === 'Postgres')).toBe(true)
		expect(srcOf(page.body, 'core')).toBe('local:packages/core')
		expect(srcOf(page.body, 'Postgres')).toBe('local:packages/api/src#uses:Postgres')
	})

	it('a workspace dir skips a lone src/ folder', async () => {
		const page = expandCode(await deepFiles(), parseSrc('local:packages/api'), {})!
		expect(keysOf(page.body)).toContain('routes')
		expect((page.findings?.[0]?.notes ?? []).join(' ')).toMatch(/single folder src/)
	})

	it('a sibling directory import becomes a ../ reference', async () => {
		const page = expandCode(await deepFiles(), parseSrc('local:packages/api/src/db/migrations'), {})!
		expect(keysOf(page.body)).toEqual(expect.arrayContaining(['001_init.ts']))
		const ir = parseOcto(page.body).ir
		const ref = ir.nodes.find((n) => n.style?.color === 'gray')
		expect(ref?.ext?.src).toBe('local:packages/api/src/db/index.ts')
	})

	it('file: top-level symbols with calls, exports vs internals and imported files', async () => {
		const files = await deepFiles()
		const page = expandCode(files, parseSrc('local:packages/core/src/money.ts'), {})!
		const ir = parseOcto(page.body).ir
		expect(ir.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['Money', 'add', 'Currency', 'Amount', 'USD']))
		expect(srcOf(page.body, 'Money')).toBe('local:packages/core/src/money.ts#Money')
		expect(ir.edges.some((e) => e.from === 'add' && e.to === 'Money')).toBe(true)
		expect(ir.edges.some((e) => e.from === 'USD' && e.to === 'Currency')).toBe(true)
		const users = parseOcto(expandCode(files, parseSrc('local:packages/api/src/routes/users.ts'), {})!.body).ir
		expect(users.edges.some((e) => e.from === 'getUser' && e.to === 'listUsers' && e.line.dash === 'solid')).toBe(true)
		const dbRef = users.nodes.find((n) => n.key === '../db/index.ts')
		expect(dbRef?.style?.color).toBe('gray')
		expect(users.edges.some((e) => e.from === 'listUsers' && e.to === '../db/index.ts' && e.label === 'query')).toBe(true)
	})

	it('class: members with calls between them and the imports they use', async () => {
		const page = expandCode(await deepFiles(), parseSrc('local:packages/api/src/server.ts#Server'), {})!
		const ir = parseOcto(page.body).ir
		expect(ir.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['start', 'routes', 'handle', 'log', 'app', 'started']))
		expect(ir.edges.some((e) => e.from === 'start' && e.to === 'routes')).toBe(true)
		expect(ir.edges.some((e) => e.from === 'start' && e.to === 'log')).toBe(true)
		expect(ir.edges.some((e) => e.from === 'routes' && e.to === 'handle')).toBe(true)
		expect(srcOf(page.body, 'start')).toBe('local:packages/api/src/server.ts#Server.start')
		expect(ir.nodes.some((n) => n.key === './routes/users.ts')).toBe(true)
	})

	it('function and method: callers and callees', async () => {
		const files = await deepFiles()
		const fn = parseOcto(expandCode(files, parseSrc('local:packages/api/src/routes/users.ts#listUsers'), {})!.body).ir
		expect(fn.edges.some((e) => e.from === 'getUser' && e.to === 'listUsers')).toBe(true)
		expect(fn.edges.some((e) => e.from === 'listUsers' && e.to === 'User')).toBe(true)
		const m = parseOcto(expandCode(files, parseSrc('local:packages/api/src/server.ts#Server.log'), {})!.body).ir
		expect(m.edges.some((e) => e.from === 'start' && e.to === 'log')).toBe(true)
		expect(m.edges.some((e) => e.from === 'log' && e.to === 'started')).toBe(true)
	})

	it('dependency users', async () => {
		const page = expandCode(await deepFiles(), parseSrc('local:#uses:Postgres'), {})!
		expect(keysOf(page.body)).toEqual(['Postgres', 'packages/api/src/db/index.ts'])
	})

	it('caps pages at maxNodes and folds the rest', () => {
		const files = new Map<string, string>()
		for (let i = 0; i < 50; i++) files.set(`src/f${String(i).padStart(2, '0')}.ts`, `export const v${i} = ${i}\n`)
		const page = expandCode(files, parseSrc('local:src'), { maxNodes: 30 })!
		const nodes = nodesOf(page.body)
		expect(nodes.length).toBeLessThanOrEqual(30)
		expect(nodes.some((n) => /^\d+ more: /.test(n.label ?? ''))).toBe(true)
		const sym = new Map([['a.ts', Array.from({ length: 60 }, (_, i) => `export function f${i}() { return f${(i + 1) % 60}() }`).join('\n')]])
		expect(nodesOf(expandCode(sym, parseSrc('local:a.ts'), { maxNodes: 12 })!.body).length).toBeLessThanOrEqual(14)
	})

	it('Python, Go and Rust files expand too (best effort)', () => {
		const files = new Map([
			['m.py', 'import os\n\nclass Repo:\n    def get(self, k):\n        return self.load(k)\n\n    def load(self, k):\n        return os.environ.get(k)\n\ndef main():\n    Repo().get("x")\n'],
			['m.go', 'package m\n\ntype Store struct{ n int }\n\nfunc (s *Store) Get() int { return s.n }\n\nfunc New() *Store { return &Store{} }\n'],
			['m.rs', 'pub struct Cache { size: usize }\n\nimpl Cache {\n    pub fn new() -> Self { Cache { size: 0 } }\n    pub fn len(&self) -> usize { self.size }\n}\n\npub fn make() -> Cache { Cache::new() }\n'],
		])
		expect(keysOf(expandCode(files, parseSrc('local:m.py'), {})!.body)).toEqual(expect.arrayContaining(['Repo', 'main']))
		expect(keysOf(expandCode(files, parseSrc('local:m.py#Repo'), {})!.body)).toEqual(expect.arrayContaining(['get', 'load']))
		expect(keysOf(expandCode(files, parseSrc('local:m.go#Store'), {})!.body)).toContain('Get')
		expect(keysOf(expandCode(files, parseSrc('local:m.rs#Cache'), {})!.body)).toEqual(expect.arrayContaining(['new', 'len']))
	})

	it('returns null for unknown paths and symbols', async () => {
		const files = await deepFiles()
		expect(expandCode(files, parseSrc('local:nope'), {})).toBeNull()
		expect(expandCode(files, parseSrc('local:packages/core/src/money.ts#Nope'), {})).toBeNull()
	})
})

describe('config expander', () => {
	it('compose service, k8s objects (Secret values hidden) and terraform blocks', async () => {
		const compose = (await walkDir(join(FIX, 'compose'))).files
		const svc = expandInFiles(compose, parseSrc('local:docker-compose.yml#services.proxy'))
		expect(svc!.body).toMatch(/image: nginx:1\.27-alpine/)
		expect(keysOf(expandInFiles(compose, parseSrc('local:docker-compose.yml#services.api'))!.body)).toEqual(expect.arrayContaining(['build', 'environment', 'depends_on']))
		// env values are never shown
		const env = expandInFiles(compose, parseSrc('local:docker-compose.yml#services.api.environment'))!
		expect(env.body).not.toMatch(/postgres:\/\/|password|secret=/i)
		const k8s = (await walkDir(join(FIX, 'k8s'))).files
		const secret = expandConfig(k8s, 'data.yml', 'Secret/db-credentials')!
		expect(secret.body).toContain('data [')
		expect(secret.body).not.toContain('aHVudGVyMi1kby1ub3QtbGVhaw')
		const data = expandConfig(k8s, 'data.yml', 'Secret/db-credentials.data')!
		expect(data.body).toContain('password')
		expect(data.body).not.toContain('aHVudGVyMi1kby1ub3QtbGVhaw')
		const tf = (await walkDir(join(FIX, 'terraform'))).files
		const tfFile = [...tf.keys()].find((p) => p.endsWith('main.tf'))!
		const top = expandConfig(tf, tfFile, undefined)!
		const first = nodesOf(top.body)[0]
		const block = expandInFiles(tf, parseSrc(first.ext!.src!))
		expect(block).not.toBeNull()
	})
})

describe('deepen', () => {
	it('expands the same src once and cuts at the depth', () => {
		const code = 'A [src: "t:a"]\nB [src: "t:a"]\n'
		let calls = 0
		const r = deepenSync(code, (req): ExpandedPage => {
			calls++
			return { body: `${req.name.replace(/\W/g, '')}child [src: "t:${req.src.path}/c"]\n`, children: [`${req.name.replace(/\W/g, '')}child`] }
		}, { depth: 2 })
		expect(calls).toBe(2)
		const out = applyDeepen(code, r)
		expect(parsePage(out, '')!.ir.nodes.map((n) => n.ext?.drill)).toEqual(['A', 'A'])
		expect(parseOctoPages(out).pages.map((p) => p.name)).toEqual(['', 'A', 'A / Achild'])
	})
})

describe('expandNode', () => {
	it('expands a local symbol from the source directive, several levels deep', async () => {
		const r = await expandNode({ source: DEEP, src: 'local:packages/api/src/server.ts', node: { key: 'server' }, parentPage: 'api modules', depth: 2 }, ctx)
		expect(r.title).toBe('api modules / server')
		expect(r.pages).toContain('api modules / server / Server')
		const doc = `title x\n\npage ${r.title}\n${r.body}`
		expect(parseOctoPages(doc).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(parsePage(doc, r.title)!.ir.nodes.find((n) => n.key === 'Server')?.ext?.drill).toBe('api modules / server / Server')
	})

	it('avoids existing page names', async () => {
		const r = await expandNode({ source: DEEP, src: 'local:packages/core/src/money.ts', node: { key: 'money' }, parentPage: '', existingPages: ['', 'money'] }, ctx)
		expect(r.title).toBe('money 2')
	})

	it('errors: no source, unknown src, unknown kind, path traversal', async () => {
		await expect(expandNode({ source: '', src: 'local:packages', node: { key: 'x' }, parentPage: '' }, ctx)).rejects.toMatchObject({ status: 400 })
		await expect(expandNode({ source: DEEP, src: 'local:nope/x', node: { key: 'x' }, parentPage: '' }, ctx)).rejects.toBeInstanceOf(ConnectorError)
		await expect(expandNode({ source: DEEP, src: 'zzz:x', node: { key: 'x' }, parentPage: '' }, ctx)).rejects.toMatchObject({ status: 501 })
		await expect(expandNode({ source: join(DEEP, 'packages/api'), src: 'local:../core/src/money.ts', node: { key: 'x' }, parentPage: '' }, ctx)).rejects.toMatchObject({ status: 404 })
	})

	it('the local file source never reads outside its root', async () => {
		const fs = localFileSource(join(DEEP, 'packages/api'))
		expect(await fs.read('../core/src/money.ts')).toBeNull()
		expect(await fs.read('/etc/passwd')).toBeNull()
		expect(await fs.read('src/index.ts')).toContain('Server')
		expect(await fs.list()).toContain('src/server.ts')
	})

	it('plugs in registered expanders (e.g. Hugging Face) and recurses through their children', async () => {
		const off = registerExpander('huggingface', async (req) => {
			const path = req.src.fragment ?? ''
			if (path.split('.').length > 2) return null
			const child = path ? `${path}.0` : 'layers'
			return { body: `${child.replace(/\./g, '_')} [src: "hf:${req.src.path}#${child}"]\n`, children: [child.replace(/\./g, '_')] }
		})
		try {
			const r = await expandNode({ source: 'hf:org/model', src: 'hf:org/model', node: { key: 'model' }, parentPage: '', depth: 3 }, ctx)
			expect(r.pages).toEqual(['model', 'model / layers', 'model / layers / layers_0'])
		} finally {
			off()
		}
	})
})
