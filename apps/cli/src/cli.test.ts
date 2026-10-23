import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument, parseOcto } from '@octo-draw/core'
import { parseArgs, run, type IO } from './cli'
import { loadInput } from './convert'

const FIX = join(import.meta.dirname, '..', 'fixtures')
const fixture = (name: string) => readFileSync(join(FIX, name), 'utf8')

/** Official icon cache: tests never read the user's real cache. */
const NO_ICONS = { OCTO_ICONS_DIR: join(FIX, 'no-icon-cache') }
const ICON_FIXTURE = join(import.meta.dirname, '../../../packages/core/node/fixtures/icon-cache')

function memIO(files: Record<string, string> = {}, stdin = '', env: Record<string, string> = NO_ICONS) {
	const out: string[] = []
	const err: string[] = []
	const written: Record<string, string> = {}
	const io: IO = {
		readFile: async (p) => {
			if (p in files) return files[p]
			throw new Error(`ENOENT: ${p}`)
		},
		writeFile: async (p, d) => {
			written[p] = d
		},
		readStdin: async () => stdin,
		stdout: (t) => out.push(t),
		stderr: (t) => err.push(t),
		fetch: (...a) => fetch(...a),
		env,
	}
	return { io, written, out: () => out.join(''), err: () => err.join('') }
}

const FILES = {
	'flow.mmd': fixture('flow.mmd'),
	'system.octo': fixture('system.octo'),
	'chat.txt': fixture('chat.txt'),
	'canvas.tldraw.json': fixture('octonote-canvas.tldraw.json'),
}

describe('parseArgs', () => {
	it('parses positionals, long/short flags and = values', () => {
		expect(parseArgs(['convert', 'a.mmd', '--to', 'octo', '-o', 'x.octo', '--theme=dark', '--quiet'])).toEqual({
			positional: ['convert', 'a.mmd'],
			flags: { to: 'octo', out: 'x.octo', theme: 'dark', quiet: true },
		})
		expect(parseArgs(['render', '-', '-o', '-']).flags.out).toBe('-')
		expect(() => parseArgs(['convert', '--to'])).toThrow(/needs a value/)
	})
})

describe('loadInput autodetection', () => {
	it('detects octo, mermaid, ascii, json documents and tldraw snapshots', () => {
		expect(loadInput(FILES['system.octo']).format).toBe('octo')
		expect(loadInput(FILES['flow.mmd']).format).toBe('mermaid')
		expect(loadInput(FILES['chat.txt']).format).toBe('ascii')
		expect(loadInput(FILES['canvas.tldraw.json']).format).toBe('tldraw')
		expect(loadInput(JSON.stringify({ code: 'A > B' })).format).toBe('json')
		expect(loadInput('A > B', { from: 'octo' }).format).toBe('octo')
	})

	it('keeps octo source verbatim and titles from the DSL or file name', () => {
		const { doc } = loadInput(FILES['system.octo'])
		expect(doc.code).toBe(FILES['system.octo'])
		expect(doc.title).toBe('My system')
		expect(loadInput('A > B', { name: 'dir/my-flow.octo' }).doc.title).toBe('my-flow')
	})

	it('reads the web app JSON export', () => {
		const ir = parseOcto('A > B').ir
		const { doc } = loadInput(JSON.stringify({ title: 'Exported', ir, layout: {}, drawing: [], pins: { A: { x: 1, y: 2 } } }))
		expect(doc).toMatchObject({ title: 'Exported', pins: { A: { x: 1, y: 2 } } })
		expect(parseOcto(doc.code).ir.edges).toHaveLength(1)
	})

	it('rejects text that is not a diagram', () => {
		expect(() => loadInput('just some prose, nothing to draw here.')).toThrow(/could not recognise/)
	})
})

describe('convert', () => {
	it('mermaid → octo', async () => {
		const m = memIO(FILES)
		expect(await run(['convert', 'flow.mmd', '--to', 'octo'], m.io)).toBe(0)
		const ir = parseOcto(m.out()).ir
		expect(ir.nodes.find((n) => n.key === 'app')?.isContainer).toBe(true)
		expect(ir.edges.find((e) => e.label === 'yes')).toBeTruthy()
	})

	it('octo → mermaid', async () => {
		const m = memIO(FILES)
		await run(['convert', 'system.octo', '--to', 'mermaid'], m.io)
		expect(m.out()).toContain('flowchart LR')
		expect(m.out()).toContain('subgraph Backend')
	})

	it('ascii from stdin → json document, written to a file', async () => {
		const m = memIO({}, FILES['chat.txt'])
		expect(await run(['convert', '-', '--to', 'json', '-o', 'out.json'], m.io)).toBe(0)
		const doc = parseDocument(m.written['out.json'])
		expect(parseOcto(doc.code).ir.nodes.map((n) => n.key)).toEqual(['Client', 'Server', 'DB'])
		expect(m.err()).toContain('wrote out.json')
	})

	it('infers the output format from -o', async () => {
		const m = memIO(FILES)
		await run(['convert', 'flow.mmd', '-o', 'flow.svg'], m.io)
		expect(m.written['flow.svg']).toMatch(/^<svg /)
	})

	it('tldraw (Octonote canvas) → octo keeps groups, edges and positions', async () => {
		const m = memIO(FILES)
		await run(['convert', 'canvas.tldraw.json', '--to', 'json'], m.io)
		const doc = parseDocument(m.out())
		const ir = parseOcto(doc.code).ir
		expect(ir.nodes.find((n) => n.key === 'API')?.parent).toBe('App servers')
		expect(ir.edges).toHaveLength(4)
		expect(Object.keys(doc.pins)).toContain('Redis')
	})

	it('octo → tldraw → octo', async () => {
		const a = memIO(FILES)
		await run(['convert', 'system.octo', '--to', 'tldraw'], a.io)
		const snap = JSON.parse(a.out())
		expect(snap.schema.schemaVersion).toBe(2)
		const b = memIO({ 'x.json': a.out() })
		await run(['convert', 'x.json', '--to', 'octo'], b.io)
		const ir = parseOcto(b.out()).ir
		expect(ir.nodes.find((n) => n.key === 'Worker')?.parent).toBe('Backend')
		expect(ir.nodes.find((n) => n.key === 'DB')?.label).toBe('Postgres 16')
	})

	it('reports usage errors with exit code 2', async () => {
		const m = memIO(FILES)
		expect(await run(['convert', 'flow.mmd'], m.io)).toBe(2)
		expect(m.err()).toContain('--to is required')
		expect(await run(['convert', 'flow.mmd', '--to', 'png'], m.io)).toBe(2)
		expect(await run(['frobnicate'], m.io)).toBe(2)
		expect(await run(['convert', 'missing.octo', '--to', 'octo'], m.io)).toBe(1)
		expect(m.err()).toContain('ENOENT')
	})
})

describe('render', () => {
	it('renders an SVG with lucide icons and theme', async () => {
		const m = memIO(FILES)
		expect(await run(['render', 'system.octo', '-o', 'sys.svg', '--theme', 'dark', '--scale', '2'], m.io)).toBe(0)
		const svg = m.written['sys.svg']
		expect(svg).toContain('data-theme="dark"')
		expect(svg).toMatch(/<svg x="[\d.]+" y="[\d.]+" width="20" height="20" viewBox="0 0 24 24"[^>]*data-icon="server">/)
		expect(svg).toContain('data-group="Backend"')
	})

	it('uses official icons from the local cache (fake fixture pack), color or grayscale', async () => {
		const files = { 'cloud.octo': 'Web [icon: aws-ec2]\nRun [icon: gcp-cloud-run]\nFn [icon: aws-lambda]\nWeb > Run > Fn\n' }
		const m = memIO(files, '', { OCTO_ICONS_DIR: ICON_FIXTURE })
		expect(await run(['render', 'cloud.octo', '-o', 'c.svg'], m.io)).toBe(0)
		const svg = m.written['c.svg']
		expect(svg).toMatch(/viewBox="0 0 80 80" overflow="visible" data-icon="aws-ec2"/)
		expect(svg).toContain('od-gcp-gcp-cloud-run-cls-1')
		expect(svg).toMatch(/data-icon="aws-lambda"[\s\S]*?>λ<\/text>/) // not in the fake pack: badge fallback
		expect(await run(['render', 'cloud.octo', '-o', 'g.svg', '--icons', 'grayscale'], m.io)).toBe(0)
		expect(m.written['g.svg']).toContain('feColorMatrix')
		// no cache: generic badge icons
		const bare = memIO(files)
		await run(['render', 'cloud.octo', '-o', 'c.svg'], bare.io)
		expect(bare.written['c.svg']).toMatch(/data-icon="aws-ec2"[\s\S]*?>EC2<\/text>/)
	})

	it('prints to stdout without -o', async () => {
		const m = memIO(FILES)
		await run(['render', 'flow.mmd'], m.io)
		expect(m.out()).toMatch(/^<svg [\s\S]*<\/svg>\n$/)
	})
})

describe('push / pull', () => {
	let server: Server | undefined
	afterEach(() => {
		server?.close()
		server = undefined
	})

	async function fakeServer() {
		const state = { code: 'Old > Code\n', version: 3 }
		server = createServer(async (req, res) => {
			const chunks: Buffer[] = []
			for await (const c of req) chunks.push(c as Buffer)
			if (req.url === '/api/doc' && req.method === 'PUT') {
				const body = JSON.parse(Buffer.concat(chunks).toString())
				state.code = body.code
				state.version++
				expect(body.source).toBe('cli')
			} else if (!(req.url === '/api/doc' && req.method === 'GET')) {
				res.writeHead(404, { 'Content-Type': 'application/json' })
				return res.end(JSON.stringify({ error: 'nope' }))
			}
			res.writeHead(200, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify(state))
		})
		await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
		return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
	}

	it('pushes converted code and pulls it back in any format', async () => {
		const { state, url } = await fakeServer()
		const m = memIO(FILES, '', { OCTO_SERVER_URL: url })
		expect(await run(['push', 'flow.mmd'], m.io)).toBe(0)
		expect(state.version).toBe(4)
		expect(parseOcto(state.code).ir.nodes.length).toBe(6) // 5 nodes + the subgraph
		expect(m.err()).toContain('pushed mermaid as version 4')

		const p = memIO({}, '', {})
		expect(await run(['pull', '--server', url], p.io)).toBe(0)
		expect(p.out()).toBe(state.code)
		const q = memIO()
		await run(['pull', '--server', url, '-o', 'now.mmd'], q.io)
		expect(q.written['now.mmd']).toMatch(/^flowchart LR/)
	})

	it('explains when the server is down', async () => {
		const m = memIO(FILES)
		expect(await run(['pull', '--server', 'http://127.0.0.1:9'], m.io)).toBe(2)
		expect(m.err()).toContain('not reachable')
	})
})

it('prints help, version and schema', async () => {
	const m = memIO()
	expect(await run(['--help'], m.io)).toBe(0)
	expect(m.out()).toContain('octo-draw convert')
	expect(await run([], memIO().io)).toBe(1)
	const s = memIO()
	await run(['schema'], s.io)
	expect(JSON.parse(s.out()).title).toBe('OctoDocument')
})
