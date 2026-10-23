/**
 * Test helper: a fake Hugging Face Hub serving `fixtures/hf/` through a
 * `fetch` lookalike. Layout: `<models|datasets|spaces|collections>/<org>__<name>/api.json`
 * plus raw files; datasets add `info.json` (datasets-server) and
 * `trained-models.json` (`/api/models?filter=dataset:...`).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const HF_FIXTURES = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'hf')

export interface FakeHubOptions {
	/** Repo files that answer 401 unless an Authorization header is sent. */
	gated?: string[]
	/** Every request answers this status. */
	status?: number
	rateLimited?: boolean
}

export interface Call {
	url: string
	auth?: string
}

const dir = (kind: string, id: string) => join(HF_FIXTURES, kind, id.replace('/', '__'))

export function fakeHub(opts: FakeHubOptions = {}) {
	const calls: Call[] = []
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		const auth = (init?.headers as Record<string, string> | undefined)?.Authorization
		calls.push({ url, auth })
		const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
		const file = (p: string) => (existsSync(p) ? new Response(readFileSync(p, 'utf8')) : new Response('Entry not found', { status: 404 }))
		if (opts.rateLimited) return json({ error: 'rate limited' }, 429, { ratelimit: '"api";r=0;t=42' })
		if (opts.status) return json({ error: 'nope' }, opts.status)
		const u = new URL(url)
		if (u.hostname === 'datasets-server.huggingface.co') {
			const ds = u.searchParams.get('dataset') ?? ''
			if (u.pathname === '/info') return file(join(dir('datasets', ds), 'info.json'))
			return json({ error: 'not found' }, 404)
		}
		if (u.hostname !== 'huggingface.co') return json({ error: `unexpected ${url}` }, 500)
		const path = decodeURIComponent(u.pathname)
		let m = /^\/api\/(models|datasets|spaces)\/([^/]+\/[^/]+)$/.exec(path)
		if (m) {
			const p = join(dir(m[1], m[2]), 'api.json')
			return existsSync(p) ? file(p) : json({ error: 'Invalid username or password.' }, 401)
		}
		m = /^\/api\/collections\/([^/]+\/[^/]+)$/.exec(path)
		if (m) return file(join(dir('collections', m[1]), 'api.json'))
		if (path === '/api/models' && u.searchParams.get('filter')?.startsWith('dataset:')) {
			const p = join(dir('datasets', u.searchParams.get('filter')!.slice(8)), 'trained-models.json')
			return existsSync(p) ? file(p) : json([])
		}
		m = /^\/(?:(datasets|spaces)\/)?([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(path)
		if (m) {
			const kind = m[1] ?? 'models'
			const rel = `${m[2]}/${m[3]}`
			if (opts.gated?.includes(rel) && !auth) return new Response('Access to model is restricted.', { status: 401 })
			return file(join(dir(kind, m[2]), m[3]))
		}
		return json({ error: `unexpected ${url}` }, 404)
	}) as typeof fetch
	return { fetch: fetchFn, calls }
}

export function fixtureJson<T = unknown>(rel: string): T {
	return JSON.parse(readFileSync(join(HF_FIXTURES, rel), 'utf8')) as T
}

export function fixtureText(rel: string): string {
	return readFileSync(join(HF_FIXTURES, rel), 'utf8')
}
