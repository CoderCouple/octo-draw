/** HTTP routes (plain node:http). `createApp` is dependency-injected for tests. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { applyActions, renderDocumentSvg } from '@octo-draw/core'
import { generate, IMAGE_MEDIA_TYPES, runAgent, vision, type ImageMediaType } from './ai'
import { errorMessage, NO_CREDENTIALS, type StreamFn } from './claude'
import type { DocStore } from './docStore'
import { parseActions } from './schema'
import { runAgentStream, type AgentMode } from './agentStream'

export interface AppDeps {
	store: DocStore
	/** Returns null when no Anthropic credentials are configured. */
	getStream: () => StreamFn | null
}

const MAX_BODY = 20 * 1024 * 1024
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message)
	}
}

function cors(req: IncomingMessage, res: ServerResponse) {
	const origin = req.headers.origin
	if (origin && LOCAL_ORIGIN.test(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin)
		res.setHeader('Vary', 'Origin')
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
	}
}

function json(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of req) {
		size += (chunk as Buffer).length
		if (size > MAX_BODY) throw new HttpError(413, 'Request body too large')
		chunks.push(chunk as Buffer)
	}
	const raw = Buffer.concat(chunks).toString('utf8')
	if (!raw) return {}
	try {
		const v = JSON.parse(raw)
		if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
	} catch {
		// fallthrough
	}
	throw new HttpError(400, 'Body must be a JSON object')
}

function sseStart(res: ServerResponse) {
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	})
	res.flushHeaders()
}

const sse = (res: ServerResponse, data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)

function requireString(body: Record<string, unknown>, key: string, optional = false): string | undefined {
	const v = body[key]
	if (v === undefined || v === null) {
		if (optional) return undefined
		throw new HttpError(400, `Missing "${key}"`)
	}
	if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string`)
	return v
}

export function createApp({ store, getStream }: AppDeps) {
	function needStream(res: ServerResponse): StreamFn | null {
		const s = getStream()
		if (!s) json(res, 503, { error: NO_CREDENTIALS })
		return s
	}

	async function route(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? '/', 'http://localhost')
		const path = url.pathname.replace(/\/+$/, '') || '/'
		const method = req.method ?? 'GET'

		if (method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, ai: getStream() !== null })

		// ---- document store
		if (path === '/api/doc') {
			if (method === 'GET') {
				const { code, version, source, updatedAt } = store.get()
				return json(res, 200, { code, version, source, updatedAt })
			}
			if (method === 'PUT') {
				const body = await readJson(req)
				const code = requireString(body, 'code') as string
				const source = requireString(body, 'source', true) ?? 'unknown'
				const base = body.baseVersion
				if (base !== undefined && base !== null && typeof base !== 'number') throw new HttpError(400, '"baseVersion" must be a number')
				const r = store.set(code, source, typeof base === 'number' ? base : undefined)
				if (!r.ok) return json(res, 409, { error: 'Version conflict', code: r.doc.code, version: r.doc.version })
				return json(res, 200, { code: r.doc.code, version: r.doc.version })
			}
		}
		if (method === 'GET' && path === '/api/doc/svg') {
			// Headless render of the current diagram (thumbnails, CLI, MCP). ?theme=dark&scale=2&background=0
			const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
			const scale = Math.min(8, Math.max(0.1, Number(url.searchParams.get('scale')) || 1))
			const background = url.searchParams.get('background') !== '0'
			const svg = await renderDocumentSvg({ code: store.get().code, pins: {}, shapes: [], title: '' }, { theme, scale, background })
			res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' })
			return res.end(svg)
		}
		if (method === 'GET' && path === '/api/doc/events') {
			sseStart(res)
			const { code, version, source } = store.get()
			sse(res, { code, version, source })
			const unsubscribe = store.subscribe((e) => sse(res, e))
			const ping = setInterval(() => res.write(': ping\n\n'), 25000)
			req.on('close', () => {
				clearInterval(ping)
				unsubscribe()
			})
			return
		}
		if (method === 'POST' && path === '/api/doc/actions') {
			const body = await readJson(req)
			const parsed = parseActions(body.actions)
			if (!parsed.ok) throw new HttpError(400, `Invalid actions: ${parsed.error}`)
			const source = requireString(body, 'source', true) ?? 'agent'
			const current = store.get()
			const result = applyActions(current.code, parsed.actions)
			const r = store.set(result.code, source, current.version)
			if (!r.ok) return json(res, 409, { error: 'Version conflict, retry', code: r.doc.code, version: r.doc.version })
			return json(res, 200, { code: r.doc.code, version: r.doc.version, applied: result.applied, errors: result.errors })
		}

		// ---- AI endpoints
		if (method === 'POST' && path === '/api/generate') {
			const body = await readJson(req)
			const prompt = requireString(body, 'prompt') as string
			const code = requireString(body, 'code', true)
			const stream = needStream(res)
			if (!stream) return
			sseStart(res)
			try {
				const full = await generate(stream, { prompt, code }, (delta) => sse(res, { delta }))
				sse(res, { done: true, code: full })
			} catch (err) {
				sse(res, { error: errorMessage(err).message })
			}
			return res.end()
		}
		if (method === 'POST' && path === '/api/vision') {
			const body = await readJson(req)
			const imageBase64 = requireString(body, 'imageBase64') as string
			const mediaType = (requireString(body, 'mediaType', true) ?? 'image/png') as ImageMediaType
			if (!IMAGE_MEDIA_TYPES.includes(mediaType)) throw new HttpError(400, `mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}`)
			const stream = needStream(res)
			if (!stream) return
			const r = await vision(stream, { imageBase64, mediaType })
			return json(res, 200, { code: r.code, diagnostics: r.diagnostics || undefined })
		}
		if (method === 'POST' && path === '/api/agent/stream') {
			const body = await readJson(req)
			const prompt = requireString(body, 'prompt') as string
			const code = requireString(body, 'code', true) ?? ''
			const source = requireString(body, 'source', true) ?? 'agent'
			const mode = body.mode
			if (mode !== undefined && mode !== 'auto' && mode !== 'edit' && mode !== 'explain') throw new HttpError(400, '"mode" must be auto, edit or explain')
			const selection = Array.isArray(body.selection) ? body.selection.filter((k): k is string => typeof k === 'string').slice(0, 50) : []
			const stream = needStream(res)
			if (!stream) return
			sseStart(res)
			const ctrl = new AbortController()
			res.on('close', () => {
				if (!res.writableEnded) ctrl.abort()
			})
			try {
				await runAgentStream(
					stream,
					{ prompt, code, history: body.history as never, selection, mode: mode as AgentMode | undefined, signal: ctrl.signal },
					(e) => {
						if (!ctrl.signal.aborted) sse(res, e)
					},
					// Write each applied step to the shared doc so other viewers / MCP agents see it live.
					(next) => store.set(next, source),
				)
			} catch (err) {
				if (!ctrl.signal.aborted) sse(res, { type: 'error', message: errorMessage(err).message })
			}
			return res.end()
		}
		if (method === 'POST' && path === '/api/agent') {
			const body = await readJson(req)
			const prompt = requireString(body, 'prompt') as string
			const code = requireString(body, 'code', true) ?? ''
			const stream = needStream(res)
			if (!stream) return
			const r = await runAgent(stream, { prompt, code })
			return json(res, 200, r)
		}

		throw new HttpError(404, `No route ${method} ${path}`)
	}

	return async function handler(req: IncomingMessage, res: ServerResponse) {
		cors(req, res)
		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			return res.end()
		}
		try {
			await route(req, res)
		} catch (err) {
			if (res.headersSent) {
				res.end()
				return
			}
			if (err instanceof HttpError) return json(res, err.status, { error: err.message })
			const { status, message } = errorMessage(err)
			if (status >= 500) console.error('[octo-draw]', err)
			json(res, status, { error: message })
		}
	}
}
