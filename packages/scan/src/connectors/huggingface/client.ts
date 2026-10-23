/**
 * Hub API client over `ctx.fetch`. The token (`HF_TOKEN`, or the
 * `HUGGING_FACE_HUB_TOKEN` / `HUGGINGFACE_TOKEN` aliases) is read from
 * `ctx.env` server-side, sent only to huggingface.co hosts and never put in a
 * result.
 *
 * Errors on the main metadata call become `ConnectorError`s with a clear
 * message (gated / not found / rate limited); secondary files return a
 * `FileResult` so callers can degrade and warn instead of failing.
 */

import { ConnectorError, type ConnectorContext } from '../types'
import type { HfRepoType } from './parse'

export interface HfOptions {
	/** Hub base (tests / mirrors), default https://huggingface.co */
	endpoint?: string
	/** datasets-server base, default https://datasets-server.huggingface.co */
	datasetsServer?: string
	/** How many `base_model` levels to walk up (default 3). */
	lineageDepth?: number
	/** Max models listed as "trained on this dataset" (default 6, 0 disables). */
	maxTrainedModels?: number
	/** Max items per collection page (default 40). */
	maxCollectionItems?: number
	title?: string
}

export type FileResult = { ok: true; text: string } | { ok: false; status: number; gated: boolean }

export interface HfClient {
	readonly hasToken: boolean
	readonly endpoint: string
	/** Repo metadata. Throws ConnectorError on failure. */
	repo<T>(type: Exclude<HfRepoType, 'collection'>, id: string, rev?: string): Promise<T>
	/** Any Hub API path (`/api/collections/...`). Throws ConnectorError on failure. */
	api<T>(path: string, what: string): Promise<T>
	/** Like `api` but returns null on any failure (rate limits still throw). */
	tryApi<T>(path: string): Promise<T | null>
	/** Raw repo file through `resolve/<rev>/<path>`. */
	file(type: Exclude<HfRepoType, 'collection'>, id: string, path: string, rev?: string): Promise<FileResult>
	/** datasets-server JSON (`/info?dataset=...`); null on failure. */
	datasetsServer<T>(path: string): Promise<T | null>
}

export function hfToken(env: Record<string, string | undefined>): string | undefined {
	return env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || env.HUGGINGFACE_TOKEN || undefined
}

const TYPE_PATH: Record<Exclude<HfRepoType, 'collection'>, string> = { model: 'models', dataset: 'datasets', space: 'spaces' }
const enc = (id: string) => id.split('/').map(encodeURIComponent).join('/')

function retryAfter(res: Response): string {
	const ra = Number(res.headers.get('retry-after'))
	const m = /t=(\d+)/.exec(res.headers.get('ratelimit') ?? '')
	const secs = ra || (m ? Number(m[1]) : 0)
	return secs ? ` Try again in ${secs < 90 ? `${secs}s` : `${Math.ceil(secs / 60)} min`}.` : ''
}

export function createClient(ctx: ConnectorContext, o: HfOptions = {}): HfClient {
	const token = hfToken(ctx.env)
	const endpoint = (o.endpoint ?? 'https://huggingface.co').replace(/\/+$/, '')
	const dsBase = (o.datasetsServer ?? 'https://datasets-server.huggingface.co').replace(/\/+$/, '')
	// the token only ever goes to the real Hub over https, even when `endpoint` is overridden
	const hfHost = (url: string) => {
		try {
			const u = new URL(url)
			const h = u.hostname
			return u.protocol === 'https:' && (h === 'huggingface.co' || h.endsWith('.huggingface.co') || h === 'hf.co')
		} catch {
			return false
		}
	}
	// per-run cache (ExpandContext.cache): one expansion with depth > 1 reads config.json once
	const cache = (ctx as ConnectorContext & { cache?: Map<string, unknown> }).cache
	const get = async (url: string): Promise<Response> => {
		const ck = `hf:fetch:${url}`
		const hit = cache?.get(ck) as { status: number; text: string } | undefined
		if (hit) return new Response(hit.text, { status: hit.status })
		const res = await fetchOnce(url)
		if (!cache || !(res.ok || res.status === 404)) return res
		const text = await res.text()
		cache.set(ck, { status: res.status, text })
		return new Response(text, { status: res.status })
	}
	const fetchOnce = async (url: string): Promise<Response> => {
		const headers: Record<string, string> = { 'User-Agent': 'octo-draw-scan' }
		if (token && hfHost(url)) headers.Authorization = `Bearer ${token}`
		let res: Response
		try {
			res = await ctx.fetch(url, { headers, signal: ctx.signal, redirect: 'follow' })
		} catch (err) {
			if (ctx.signal?.aborted) throw err
			throw new ConnectorError(`Hugging Face is not reachable: ${err instanceof Error ? err.message : String(err)}`, 502)
		}
		if (res.status === 429) throw new ConnectorError(`Hugging Face rate limit reached.${retryAfter(res)}${token ? '' : ' Setting HF_TOKEN raises the limit.'}`, 429)
		return res
	}
	const fail = (res: Response, what: string): never => {
		if (res.status === 401) {
			throw new ConnectorError(
				token
					? `Hugging Face: ${what} is not accessible with this HF_TOKEN (401): the token is invalid, or the repo is private.`
					: `Hugging Face: ${what} was not found, or it is private or gated (401). Check the name; for private or gated repos set HF_TOKEN.`,
				token ? 401 : 404,
			)
		}
		if (res.status === 403) throw new ConnectorError(`Hugging Face: ${what} is gated (403). Accept its terms on huggingface.co with the account behind HF_TOKEN.`, 403)
		if (res.status === 404) throw new ConnectorError(`Hugging Face: ${what} not found (404).`, 404)
		throw new ConnectorError(`Hugging Face API error ${res.status} for ${what}.`, 502)
	}
	const readJson = async <T>(res: Response, what: string): Promise<T> => {
		try {
			return (await res.json()) as T
		} catch {
			throw new ConnectorError(`Hugging Face returned invalid JSON for ${what}.`, 502)
		}
	}
	return {
		hasToken: !!token,
		endpoint,
		async repo<T>(type: Exclude<HfRepoType, 'collection'>, id: string, rev?: string): Promise<T> {
			const what = `${type} ${id}`
			const res = await get(`${endpoint}/api/${TYPE_PATH[type]}/${enc(id)}${rev ? `/revision/${encodeURIComponent(rev)}` : ''}`)
			if (!res.ok) fail(res, what)
			return readJson<T>(res, what)
		},
		async api<T>(path: string, what: string): Promise<T> {
			const res = await get(`${endpoint}${path}`)
			if (!res.ok) fail(res, what)
			return readJson<T>(res, what)
		},
		async tryApi<T>(path: string): Promise<T | null> {
			const res = await get(`${endpoint}${path}`)
			if (!res.ok) return null
			return (await res.json().catch(() => null)) as T | null
		},
		async file(type: Exclude<HfRepoType, 'collection'>, id: string, path: string, rev = 'main'): Promise<FileResult> {
			const prefix = type === 'model' ? '' : `${TYPE_PATH[type]}/`
			const res = await get(`${endpoint}/${prefix}${enc(id)}/resolve/${encodeURIComponent(rev)}/${enc(path)}`)
			if (!res.ok) return { ok: false, status: res.status, gated: res.status === 401 || res.status === 403 }
			return { ok: true, text: await res.text() }
		},
		async datasetsServer<T>(path: string): Promise<T | null> {
			try {
				const res = await get(`${dsBase}${path}`)
				if (!res.ok) return null
				return (await res.json()) as T
			} catch (err) {
				if (err instanceof ConnectorError && err.status === 429) throw err
				return null
			}
		},
	}
}

/** JSON file → object, or null (not found / gated / invalid). */
export async function jsonFile<T>(hf: HfClient, type: Exclude<HfRepoType, 'collection'>, id: string, path: string, rev?: string): Promise<{ data: T | null; gated: boolean }> {
	const r = await hf.file(type, id, path, rev)
	if (!r.ok) return { data: null, gated: r.gated }
	try {
		return { data: JSON.parse(r.text) as T, gated: false }
	} catch {
		return { data: null, gated: false }
	}
}
