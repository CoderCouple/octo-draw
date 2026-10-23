import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanSource } from './scan'
import { checkDocument, fixture, files } from './test/helpers'

describe('scanSource', () => {
	it('merges code, compose and openapi into one document with drill-down pages', async () => {
		const r = scanSource(await fixture('monorepo'), { rootName: 'monorepo' })
		const { pages, problems } = checkDocument(r.code)
		expect(problems).toEqual([])
		expect(r.code.startsWith('title acme architecture\n')).toBe(true)
		expect(pages[0].ir.direction).toBe('right')
		const root = pages[0].ir
		const keys = root.nodes.map((n) => n.key)
		// compose "api"/"web" merged into the workspaces; Postgres/Redis from deps merged into compose services
		expect(keys.filter((k) => k === 'api')).toHaveLength(1)
		expect(keys).toEqual(expect.arrayContaining(['api', 'web', 'shared', 'acme-ml', 'postgres', 'redis', 'pgdata volume', 'Internet', 'Kafka', 'Stripe']))
		expect(keys).not.toContain('Postgres')
		expect(keys).not.toContain('Users')
		const edges = root.edges.map((e) => `${e.from}>${e.to}`)
		expect(edges).toEqual(expect.arrayContaining(['api>postgres', 'api>redis', 'Internet>api', 'Internet>web', 'web>api', 'acme-ml>redis']))
		expect(root.nodes.find((n) => n.key === 'api')?.ext?.drill).toBe('api modules')
		expect(pages.map((p) => p.name)).toEqual(['', 'api modules', 'web modules', 'shared modules', 'acme-ml modules', 'API Acme API'])
		// the spec hangs off the api module page
		expect(pages[1].ir.nodes.find((n) => n.key === 'Acme API')?.ext?.drill).toBe('API Acme API')
		expect(r.findings.map((f) => f.analyzer)).toEqual(['code', 'compose', 'openapi'])
		expect(r.pages).toHaveLength(5)
	})

	it('is deterministic', async () => {
		const f = await fixture('monorepo')
		expect(scanSource(f).code).toBe(scanSource(new Map([...f].reverse())).code)
	})

	it('respects --only and puts Kubernetes / Terraform on their own pages next to code', async () => {
		const mono = await fixture('monorepo')
		expect(scanSource(mono, { only: ['compose'] }).findings.map((f) => f.analyzer)).toEqual(['compose'])
		const tf = await fixture('terraform')
		const combined = new Map([...mono, ...[...tf].map(([k, v]) => [`infra/${k}`, v] as [string, string])])
		const r = scanSource(combined)
		const { pages, problems } = checkDocument(r.code)
		expect(problems).toEqual([])
		expect(pages.find((p) => p.name === '')!.ir.nodes.find((n) => n.key === 'Infrastructure')?.ext?.drill).toBe('Terraform infrastructure')
		expect(pages.map((p) => p.name)).toContain('Terraform infrastructure')
	})

	it('uses infra as the root when there is no code', async () => {
		for (const name of ['compose', 'k8s', 'terraform', 'openapi']) {
			const r = scanSource(await fixture(name), { rootName: name })
			const { pages, problems } = checkDocument(r.code)
			expect(problems, name).toEqual([])
			expect(pages[0].ir.nodes.length, name).toBeGreaterThan(0)
		}
	})

	it('adds a CI/CD page from GitHub Actions when asked', async () => {
		const r = scanSource(await fixture('monorepo'), { ci: true })
		const { pages, problems } = checkDocument(r.code)
		expect(problems).toEqual([])
		expect(pages[0].ir.nodes.find((n) => n.key === 'CI/CD')?.ext?.drill).toBe('CI/CD')
		expect(r.findings.map((f) => f.analyzer)).toContain('actions')
	})

	it('warns when nothing is recognised', () => {
		const r = scanSource(files({ 'notes.md': '# hi' }))
		expect(r.warnings.join(' ')).toMatch(/no architecture found/)
		expect(checkDocument(r.code).problems).toEqual([])
	})

	it('keeps analyzers and the GitHub connector platform-free (only node.ts and tests import node:)', () => {
		// other connectors (Hugging Face, cloud) are owned elsewhere and may need node APIs
		const skip = /\/connectors\/(huggingface|cloud)\//
		const bad: string[] = []
		const walk = (d: string) => {
			for (const name of readdirSync(d)) {
				const p = join(d, name)
				if (skip.test(p + '/')) continue
				if (statSync(p).isDirectory()) walk(p)
				else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && name !== 'node.ts' && !p.includes('/test/') && /from 'node:/.test(readFileSync(p, 'utf8'))) bad.push(p)
			}
		}
		walk(import.meta.dirname)
		expect(bad).toEqual([])
	})
})
