import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseOctoPages, parsePage } from '@octo-draw/core'
import { createApp } from './app'
import type { Message, StreamFn, StreamRequest } from './claude'
import { DocStore } from './docStore'
import { cleanBody } from './expand'

const FIXTURES = resolve(import.meta.dirname, '../../../packages/scan/fixtures')
const DEEP = join(FIXTURES, 'deep-repo')
const env = { OCTO_SCAN_ROOTS: FIXTURES, GITHUB_TOKEN: 'ghp_server_only' }
const msg = (text: string): Message => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) as unknown as Message

let server: Server | undefined
afterEach(() => {
	server?.closeAllConnections()
	server?.close()
	server = undefined
})

async function start(getStream: () => StreamFn | null = () => null, fetchFn: typeof fetch = fetch) {
	server = createServer(createApp({ store: new DocStore(null), getStream, scan: { env, fetch: fetchFn, useGhCli: false } }))
	await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

/** Fake model: streams `text` in small chunks, records requests. */
function fakeStream(replies: string[], requests: StreamRequest[] = []): StreamFn {
	let i = 0
	return async (req, onText) => {
		requests.push(req)
		const text = replies[Math.min(i++, replies.length - 1)]
		for (let at = 0; at < text.length; at += 7) onText?.(text.slice(at, at + 7))
		return msg(text)
	}
}

function sseEvents(text: string): Record<string, unknown>[] {
	return text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
}

const doc = (body: string) => `title Shop\nsource ${DEEP}\n${body}`

describe('POST /api/expand (source)', () => {
	it('expands a scanned node from its src into a new page and patches drill (JSON)', async () => {
		const base = await start()
		const code = doc('api [src: local:packages/api]\nserver [src: local:packages/api/src/server.ts]\napi > server\n')
		const res = await post(base, '/api/expand', { code, node: 'server', mode: 'source', stream: false })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { code: string; page: string; pages: string[]; mode: string }
		expect(body.mode).toBe('source')
		expect(body.page).toBe('server')
		expect(parsePage(body.code, '')!.ir.nodes.find((n) => n.key === 'server')?.ext?.drill).toBe('server')
		expect(parsePage(body.code, 'server')!.ir.nodes.map((n) => n.key)).toContain('Server')
		expect(parseOctoPages(body.code).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	})

	it('streams the result over SSE by default, with depth', async () => {
		const base = await start()
		const code = doc('page api modules\nroutes [src: local:packages/api/src/routes]\n')
		const res = await post(base, '/api/expand', { code, page: 'api modules', node: 'routes', depth: 2 })
		expect(res.headers.get('content-type')).toMatch(/event-stream/)
		const done = sseEvents(await res.text()).find((e) => e.done) as { code: string; pages: string[] }
		expect(done.pages).toEqual(expect.arrayContaining(['api modules / routes', 'api modules / routes / users.ts']))
		expect(parsePage(done.code, 'api modules')!.ir.nodes[0].ext?.drill).toBe('api modules / routes')
	})

	it('auto mode uses the source expander when src resolves', async () => {
		const requests: StreamRequest[] = []
		const base = await start(() => fakeStream(['X > Y'], requests))
		const code = doc('money [src: local:packages/core/src/money.ts]\n')
		const res = await post(base, '/api/expand', { code, node: 'money', stream: false })
		expect(((await res.json()) as { mode: string }).mode).toBe('source')
		expect(requests).toHaveLength(0)
	})

	it('refuses sources outside OCTO_SCAN_ROOTS and foreign origins', async () => {
		const base = await start()
		const outside = `source ${resolve(FIXTURES, '..', 'src')}\nx [src: local:index.ts]\n`
		const res = await post(base, '/api/expand', { code: outside, node: 'x', mode: 'source', stream: false })
		expect(res.status).toBe(403)
		const foreign = await post(base, '/api/expand', { code: doc('x [src: local:packages]\n'), node: 'x', mode: 'source' }, { Origin: 'https://evil.example' })
		expect(foreign.status).toBe(403)
		const traversal = await post(base, '/api/expand', { code: doc('x [src: "local:../../src/scan.ts"]\n'), node: 'x', mode: 'source', stream: false })
		expect(traversal.status).toBe(404)
	})

	it('validates the request', async () => {
		const base = await start()
		expect((await post(base, '/api/expand', { code: 'A', node: 'B', mode: 'source' })).status).toBe(404)
		expect((await post(base, '/api/expand', { code: 'A', node: 'A', page: 'Nope' })).status).toBe(404)
		expect((await post(base, '/api/expand', { code: 'A [drill: P]\n\npage P\nB\n', node: 'A' })).status).toBe(409)
		expect((await post(base, '/api/expand', { code: 'A', node: 'A', mode: 'nope' })).status).toBe(400)
		expect((await post(base, '/api/expand', { code: 'A [src: local:x]', node: 'A', mode: 'source' })).status).toBe(400)
		// no src and no credentials
		expect((await post(base, '/api/expand', { code: 'A', node: 'A' })).status).toBe(503)
	})

	it('GitHub sources use the server-side token and never return it', async () => {
		const seen: string[] = []
		const fake = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			seen.push((init?.headers as Record<string, string>).Authorization ?? '')
			if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'src/app.ts', type: 'blob', size: 80 }, { path: 'src/util.ts', type: 'blob', size: 40 }] })
			if (url.endsWith('/src/app.ts')) return new Response("import { helper } from './util'\nexport function main() { return helper() }\n")
			if (url.endsWith('/src/util.ts')) return new Response('export function helper() { return 1 }\n')
			return new Response('', { status: 404 })
		}) as typeof fetch
		const base = await start(() => null, fake)
		const code = 'title Svc\nsource github.com/acme/svc/tree/main\napp [src: github:src/app.ts]\n'
		const res = await post(base, '/api/expand', { code, node: 'app', mode: 'source', stream: false })
		const text = await res.text()
		expect(res.status).toBe(200)
		expect(text).not.toContain('ghp_server_only')
		const out = JSON.parse(text) as { code: string }
		expect(parsePage(out.code, 'app')!.ir.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['main', './util.ts']))
		expect(seen.length).toBeGreaterThan(0)
		expect(seen.every((a) => a === 'Bearer ghp_server_only')).toBe(true)
	})
})

describe('POST /api/expand (ai, fake model)', () => {
	it('streams a page body, sends the full doc and neighbours, and patches drill', async () => {
		const requests: StreamRequest[] = []
		const base = await start(() => fakeStream(['```octo\ndirection right\nValidate > Charge\nCharge > "Card network" [color: gray]\n```'], requests))
		const code = 'title Checkout\nAPI > Payments: charge\nPayments > Ledger\n\npage Orders\nCreate > Ship\n'
		const res = await post(base, '/api/expand', { code, node: 'Payments' })
		const events = sseEvents(await res.text())
		expect(events.some((e) => typeof e.delta === 'string')).toBe(true)
		const done = events.find((e) => e.done) as { code: string; page: string; mode: string }
		expect(done.mode).toBe('ai')
		expect(done.page).toBe('Payments')
		expect(parsePage(done.code, '')!.ir.nodes.find((n) => n.key === 'Payments')?.ext?.drill).toBe('Payments')
		expect(parsePage(done.code, 'Payments')!.ir.nodes.map((n) => n.key)).toEqual(['Validate', 'Charge', 'Card network'])
		expect(parsePage(done.code, 'Orders')!.ir.nodes.map((n) => n.key)).toEqual(['Create', 'Ship'])
		const prompt = String(requests[0].messages[0].content)
		expect(prompt).toContain('page Orders')
		expect(prompt).toContain('API -> Payments: charge')
		expect(prompt).toContain('Payments -> Ledger')
		expect(requests[0].system).toMatch(/drill-down author/)
	})

	it('repairs once when the body does not parse', async () => {
		const requests: StreamRequest[] = []
		const base = await start(() => fakeStream(['A [label: "broken]\n', 'A > B\n'], requests))
		const res = await post(base, '/api/expand', { code: 'X > Svc\n', node: 'Svc', mode: 'ai', stream: false })
		const body = (await res.json()) as { code: string; warnings: string[] }
		expect(requests).toHaveLength(2)
		expect(String(requests[1].messages[2].content)).toMatch(/parse errors/)
		expect(parsePage(body.code, 'Svc')!.ir.nodes.map((n) => n.key)).toEqual(['A', 'B'])
		expect(body.warnings).toEqual([])
	})

	it('auto mode falls back to AI when the source expander fails', async () => {
		const base = await start(() => fakeStream(['Inner > Parts\n']))
		const code = doc('ghost [src: local:does/not/exist]\n')
		const body = (await (await post(base, '/api/expand', { code, node: 'ghost', stream: false })).json()) as { mode: string; warnings: string[] }
		expect(body.mode).toBe('ai')
		expect(body.warnings[0]).toMatch(/source expansion failed/)
	})

	it('AI expansion of a node on a sub-page names the page <parent> / <label> and avoids collisions', async () => {
		const base = await start(() => fakeStream(['A > B\n']))
		const code = 'Root [drill: Sub]\n\npage Sub\nWorker [label: "Job runner"]\n\npage "Sub / Job runner"\nold\n'
		const body = (await (await post(base, '/api/expand', { code, page: 'Sub', node: 'Worker', mode: 'ai', stream: false })).json()) as { code: string; page: string }
		expect(body.page).toBe('Sub / Job runner 2')
		expect(parsePage(body.code, 'Sub')!.ir.nodes[0].ext?.drill).toBe('Sub / Job runner 2')
	})

	it('cleanBody drops page / title lines and fences', () => {
		expect(cleanBody('```\ntitle X\npage Foo\nA > B\n```')).toBe('A > B')
	})
})

describe('POST /api/scan { depth }', () => {
	it('pre-generates deeper pages', async () => {
		const base = await start()
		const res = await post(base, '/api/scan', { path: DEEP, depth: 2 })
		const body = (await res.json()) as { code: string }
		expect(body.code).toContain('page api modules / routes/users')
		expect(body.code).toMatch(/^source /m)
	})
})
