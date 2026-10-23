import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import type { Message, StreamFn, StreamRequest } from './claude'
import { DocStore } from './docStore'
import { applyExplain, checkLocalPath, keyFiles, relabel } from './scan'

const FIXTURES = resolve(import.meta.dirname, '../../../packages/scan/fixtures')
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

describe('POST /api/scan', () => {
	it('scans a local folder under OCTO_SCAN_ROOTS', async () => {
		const base = await start()
		const res = await post(base, '/api/scan', { path: join(FIXTURES, 'monorepo') })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { code: string; findings: { analyzer: string }[]; warnings: string[]; files?: unknown }
		expect(body.code).toMatch(/^title acme architecture/)
		expect(body.code).toContain('page api modules')
		expect(body.findings.map((f) => f.analyzer)).toEqual(['code', 'compose', 'openapi'])
		expect(body.files).toBeUndefined()
		// `source` works for folders too
		const viaSource = await post(base, '/api/scan', { source: join(FIXTURES, 'compose'), only: ['compose'] })
		expect(((await viaSource.json()) as { code: string }).code).toContain('edge network')
	})

	it('refuses paths outside the allowed roots, including via ..', async () => {
		const base = await start()
		for (const path of ['/etc', join(FIXTURES, '..', 'src'), join(FIXTURES, 'monorepo', '..', '..')]) {
			const res = await post(base, '/api/scan', { path })
			expect(res.status, path).toBe(403)
			expect(((await res.json()) as { error: string }).error).toMatch(/OCTO_SCAN_ROOTS/)
		}
		expect((await post(base, '/api/scan', { path: join(FIXTURES, 'missing') })).status).toBe(404)
		expect((await post(base, '/api/scan', {})).status).toBe(400)
		expect((await post(base, '/api/scan', { source: '???' })).status).toBe(400)
	})

	it('imports cloud exports sent inline but never reads export files named by the client', async () => {
		const base = await start()
		const exportJson = await import('node:fs/promises').then((fs) => fs.readFile(join(FIXTURES, 'cloud/azure/resource-graph.json'), 'utf8'))
		const ok = await post(base, '/api/scan', { source: 'azure:', options: { export: exportJson, file: '/etc/passwd', allowFiles: true } })
		expect(ok.status).toBe(200)
		const body = (await ok.json()) as { code: string; source: { kind: string } }
		expect(body.source.kind).toBe('azure')
		expect(body.code).toContain('page ')
		const refused = await post(base, '/api/scan', { source: `aws:${join(FIXTURES, 'cloud/aws/describe-bundle.json')}` })
		expect(refused.status).toBe(403)
	})

	it('refuses other sites', async () => {
		const base = await start()
		expect((await post(base, '/api/scan', { path: FIXTURES }, { Origin: 'https://evil.example' })).status).toBe(403)
	})

	it('scans GitHub sources with the server-side token and never returns it', async () => {
		const seen: string[] = []
		const fake = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			seen.push((init?.headers as Record<string, string>).Authorization ?? '')
			if (url.endsWith('/repos/acme/svc')) return Response.json({ description: 'Svc', default_branch: 'main', html_url: 'https://github.com/acme/svc' })
			if (url.endsWith('/languages')) return Response.json({})
			if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'docker-compose.yml', type: 'blob', size: 50 }] })
			if (url.endsWith('/docker-compose.yml')) return new Response('services:\n  api: { image: node:22, ports: ["80:80"] }\n')
			return new Response('', { status: 404 })
		}) as typeof fetch
		const base = await start(() => null, fake)
		const res = await post(base, '/api/scan', { source: 'github.com/acme/svc' })
		const text = await res.text()
		expect(res.status).toBe(200)
		expect(text).toContain('Internet')
		expect(text).not.toContain('ghp_server_only')
		expect(seen.every((a) => a === 'Bearer ghp_server_only')).toBe(true)
		expect(JSON.parse(text).source).toEqual({ kind: 'github', id: 'acme/svc', ref: 'main' })
	})
})

describe('POST /api/scan/explain (fake model)', () => {
	it('sends the scan and key files, applies labels per page and adds a summary', async () => {
		const requests: StreamRequest[] = []
		const stream: StreamFn = async (req) => {
			requests.push(req)
			return msg(JSON.stringify({ summary: 'An Express API with a React front end.', labels: [{ page: '', key: 'api', label: 'Orders API' }, { page: 'api modules', key: 'db', label: 'Postgres access' }, { page: 'nope', key: 'x', label: 'y' }], notes: ['Kafka usage is a guess'] }))
		}
		const base = await start(() => stream)
		const res = await post(base, '/api/scan/explain', { path: join(FIXTURES, 'monorepo') })
		expect(res.status).toBe(200)
		const body = (await res.json()) as { code: string; scanCode: string; summary: string; notes: string[] }
		expect(body.summary).toMatch(/Express API/)
		expect(body.code).toContain('// summary: An Express API with a React front end.')
		expect(body.code).toContain('// note: Kafka usage is a guess')
		expect(body.code).toMatch(/^api \[.*label: "Orders API"/m)
		expect(body.code).toMatch(/^db \[.*label: "Postgres access"/m)
		expect(body.scanCode).not.toContain('Orders API')
		const prompt = String(requests[0].messages[0].content)
		expect(prompt).toContain('--- apps/api/package.json')
		expect(prompt).toContain('page api modules')
		expect(requests[0].outputFormat?.type).toBe('json_schema')
	})

	it('needs credentials', async () => {
		const base = await start(() => null)
		expect((await post(base, '/api/scan/explain', { path: join(FIXTURES, 'compose') })).status).toBe(503)
	})
})

describe('scan helpers', () => {
	it('relabels only inside the named page', () => {
		const code = 'title T\nA > B\n\npage P\nA > C\n'
		const p = relabel(code, 'P', 'A', 'Alpha')
		expect(p.startsWith('title T\nA > B\n\npage P\n')).toBe(true)
		expect(p.split('page P')[1]).toContain('A [label: Alpha]')
		const r = relabel(code, '', 'B', 'Beta')
		expect(r.split('page P')[0]).toContain('B [label: Beta]')
		expect(r.split('page P')[1]).toBe('\nA > C\n')
		expect(applyExplain(code, { summary: 'S', labels: [], notes: [] })).toBe('title T\n// summary: S\nA > B\n\npage P\nA > C\n')
	})

	it('picks key files, truncated', () => {
		const files = new Map([['README.md', 'x'.repeat(5000)], ['src/index.ts', 'main'], ['src/util.ts', 'no']])
		const k = keyFiles(files)
		expect(k.map((f) => f.path)).toEqual(['README.md', 'src/index.ts'])
		expect(k[0].text).toMatch(/truncated\)$/)
	})

	it('checks real paths against the roots', async () => {
		await expect(checkLocalPath(join(FIXTURES, 'k8s'), env)).resolves.toBe(join(FIXTURES, 'k8s'))
		await expect(checkLocalPath('/', env)).rejects.toThrow(/not allowed/)
	})
})
