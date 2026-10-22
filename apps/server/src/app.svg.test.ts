import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { createApp } from './app'
import { DocStore } from './docStore'

let server: Server | undefined
afterEach(() => {
	server?.closeAllConnections()
	server?.close()
	server = undefined
})

async function start(code: string) {
	const store = new DocStore(null)
	store.set(code, 'test')
	server = createServer(createApp({ store, getStream: () => null }))
	await new Promise<void>((r) => server!.listen(0, r))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

it('GET /api/doc/svg renders the current diagram headlessly', async () => {
	const base = await start('A > B: go\n')
	const res = await fetch(`${base}/api/doc/svg`)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('image/svg+xml')
	const svg = await res.text()
	expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
	expect(svg).toContain('data-node="A"')
	expect(svg).toContain('data-edge="A-&gt;B#0"')
	expect(svg).toContain('data-theme="light"')
})

it('GET /api/doc/svg honors theme, scale and background', async () => {
	const base = await start('A\n')
	const plain = await (await fetch(`${base}/api/doc/svg`)).text()
	const svg = await (await fetch(`${base}/api/doc/svg?theme=dark&scale=2&background=0`)).text()
	expect(svg).toContain('data-theme="dark"')
	expect(svg).not.toContain('data-background')
	const w = (s: string) => Number(s.match(/ width="(\d+)"/)![1])
	expect(w(svg)).toBe(w(plain) * 2)
})
