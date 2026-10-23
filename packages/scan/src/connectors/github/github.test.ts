import { describe, expect, it } from 'vitest'
import { fixture } from '../../test/helpers'
import { checkDocument } from '../../test/helpers'
import { resolveSource, scanAny } from '../index'
import { ConnectorError } from '../types'
import { parseGithub, scanGithub, shortTitle } from './index'

describe('parseGithub', () => {
	it('accepts URLs and shorthands', () => {
		expect(parseGithub('https://github.com/docker/awesome-compose')).toEqual({ kind: 'github', id: 'docker/awesome-compose' })
		expect(parseGithub('github.com/o/r.git')).toEqual({ kind: 'github', id: 'o/r' })
		expect(parseGithub('https://github.com/docker/awesome-compose/tree/master/react-express-mongodb')).toMatchObject({ id: 'docker/awesome-compose', ref: 'master', options: { subdir: 'react-express-mongodb' } })
		expect(parseGithub('o/r@v1.2')).toEqual({ kind: 'github', id: 'o/r', ref: 'v1.2' })
		expect(parseGithub('o/r@main/apps/web')).toMatchObject({ id: 'o/r', ref: 'main', options: { subdir: 'apps/web' } })
		expect(parseGithub('github:o/r/sub')).toMatchObject({ id: 'o/r', options: { subdir: 'sub' } })
		expect(parseGithub('git@github.com:o/r.git')).toEqual({ kind: 'github', id: 'o/r' })
		expect(parseGithub('o/r')).toEqual({ kind: 'github', id: 'o/r' })
		// a deeper relative path is a folder, not a repo
		expect(parseGithub('apps/web/src')).toBeNull()
		expect(parseGithub('/abs/path')).toBeNull()
		expect(parseGithub('hf:org/model')).toBeNull()
	})

	it('is found by the registry', () => {
		expect(resolveSource('github.com/o/r')?.connector.kind).toBe('github')
	})
})

/** A fake GitHub: REST API + raw contents served from a fixture file map. */
async function fakeGithub(opts: { rateLimited?: boolean; status?: number } = {}) {
	const files = await fixture('monorepo')
	const calls: { url: string; auth?: string }[] = []
	const prefix = 'shop/'
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
		calls.push({ url, auth })
		const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
		if (opts.rateLimited) return json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' })
		if (opts.status) return json({ message: 'nope' }, opts.status)
		if (url === 'https://api.github.com/repos/acme/mono') return json({ description: 'Acme shop', default_branch: 'main', html_url: 'https://github.com/acme/mono' })
		if (url === 'https://api.github.com/repos/acme/mono/languages') return json({ TypeScript: 900, Python: 100 })
		if (url.startsWith('https://api.github.com/repos/acme/mono/git/trees/')) {
			const ref = decodeURIComponent(url.split('/git/trees/')[1].split('?')[0])
			if (ref !== 'main' && ref !== 'feature/x') return json({ message: 'Not Found' }, 404)
			const tree = [...files.keys()].map((p) => ({ path: prefix + p, type: 'blob', size: files.get(p)!.length }))
			tree.push({ path: 'shop/logo.png', type: 'blob', size: 10 }, { path: 'shop/node_modules/x/package.json', type: 'blob', size: 10 }, { path: 'shop/apps', type: 'tree', size: 0 }, { path: 'README.md', type: 'blob', size: 5 })
			return json({ tree, truncated: false })
		}
		const raw = /^https:\/\/raw\.githubusercontent\.com\/acme\/mono\/(main|feature\/x)\/(.+)$/.exec(url)
		if (raw) {
			const path = decodeURIComponent(raw[2]).slice(prefix.length)
			return files.has(path) ? new Response(files.get(path)) : new Response('404', { status: 404 })
		}
		return json({ message: `unexpected ${url}` }, 500)
	}) as typeof fetch
	return { fetch: fetchFn, calls, files }
}

describe('scanGithub (mocked fetch)', () => {
	it('fetches the tree and only scannable files, scans them and links nodes to GitHub', async () => {
		const gh = await fakeGithub()
		const r = await scanGithub({ kind: 'github', id: 'acme/mono', options: { subdir: 'shop' } }, { fetch: gh.fetch, env: { GITHUB_TOKEN: 'ghp_secret' } })
		const { pages, problems } = checkDocument(r.code)
		expect(problems).toEqual([])
		expect(r.code).toMatch(/^title acme\/mono\/shop\n/)
		expect(r.code).toContain('// repo languages: TypeScript 90%, Python 10%')
		const api = pages[0].ir.nodes.find((n) => n.key === 'api')!
		expect(api.link).toBe('https://github.com/acme/mono/tree/main/shop/apps/api')
		expect(pages.map((p) => p.name)).toContain('CI/CD')
		expect(r.source).toMatchObject({ kind: 'github', id: 'acme/mono', ref: 'main', options: { subdir: 'shop' } })
		expect(r.findings[0]).toMatchObject({ analyzer: 'github', confidence: 1 })
		// never fetched: binaries, node_modules, files outside the subdir; the token only goes to GitHub hosts and never into results
		const urls = gh.calls.map((c) => c.url)
		expect(urls.some((u) => /logo\.png|node_modules|README/.test(u))).toBe(false)
		expect(gh.calls.every((c) => c.auth === 'Bearer ghp_secret' && /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(c.url))).toBe(true)
		expect(JSON.stringify({ ...r, files: undefined })).not.toContain('ghp_secret')
		expect(r.files?.has('apps/api/src/index.ts')).toBe(true)
	})

	it('resolves refs with slashes from /tree/ URLs', async () => {
		const gh = await fakeGithub()
		const ref = parseGithub('https://github.com/acme/mono/tree/feature/x/shop')!
		const r = await scanGithub(ref, { fetch: gh.fetch, env: {} })
		expect(r.source).toMatchObject({ ref: 'feature/x', options: { subdir: 'shop' } })
		expect(gh.calls.every((c) => c.auth === undefined)).toBe(true)
	})

	it('respects the file budget', async () => {
		const gh = await fakeGithub()
		const r = await scanGithub({ kind: 'github', id: 'acme/mono', options: { subdir: 'shop', maxFiles: 5 } }, { fetch: gh.fetch, env: {} })
		expect(r.files?.size).toBe(5)
		// manifests first
		expect([...r.files!.keys()]).toEqual(expect.arrayContaining(['package.json', 'pnpm-workspace.yaml']))
		expect(r.warnings.join(' ')).toMatch(/fetched 5 of/)
	})

	it('reports rate limits and missing repos clearly', async () => {
		const limited = await fakeGithub({ rateLimited: true })
		await expect(scanGithub({ kind: 'github', id: 'acme/mono' }, { fetch: limited.fetch, env: {} })).rejects.toThrow(/rate limit exceeded \(resets at \d\d:\d\d UTC\)\. Set GITHUB_TOKEN/)
		const missing = await fakeGithub({ status: 404 })
		const err = await scanGithub({ kind: 'github', id: 'acme/nope' }, { fetch: missing.fetch, env: {} }).catch((e) => e)
		expect(err).toBeInstanceOf(ConnectorError)
		expect(err.status).toBe(404)
		expect(err.message).toMatch(/not found \(private repos need GITHUB_TOKEN\)/)
	})

	it('scanAny dispatches by input', async () => {
		const gh = await fakeGithub()
		const r = await scanAny('github:acme/mono/shop', { fetch: gh.fetch, env: {} })
		expect(r.source.id).toBe('acme/mono')
		await expect(scanAny('???', { fetch: gh.fetch, env: {} })).rejects.toThrow(/not a recognised source/)
	})

	it('shortens long descriptions for titles', () => {
		expect(shortTitle('Eraser-style diagram-as-code editor: human drawing, AI-agent drawing, diagrams as code, and AI import')).toBe('Eraser-style diagram-as-code editor')
		expect(shortTitle('Short')).toBe('Short')
	})
})
