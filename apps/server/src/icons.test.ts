import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { clearIconPacks, registerIconPack } from '@octo-draw/core'
import { iconPacksFromCache, readIconCacheManifest } from '@octo-draw/core/node/iconCache'
import { createApp } from './app'
import { DocStore } from './docStore'

// Fake pack with placeholder SVGs (not vendor files): packages/core/node/fixtures/icon-cache
const FIXTURE = join(import.meta.dirname, '../../../packages/core/node/fixtures/icon-cache')

let server: Server | undefined
afterEach(() => {
	server?.closeAllConnections()
	server?.close()
	server = undefined
	clearIconPacks()
})

async function start(dir: string | null, code = 'A\n') {
	const store = new DocStore(null)
	store.set(code, 'test')
	const icons = dir ? { dir, manifest: readIconCacheManifest(dir) } : undefined
	server = createServer(createApp({ store, getStream: () => null, icons }))
	await new Promise<void>((r) => server!.listen(0, r))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

it('GET /api/icons/manifest lists names, labels and aliases without file paths', async () => {
	const base = await start(FIXTURE)
	const res = await fetch(`${base}/api/icons/manifest`)
	expect(res.status).toBe(200)
	const m = (await res.json()) as { packs: Record<string, { icons: Record<string, unknown>; aliases: Record<string, string> }> }
	expect(Object.keys(m.packs).sort()).toEqual(['aws', 'azure', 'gcp'])
	expect(m.packs.aws.icons['aws-ec2']).toEqual({ label: 'Amazon EC2', kind: 'service', category: 'Compute' })
	expect(m.packs.aws.aliases['aws-s3']).toBe('aws-simple-storage-service')
	expect(JSON.stringify(m)).not.toContain('.svg')
})

it('GET /api/icons/manifest is empty when nothing was downloaded', async () => {
	const base = await start(null)
	expect(await (await fetch(`${base}/api/icons/manifest`)).json()).toEqual({ schema: 1, packs: {} })
	expect((await fetch(`${base}/api/icons/aws/aws-ec2.svg`)).status).toBe(404)
})

it('GET /api/icons/:vendor/:name.svg serves cached icons (and aliases), 404 otherwise', async () => {
	const base = await start(FIXTURE)
	const res = await fetch(`${base}/api/icons/aws/aws-ec2.svg`)
	expect(res.status).toBe(200)
	expect(res.headers.get('content-type')).toContain('image/svg+xml')
	expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
	expect(await res.text()).toContain('placeholder')
	expect((await fetch(`${base}/api/icons/aws/aws-s3.svg`)).status).toBe(200)
	expect((await fetch(`${base}/api/icons/aws/aws-nope.svg`)).status).toBe(404)
	expect((await fetch(`${base}/api/icons/aws/aws-escape.svg`)).status).toBe(404)
	expect((await fetch(`${base}/api/icons/gcp/aws-ec2.svg`)).status).toBe(404)
	expect((await fetch(`${base}/api/icons/aws/..%2Fmanifest.svg`)).status).toBe(404)
})

it('the headless renderer draws registered official icons', async () => {
	for (const p of iconPacksFromCache(FIXTURE)) registerIconPack(p)
	const base = await start(FIXTURE, 'Web [icon: aws-ec2]\nFn [icon: azure-functions]\nWeb > Fn\n')
	const svg = await (await fetch(`${base}/api/doc/svg`)).text()
	expect(svg).toMatch(/viewBox="0 0 80 80" overflow="visible" data-icon="aws-ec2"/)
	expect(svg).toContain('fill="#ff8800"')
	expect(svg).toContain('fill="#0078d4"')
	expect(svg).not.toContain('<script')
	const gray = await (await fetch(`${base}/api/doc/svg?icons=grayscale`)).text()
	expect(gray).toContain('feColorMatrix')
})
