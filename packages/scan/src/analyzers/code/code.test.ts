import { resolveIcon } from '@octo-draw/core'
import { describe, expect, it } from 'vitest'
import { fixture, files } from '../../test/helpers'
import { EXTERNALS, externalFor } from './externals'
import { extractImports, packageOf, resolveImport } from './imports'
import { analyzeCode } from './index'
import { findWorkspaces } from './workspaces'

describe('workspaces', () => {
	it('finds pnpm workspaces plus Python projects in subdirs', async () => {
		const { sources, workspaces } = findWorkspaces(await fixture('monorepo'))
		expect(sources).toEqual(['pnpm-workspace.yaml', 'Python projects'])
		expect(workspaces.map((w) => [w.name, w.dir, w.lang])).toEqual([
			['@acme/api', 'apps/api', 'js'],
			['@acme/web', 'apps/web', 'js'],
			['@acme/shared', 'packages/shared', 'js'],
			['acme-ml', 'services/ml', 'python'],
		])
		expect(workspaces.find((w) => w.name === 'acme-ml')?.deps).toEqual(['fastapi', 'uvicorn', 'openai', 'redis'])
	})

	it('reads package.json workspaces, go.work and Cargo workspaces', () => {
		expect(findWorkspaces(files({ 'package.json': '{"workspaces":{"packages":["libs/*"]}}', 'libs/a/package.json': '{"name":"a"}', 'libs/b/package.json': '{"name":"b","dependencies":{"a":"*"}}' })).workspaces.map((w) => w.name)).toEqual(['a', 'b'])
		const go = findWorkspaces(files({ 'go.work': 'go 1.22\n\nuse (\n\t./svc/api\n\t./lib\n)\n', 'svc/api/go.mod': 'module example.com/api\n\nrequire (\n\tgithub.com/redis/go-redis/v9 v9.5.1\n\tgithub.com/x/y v1.0.0 // indirect\n)\n', 'lib/go.mod': 'module example.com/lib\n' }))
		expect(go.workspaces.map((w) => w.name)).toEqual(['example.com/lib', 'example.com/api'])
		expect(go.workspaces[1].deps).toEqual(['github.com/redis/go-redis/v9'])
		const cargo = findWorkspaces(files({ 'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n', 'crates/core/Cargo.toml': '[package]\nname = "core"\n\n[dependencies]\nsqlx = "0.7"\n', 'crates/cli/Cargo.toml': '[package]\nname = "cli"\n[dependencies]\ncore = { path = "../core" }\n' }))
		expect(cargo.workspaces.map((w) => [w.name, w.deps])).toEqual([['cli', ['core']], ['core', ['sqlx']]])
	})

	it('falls back to the root package', () => {
		expect(findWorkspaces(files({ 'package.json': '{"name":"solo"}' })).workspaces.map((w) => w.dir)).toEqual([''])
	})
})

describe('imports', () => {
	it('extracts TS/JS, Go and Python imports', () => {
		expect(extractImports(`import a from './a'\nimport type { B } from "../b"\nexport * from './c.js'\nconst d = await import('./d')\nconst e = require('e')\n// import x from 'commented'\nimport './side'`, 'js')).toEqual(['./a', '../b', './c.js', './side', './d', 'e'])
		expect(extractImports('package main\nimport (\n\t"fmt"\n\tr "github.com/redis/go-redis/v9"\n)\nimport "example.com/api/internal/db"', 'go')).toEqual(['example.com/api/internal/db', 'fmt', 'github.com/redis/go-redis/v9'])
		expect(extractImports('from . import a, b\nfrom .x import (\n  y,\n)\nimport os, sys\nfrom pkg.sub import z', 'python')).toEqual(['.a', '.b', '.x', 'pkg.sub', 'os', 'sys'])
	})

	it('resolves relative paths, .js → .ts, index files and tsconfig paths', () => {
		const f = files({ 'src/a.ts': '', 'src/b/index.ts': '', 'src/c.tsx': '', 'tsconfig.json': '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }' })
		const ctx = { dir: '', tsPaths: { baseDir: '', paths: [['@/*', ['src/*']]] as [string, string[]][] } }
		expect(resolveImport(f, 'src/x.ts', './a.js', 'js', ctx)).toEqual({ file: 'src/a.ts' })
		expect(resolveImport(f, 'src/x.ts', './b', 'js', ctx)).toEqual({ file: 'src/b/index.ts' })
		expect(resolveImport(f, 'src/x.ts', '@/c', 'js', ctx)).toEqual({ file: 'src/c.tsx' })
		expect(resolveImport(f, 'src/x.ts', '@scope/pkg/deep', 'js', ctx)).toEqual({ pkg: '@scope/pkg' })
		expect(packageOf('node:fs')).toBeNull()
	})
})

describe('externals table', () => {
	it('maps dependencies to systems and every icon resolves', () => {
		for (const row of EXTERNALS) expect(resolveIcon(row.icon), row.icon).not.toBeNull()
		expect(externalFor('pg')?.system).toBe('Postgres')
		expect(externalFor('@prisma/client')?.system).toBe('Postgres')
		expect(externalFor('ioredis')?.system).toBe('Redis')
		expect(externalFor('kafkajs')?.system).toBe('Kafka')
		expect(externalFor('@aws-sdk/client-s3')?.icon).toBe('aws-s3')
		expect(externalFor('@anthropic-ai/sdk')?.system).toBe('LLM API')
		expect(externalFor('openai')?.system).toBe('OpenAI API')
		expect(externalFor('github.com/stripe/stripe-go/v78')?.system).toBe('Stripe')
		expect(externalFor('left-pad')).toBeNull()
	})
})

describe('code analyzer', () => {
	it('builds the workspace graph, externals and HTTP links', async () => {
		const r = analyzeCode(await fixture('monorepo'))
		const byKey = Object.fromEntries(r.root.nodes.map((n) => [n.key, n]))
		expect(byKey.api).toMatchObject({ role: 'service', icon: 'express', label: '@acme/api', drill: 'api modules' })
		expect(byKey.web).toMatchObject({ role: 'frontend', icon: 'react' })
		expect(byKey.shared.role).toBe('library')
		expect(byKey['acme-ml']).toMatchObject({ role: 'service', icon: 'fastapi' })
		expect(byKey.api.facts).toEqual(expect.arrayContaining(['port 4000', 'Dockerfile']))
		const edges = r.root.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`)
		expect(edges).toEqual(expect.arrayContaining(['api>shared', 'web>shared', 'web>api:HTTP :4000', 'Users>web', 'api>Postgres', 'api>Redis', 'api>Kafka', 'api>Stripe', 'api>LLM API', 'api>S3', 'acme-ml>OpenAI API', 'acme-ml>Redis']))
		// the commented localhost:9999 does not count; the test dir is skipped
		expect(byKey.api.facts?.join(' ')).not.toContain('9999')
	})

	it('builds a module page per package with directory-level import edges and per-module externals', async () => {
		const r = analyzeCode(await fixture('monorepo'))
		const api = r.pages.find((p) => p.name === 'api modules')!
		const keys = api.nodes.map((n) => n.key)
		expect(keys).toEqual(expect.arrayContaining(['index', 'routes/users', 'routes/billing', 'db', 'db/cache', 'lib', 'shared', 'Postgres', 'Redis', 'Stripe']))
		expect(keys.some((k) => k.includes('__tests__'))).toBe(false)
		const edges = api.edges.map((e) => `${e.from}>${e.to}`)
		expect(edges).toEqual(expect.arrayContaining(['index>routes/users', 'routes/users>db', 'routes/users>db/cache', 'db>Postgres', 'db/cache>Redis', 'routes/billing>Stripe', 'routes/users>shared']))
		expect(api.nodes.find((n) => n.key === 'index')?.icon).toBe('express')
		const ml = r.pages.find((p) => p.name === 'acme-ml modules')!
		expect(ml.edges.map((e) => `${e.from}>${e.to}`)).toEqual(expect.arrayContaining(['main>model', 'main>store', 'model>store', 'store>Redis', 'model>OpenAI API']))
	})

	it('caps module pages and folds the rest', () => {
		const f: Record<string, string> = { 'package.json': '{"name":"big"}' }
		for (let i = 0; i < 40; i++) f[`src/m${String(i).padStart(2, '0')}.ts`] = i ? `import '../src/m00'\nimport './m${String(i - 1).padStart(2, '0')}'` : ''
		const r = analyzeCode(files(f), { maxModuleNodes: 10 })
		const page = r.pages[0]
		expect(page.nodes.length).toBeLessThanOrEqual(10)
		expect(page.nodes.find((n) => n.key === 'other modules')?.label).toMatch(/more modules/)
	})
})
