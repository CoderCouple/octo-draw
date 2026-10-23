import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Core parsers are built in parallel; the HTTP layer only needs these to behave plausibly.
vi.mock('@octo-draw/core', () => ({
	NODE_SHAPES: ['rectangle', 'oval', 'diamond', 'cylinder'],
	parseOcto: (src: string) => ({
		ir: {},
		diagnostics: src.includes('!!') ? [{ from: src.indexOf('!!'), to: src.indexOf('!!') + 2, severity: 'error', message: 'bad token' }] : [],
	}),
	parseOctoPages: (src: string) => ({
		pages: [],
		diagnostics: src.includes('!!') ? [{ from: src.indexOf('!!'), to: src.indexOf('!!') + 2, severity: 'error', message: 'bad token' }] : [],
	}),
	applyActions: (src: string, actions: { type: string; from?: string; to?: string }[]) => {
		let code = src
		const errors: { index: number; message: string }[] = []
		actions.forEach((a, index) => {
			if (a.type === 'addEdge') code = `${code}${code ? '\n' : ''}${a.from} > ${a.to}`
			else errors.push({ index, message: `unsupported ${a.type}` })
		})
		return { code, applied: actions.length - errors.length, errors }
	},
}))

const { createApp } = await import('./app')
const { DocStore } = await import('./docStore')
type StreamFn = import('./claude').StreamFn
type Message = import('./claude').Message

let server: Server | undefined
afterEach(() => {
	server?.closeAllConnections()
	server?.close()
	server = undefined
})

async function start(getStream: () => StreamFn | null = () => null) {
	const store = new DocStore(null)
	server = createServer(createApp({ store, getStream }))
	await new Promise<void>((r) => server!.listen(0, r))
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	return { store, base }
}

function msg(content: unknown[], stop_reason = 'end_turn'): Message {
	return { content, stop_reason } as unknown as Message
}

describe('doc endpoints', () => {
	it('GET/PUT with versions and conflicts', async () => {
		const { base } = await start()
		expect(await (await fetch(`${base}/api/doc`)).json()).toMatchObject({ code: '', version: 0 })
		const put = await fetch(`${base}/api/doc`, { method: 'PUT', body: JSON.stringify({ code: 'A > B', source: 'web' }) })
		expect(await put.json()).toEqual({ code: 'A > B', version: 1 })
		const stale = await fetch(`${base}/api/doc`, { method: 'PUT', body: JSON.stringify({ code: 'X', baseVersion: 0, source: 'mcp' }) })
		expect(stale.status).toBe(409)
	})

	it('applies actions and broadcasts over SSE', async () => {
		const { base } = await start()
		const res = await fetch(`${base}/api/doc/events`)
		const reader = res.body!.getReader()
		const first = new TextDecoder().decode((await reader.read()).value)
		expect(first).toContain('"version":0')
		const r = await fetch(`${base}/api/doc/actions`, {
			method: 'POST',
			body: JSON.stringify({ actions: [{ type: 'addEdge', from: 'A', to: 'B' }] }),
		})
		expect(await r.json()).toMatchObject({ code: 'A > B', version: 1, applied: 1 })
		const ev = new TextDecoder().decode((await reader.read()).value)
		expect(JSON.parse(ev.replace(/^data: /, ''))).toEqual({ code: 'A > B', version: 1, source: 'agent' })
		await reader.cancel()
	})

	it('rejects invalid actions', async () => {
		const { base } = await start()
		const r = await fetch(`${base}/api/doc/actions`, { method: 'POST', body: JSON.stringify({ actions: [{ type: 'nope' }] }) })
		expect(r.status).toBe(400)
	})

	it('sets CORS headers for localhost origins only', async () => {
		const { base } = await start()
		const ok = await fetch(`${base}/api/doc`, { headers: { Origin: 'http://localhost:5173' } })
		expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
		const no = await fetch(`${base}/api/doc`, { headers: { Origin: 'https://evil.example' } })
		expect(no.headers.get('access-control-allow-origin')).toBeNull()
	})
})

describe('AI endpoints', () => {
	it('returns 503 without credentials', async () => {
		const { base } = await start(() => null)
		const r = await fetch(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) })
		expect(r.status).toBe(503)
		expect(((await r.json()) as { error: string }).error).toMatch(/No Anthropic credentials/)
	})

	it('streams generate deltas without fences', async () => {
		const stream: StreamFn = async (_req, onText) => {
			const parts = ['```octo\n', 'A > B\n', 'B > C\n', '```']
			for (const p of parts) onText?.(p)
			return msg([{ type: 'text', text: parts.join('') }])
		}
		const { base } = await start(() => stream)
		const r = await fetch(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ prompt: 'x' }) })
		const events = (await r.text())
			.split('\n\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l.replace(/^data: /, '')))
		expect(events.filter((e) => e.delta).map((e) => e.delta).join('')).toBe('A > B\nB > C\n')
		expect(events.at(-1)).toEqual({ done: true, code: 'A > B\nB > C' })
	})

	it('vision repairs once on parse errors', async () => {
		const calls: unknown[] = []
		const stream: StreamFn = async (req) => {
			calls.push(req.messages.length)
			return msg([{ type: 'text', text: calls.length === 1 ? 'A !! B' : '```\nA > B\n```' }])
		}
		const { base } = await start(() => stream)
		const r = await fetch(`${base}/api/vision`, {
			method: 'POST',
			body: JSON.stringify({ imageBase64: 'data:image/png;base64,AAAA', mediaType: 'image/png', mode: 'single' }),
		})
		expect(await r.json()).toEqual({ code: 'A > B', pipeline: 'single-pass' })
		expect(calls).toEqual([1, 3])
	})

	it('vision falls back to single-pass when the two-pass JSON is unusable', async () => {
		const calls: unknown[] = []
		const stream: StreamFn = async (req) => {
			calls.push(req.outputFormat ? 'json' : 'dsl')
			return msg([{ type: 'text', text: req.outputFormat ? 'not json' : 'A > B' }])
		}
		const { base } = await start(() => stream)
		const r = await fetch(`${base}/api/vision`, { method: 'POST', body: JSON.stringify({ imageBase64: 'AAAA', mediaType: 'image/png' }) })
		const body = (await r.json()) as { warnings: string[] }
		expect(body).toMatchObject({ code: 'A > B', pipeline: 'single-pass' })
		expect(body.warnings[0]).toMatch(/Two-pass import failed/)
		expect(calls).toEqual(['json', 'dsl'])
	})

	it('validates the vision mode', async () => {
		const { base } = await start(() => (async () => msg([])) as StreamFn)
		const r = await fetch(`${base}/api/vision`, { method: 'POST', body: JSON.stringify({ imageBase64: 'AAAA', mode: 'x' }) })
		expect(r.status).toBe(400)
	})

	it('runs the agent tool loop', async () => {
		const seen: string[] = []
		const stream: StreamFn = async (req) => {
			const last = req.messages.at(-1)!
			if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
				seen.push(String((last.content[0] as { content: string }).content))
				return msg([{ type: 'text', text: 'Added an edge.' }])
			}
			return msg(
				[{ type: 'tool_use', id: 't1', name: 'apply_actions', input: { actions: [{ type: 'addEdge', from: 'B', to: 'C' }] } }],
				'tool_use',
			)
		}
		const { base } = await start(() => stream)
		const r = await fetch(`${base}/api/agent`, { method: 'POST', body: JSON.stringify({ prompt: 'connect B to C', code: 'A > B' }) })
		const body = await r.json()
		expect(body).toMatchObject({ code: 'A > B\nB > C', errors: [], actions: [{ type: 'addEdge', from: 'B', to: 'C' }], message: 'Added an edge.' })
		expect(JSON.parse(seen[0])).toMatchObject({ applied: 1, code: 'A > B\nB > C' })
	})

	it('streams the chat agent over SSE and updates the shared doc', async () => {
		const stream: StreamFn = async (req, onText) => {
			const last = req.messages.at(-1)!
			if (Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
				onText?.('Connected B to C.')
				return msg([{ type: 'text', text: 'Connected B to C.' }])
			}
			return msg([{ type: 'tool_use', id: 't1', name: 'apply_actions', input: { actions: [{ type: 'addEdge', from: 'B', to: 'C' }] } }], 'tool_use')
		}
		const { base, store } = await start(() => stream)
		const r = await fetch(`${base}/api/agent/stream`, {
			method: 'POST',
			body: JSON.stringify({ prompt: 'connect B to C', code: 'A > B', source: 'web:tab1', history: [{ role: 'user', content: 'hi' }] }),
		})
		const events = (await r.text())
			.split('\n\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l.replace(/^data: /, '')))
		expect(events.map((e) => e.type)).toEqual(['mode', 'actions', 'text', 'done'])
		expect(events[1]).toMatchObject({ actions: [{ type: 'addEdge', from: 'B', to: 'C' }], code: 'A > B\nB > C' })
		expect(store.get()).toMatchObject({ code: 'A > B\nB > C', source: 'web:tab1' })
	})

	it('validates the agent stream mode', async () => {
		const { base } = await start(() => (async () => msg([])) as StreamFn)
		const r = await fetch(`${base}/api/agent/stream`, { method: 'POST', body: JSON.stringify({ prompt: 'x', mode: 'yolo' }) })
		expect(r.status).toBe(400)
	})

	it('maps refusals to 422', async () => {
		const stream: StreamFn = async () => msg([], 'refusal')
		const { base } = await start(() => stream)
		const r = await fetch(`${base}/api/vision`, { method: 'POST', body: JSON.stringify({ imageBase64: 'AAAA', mediaType: 'image/png' }) })
		expect(r.status).toBe(422)
	})
})
