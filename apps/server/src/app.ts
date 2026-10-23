/** HTTP routes (plain node:http). `createApp` is dependency-injected for tests. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { applyActions, renderDocumentSvg, type IconCacheManifest } from '@octo-draw/core'
import { iconFilePath } from '@octo-draw/core/node/iconCache'
import { generate, IMAGE_MEDIA_TYPES, runAgent, type ImageMediaType } from './ai'
import { errorMessage, NO_CREDENTIALS, type StreamFn } from './claude'
import type { DocStoreLike } from './sync/docStoreAdapter'
import type { RoomManager } from './sync/rooms'
import { parseActions } from './schema'
import { runAgentStream, type AgentMode } from './agentStream'
import { visionImport } from './vision'

export interface AppDeps {
	/** The default document (`/api/doc` without `docId`). */
	store: DocStoreLike
	/** Multi-document rooms: enables `?docId=` on `/api/doc*` and `/api/docs*`. */
	rooms?: RoomManager
	/** Wraps a room in the DocStore interface (injected to keep this module free of sync imports). */
	storeForRoom?: (docId: string) => DocStoreLike
	/** Returns null when no Anthropic credentials are configured. */
	getStream: () => StreamFn | null
	/** Official cloud icon cache (`pnpm icons:fetch`): serves /api/icons/*. Absent or null manifest → empty manifest, 404 for icons. */
	icons?: { dir: string; manifest: IconCacheManifest | null }
	/** Headless SVG renders draw official icons in grayscale (OCTO_ICONS_GRAYSCALE=1). */
	officialIcons?: 'color' | 'grayscale'
	/** Source scanning (`/api/scan`): fetch / env injection for tests. */
	scan?: import('./scan').ScanDeps
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

function isLoopback(req: IncomingMessage): boolean {
	const a = req.socket.remoteAddress ?? ''
	return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.')
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

/** The public part of the icon manifest: names, labels, aliases (no file paths). */
function publicIconManifest(m: IconCacheManifest | null | undefined) {
	const packs: Record<string, unknown> = {}
	for (const [vendor, p] of Object.entries(m?.packs ?? {})) {
		if (!p) continue
		const icons: Record<string, { label: string; kind?: string; category?: string }> = {}
		for (const [name, i] of Object.entries(p.icons)) icons[name] = { label: i.label, kind: i.kind, category: i.category }
		packs[vendor] = { vendor: p.vendor, version: p.version, label: p.label, terms: p.terms, icons, aliases: p.aliases ?? {} }
	}
	return { schema: 1, packs }
}

export function createApp({ store: defaultStore, rooms, storeForRoom, getStream, icons, officialIcons, scan: scanDeps }: AppDeps) {
	let iconManifestJson: string | null = null
	/** `?docId=` (or body.docId) picks a room; absent means the default document. */
	function pickStore(url: URL, body?: Record<string, unknown>): DocStoreLike {
		const id = url.searchParams.get('docId') ?? (typeof body?.docId === 'string' ? body.docId : null)
		if (!id) return defaultStore
		if (!storeForRoom) throw new HttpError(400, 'This server has a single document; docId is not supported')
		try {
			return storeForRoom(id)
		} catch (err) {
			throw new HttpError(400, (err as Error).message)
		}
	}


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

		// ---- official cloud icons (local cache from `pnpm icons:fetch`; never bundled)
		if (method === 'GET' && path === '/api/icons/manifest') {
			iconManifestJson ??= JSON.stringify(publicIconManifest(icons?.manifest))
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
			return res.end(iconManifestJson)
		}
		const iconMatch = /^\/api\/icons\/(aws|gcp|azure)\/([a-z0-9-]+)\.svg$/.exec(path)
		if (method === 'GET' && iconMatch) {
			const file = icons?.manifest ? iconFilePath(icons.dir, icons.manifest, iconMatch[1], iconMatch[2]) : null
			if (!file) return json(res, 404, { error: 'Icon not found. Run `pnpm icons:fetch --accept-terms` to download the official icon packs.' })
			res.writeHead(200, {
				'Content-Type': 'image/svg+xml; charset=utf-8',
				'Cache-Control': 'public, max-age=86400',
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
			})
			return res.end(readFileSync(file))
		}

		// ---- documents (rooms)
		if (rooms && method === 'GET' && path === '/api/docs') return json(res, 200, { docs: rooms.list() })
		const docMatch = rooms ? /^\/api\/docs\/([^/]+)(\/log)?$/.exec(path) : null
		if (rooms && docMatch && method === 'GET') {
			let room
			try {
				room = rooms.get(decodeURIComponent(docMatch[1]))
			} catch (err) {
				throw new HttpError(400, (err as Error).message)
			}
			if (!docMatch[2]) return json(res, 200, { clock: room.clock, document: room.snapshot() })
			const kind = url.searchParams.get('kind')
			const since = Number(url.searchParams.get('since'))
			const entries = room.attribution({
				kind: kind === 'human' || kind === 'agent' ? kind : undefined,
				name: url.searchParams.get('name') ?? undefined,
				sinceClock: Number.isFinite(since) && since > 0 ? since : undefined,
			})
			return json(res, 200, { clock: room.clock, entries })
		}

		// ---- document store
		if (path === '/api/doc') {
			if (method === 'GET') {
				const store = pickStore(url)
				const { code, version, source, updatedAt } = store.get()
				return json(res, 200, { code, version, source, updatedAt })
			}
			if (method === 'PUT') {
				const body = await readJson(req)
				const store = pickStore(url, body)
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
			// Headless render of the current diagram (thumbnails, CLI, MCP). ?theme=dark&scale=2&background=0&page=Name
			const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light'
			const scale = Math.min(8, Math.max(0.1, Number(url.searchParams.get('scale')) || 1))
			const background = url.searchParams.get('background') !== '0'
			const id = url.searchParams.get('docId')
			const store = pickStore(url)
			const doc = id && rooms ? rooms.get(id).snapshot() : { code: store.get().code, pins: {}, shapes: [], title: '' }
			const svg = await renderDocumentSvg(doc, { theme, scale, background, page: url.searchParams.get('page') ?? '', officialIcons: url.searchParams.get('icons') === 'grayscale' ? 'grayscale' : officialIcons })
			res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache' })
			return res.end(svg)
		}
		if (method === 'GET' && path === '/api/doc/events') {
			const store = pickStore(url)
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
			const store = pickStore(url, body)
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
			const mode = body.mode ?? 'auto'
			if (mode !== 'auto' && mode !== 'single') throw new HttpError(400, '"mode" must be auto or single')
			const stream = needStream(res)
			if (!stream) return
			return json(res, 200, await visionImport(stream, { imageBase64, mediaType }, mode))
		}
		if (method === 'POST' && path === '/api/agent/stream') {
			const body = await readJson(req)
			const prompt = requireString(body, 'prompt') as string
			const code = requireString(body, 'code', true) ?? ''
			const source = requireString(body, 'source', true) ?? 'agent'
			const mode = body.mode
			if (mode !== undefined && mode !== 'auto' && mode !== 'edit' && mode !== 'explain') throw new HttpError(400, '"mode" must be auto, edit or explain')
			const store = pickStore(url, body)
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
					store.writer ? store.writer(source, code) : (next) => store.set(next, source),
				)
			} catch (err) {
				if (!ctrl.signal.aborted) sse(res, { type: 'error', message: errorMessage(err).message })
			}
			return res.end()
		}
		// ---- source scanning (local dev: loopback clients only; local paths limited to OCTO_SCAN_ROOTS)
		if (method === 'POST' && (path === '/api/scan' || path === '/api/scan/explain')) {
			if (!isLoopback(req)) throw new HttpError(403, 'Source scanning is only available to local clients')
			const origin = req.headers.origin
			if (origin && !LOCAL_ORIGIN.test(origin)) throw new HttpError(403, 'Source scanning is not available to other sites')
			const body = await readJson(req)
			const scanReq = {
				path: requireString(body, 'path', true),
				source: requireString(body, 'source', true),
				title: requireString(body, 'title', true),
				only: Array.isArray(body.only) ? body.only.filter((x): x is string => typeof x === 'string') : undefined,
				options: body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? (body.options as Record<string, unknown>) : undefined,
			}
			// loaded lazily: keeps the scanner (and its core imports) out of the other routes
			const scan = await import('./scan')
			const stream = path === '/api/scan/explain' ? needStream(res) : null
			if (path === '/api/scan/explain' && !stream) return
			try {
				const result = await scan.runScan(scanReq, scanDeps)
				if (!stream) return json(res, 200, scan.publicScan(result))
				const explained = await scan.explainScan(stream, result)
				return json(res, 200, { ...scan.publicScan(result), code: explained.code, scanCode: result.code, summary: explained.summary, labels: explained.labels, notes: explained.notes })
			} catch (err) {
				if (err instanceof scan.ScanError) throw new HttpError(err.status, err.message)
				throw err
			}
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
