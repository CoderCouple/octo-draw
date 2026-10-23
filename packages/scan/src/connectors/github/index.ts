/**
 * GitHub connector: `github.com/owner/repo[/tree/ref/subdir]`, `owner/repo@ref`,
 * `github:owner/repo[@ref][/subdir]`.
 *
 * Reads the repo metadata and the recursive git tree through the REST API,
 * fetches only the files the analyzers use (manifests and infra first, then
 * config, then source, within a file / byte budget) from raw contents with a
 * concurrency limit, and runs the same `scanSource`. Workspace nodes get a
 * `link:` to their GitHub path and Actions workflows a "CI/CD" page.
 *
 * Token: `GITHUB_TOKEN` or `GH_TOKEN` from `ctx.env` (public repos work
 * without one). The token is only sent to api.github.com / raw.githubusercontent.com
 * and never appears in results.
 */

import { filePriority, isScannablePath } from '../../filter'
import { emitGraph, scanSource } from '../../scan'
import type { ScanFiles, ScanOptions } from '../../types'
import { ConnectorError, type Connector, type ConnectorContext, type ConnectorResult, type SourceRef } from '../types'

export interface GithubOptions extends ScanOptions {
	subdir?: string
	/** Max files fetched (default 1200). */
	maxFiles?: number
	/** Max bytes fetched in total (default 16 MB). */
	maxBytes?: number
	/** Max size of one file (default 256 KB). */
	maxFileBytes?: number
	/** Parallel raw fetches (default 12). */
	concurrency?: number
	/** API base (tests / GitHub Enterprise), default https://api.github.com */
	apiBase?: string
	/** Raw content base, default https://raw.githubusercontent.com */
	rawBase?: string
}

const NAME = /^[A-Za-z0-9_.-]+$/

/** Parses GitHub inputs; null when the text is not a GitHub source. */
export function parseGithub(input: string): SourceRef | null {
	let s = input.trim()
	let explicit = false
	if (/^github:/i.test(s)) {
		s = s.slice(7)
		explicit = true
	}
	const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/([^?#\s]+))?\/?(?:[?#].*)?$/i.exec(s)
	if (url) {
		const [, owner, repoRaw, rest] = url
		const repo = repoRaw.replace(/\.git$/, '')
		if (!NAME.test(owner) || !NAME.test(repo)) return null
		// `tree/<ref>/<subdir>`: the ref may contain slashes; the scanner retries longer refs if the first guess fails
		if (rest) {
			const parts = rest.split('/').filter(Boolean).map(decodeURIComponent)
			return { kind: 'github', id: `${owner}/${repo}`, ref: parts[0], options: { subdir: parts.slice(1).join('/') || undefined, refParts: parts } }
		}
		return { kind: 'github', id: `${owner}/${repo}` }
	}
	if (/^git@github\.com:/.test(s)) {
		const m = /^git@github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/.exec(s)
		return m && NAME.test(m[1]) && NAME.test(m[2]) ? { kind: 'github', id: `${m[1]}/${m[2]}` } : null
	}
	// owner/repo[@ref][/subdir] shorthand (local paths are tried first by callers that have a file system)
	const short = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]+?)(?:@([^\s/][^\s]*?))?(?:\/([^\s@]+))?$/.exec(s)
	if (short && (explicit || short[3] !== undefined || !short[4])) {
		const [, owner, repo, ref, subdir] = short
		if (repo === '.' || repo === '..') return null
		return { kind: 'github', id: `${owner}/${repo.replace(/\.git$/, '')}`, ref, options: subdir ? { subdir } : undefined }
	}
	return null
}

interface Api {
	json<T>(path: string): Promise<T>
	raw(path: string, ref: string): Promise<string | null>
}

function rateLimitError(res: Response, hasToken: boolean): ConnectorError {
	const reset = Number(res.headers.get('x-ratelimit-reset'))
	const when = reset ? ` (resets at ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC)` : ''
	return new ConnectorError(`GitHub API rate limit exceeded${when}. ${hasToken ? 'Wait or use another token.' : 'Set GITHUB_TOKEN (or GH_TOKEN), or run `gh auth login`, for a higher limit.'}`, 429)
}

function client(owner: string, repo: string, ctx: ConnectorContext, o: GithubOptions): Api {
	const token = ctx.env.GITHUB_TOKEN || ctx.env.GH_TOKEN
	const api = (o.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
	const rawBase = (o.rawBase ?? 'https://raw.githubusercontent.com').replace(/\/+$/, '')
	const headers: Record<string, string> = { 'User-Agent': 'octo-draw-scan', 'X-GitHub-Api-Version': '2022-11-28' }
	if (token) headers.Authorization = `Bearer ${token}`
	const get = async (url: string, accept: string) => {
		let res: Response
		try {
			res = await ctx.fetch(url, { headers: { ...headers, Accept: accept }, signal: ctx.signal })
		} catch (err) {
			if (ctx.signal?.aborted) throw err
			throw new ConnectorError(`GitHub is not reachable: ${err instanceof Error ? err.message : String(err)}`, 502)
		}
		if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.status === 429)) throw rateLimitError(res, !!token)
		return res
	}
	return {
		async json<T>(path: string): Promise<T> {
			const res = await get(`${api}${path}`, 'application/vnd.github+json')
			if (res.status === 404) throw new ConnectorError(`GitHub: ${owner}/${repo} not found${token ? '' : ' (private repos need GITHUB_TOKEN)'}`, 404)
			if (res.status === 401) throw new ConnectorError('GitHub rejected the token (401). Check GITHUB_TOKEN / GH_TOKEN.', 401)
			if (!res.ok) throw new ConnectorError(`GitHub API error ${res.status} for ${path}`, 502)
			return (await res.json()) as T
		},
		async raw(path: string, ref: string): Promise<string | null> {
			const enc = path.split('/').map(encodeURIComponent).join('/')
			const res = await get(`${rawBase}/${owner}/${repo}/${ref.split('/').map(encodeURIComponent).join('/')}/${enc}`, 'application/vnd.github.raw')
			if (!res.ok) return null
			return res.text()
		},
	}
}

interface TreeEntry {
	path: string
	type: 'blob' | 'tree' | 'commit'
	size?: number
}

/** Runs `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, signal?: AbortSignal) {
	let i = 0
	const worker = async () => {
		while (i < items.length) {
			if (signal?.aborted) return
			await fn(items[i++])
		}
	}
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

/** A repo description as a title: the part before `:` / ` - ` when it is long. */
export function shortTitle(desc: string | null | undefined): string {
	const d = (desc ?? '').trim()
	if (d.length <= 60) return d
	const cut = d.split(/:\s| [-–—] /)[0].trim()
	return cut.length <= 60 ? cut : d.slice(0, 57).trimEnd() + '…'
}

export async function scanGithub(ref: SourceRef, ctx: ConnectorContext): Promise<ConnectorResult> {
	const o = (ref.options ?? {}) as GithubOptions & { refParts?: string[] }
	const [owner, repo] = ref.id.split('/')
	if (!owner || !repo) throw new ConnectorError(`bad GitHub repo id "${ref.id}" (expected owner/repo)`)
	const gh = client(owner, repo, ctx, o)
	const warnings: string[] = []
	const meta = await gh.json<{ description?: string | null; default_branch: string; html_url: string; private?: boolean; full_name?: string; archived?: boolean }>(`/repos/${owner}/${repo}`)
	const languages = await gh.json<Record<string, number>>(`/repos/${owner}/${repo}/languages`).catch(() => ({}) as Record<string, number>)

	// resolve ref + subdir (`tree/feature/x/apps/web`: try `feature`, then `feature/x`, ...)
	let gitRef = ref.ref ?? meta.default_branch
	let subdir = (o.subdir ?? '').replace(/^\/+|\/+$/g, '')
	let tree: { tree: TreeEntry[]; truncated?: boolean } | null = null
	const candidates = o.refParts && o.refParts.length > 1 ? o.refParts.map((_, i) => ({ ref: o.refParts!.slice(0, i + 1).join('/'), subdir: o.refParts!.slice(i + 1).join('/') })) : [{ ref: gitRef, subdir }]
	for (const c of candidates) {
		try {
			tree = await gh.json(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(c.ref)}?recursive=1`)
			gitRef = c.ref
			subdir = c.subdir
			break
		} catch (err) {
			if (!(err instanceof ConnectorError) || err.status !== 404) throw err
		}
	}
	if (!tree) throw new ConnectorError(`GitHub: ref "${gitRef}" not found in ${owner}/${repo}`, 404)
	if (tree.truncated) warnings.push('GitHub truncated the file tree (very large repo): the scan is partial')

	const prefix = subdir ? subdir + '/' : ''
	const maxFiles = o.maxFiles ?? 1200
	const maxBytes = o.maxBytes ?? 16 * 1024 * 1024
	const maxFileBytes = o.maxFileBytes ?? 256 * 1024
	const blobs = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix)).map((e) => ({ path: e.path.slice(prefix.length), size: e.size ?? 0 }))
	if (subdir && !blobs.length) throw new ConnectorError(`GitHub: "${subdir}" has no files in ${owner}/${repo}@${gitRef}`, 404)
	const wanted = blobs.filter((b) => isScannablePath(b.path) && b.size <= maxFileBytes).sort((a, b) => filePriority(a.path) - filePriority(b.path) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path))
	const picked: typeof wanted = []
	let bytes = 0
	for (const b of wanted) {
		if (picked.length >= maxFiles || bytes + b.size > maxBytes) break
		picked.push(b)
		bytes += b.size
	}
	if (picked.length < wanted.length) warnings.push(`fetched ${picked.length} of ${wanted.length} relevant files (budget ${maxFiles} files / ${Math.round(maxBytes / 1024 / 1024)} MB)`)
	ctx.log?.(`github: ${owner}/${repo}@${gitRef}${subdir ? `/${subdir}` : ''}: fetching ${picked.length} files`)

	const files: ScanFiles = new Map()
	let failed = 0
	await pool(picked, o.concurrency ?? 12, async (b) => {
		const text = await gh.raw(prefix + b.path, gitRef)
		if (text === null || text.includes('\u0000')) failed++
		else files.set(b.path, text)
	}, ctx.signal)
	if (failed) warnings.push(`${failed} file(s) could not be fetched`)
	// keep a deterministic order for the analyzers
	const sorted: ScanFiles = new Map([...files].sort((a, b) => a[0].localeCompare(b[0])))

	const fullName = `${owner}/${repo}`
	const title = o.title ?? (subdir ? `${fullName}/${subdir}` : shortTitle(meta.description) || fullName)
	const result = scanSource(sorted, { ci: true, ...o, title, rootName: subdir ? subdir.split('/').pop() : repo })
	const base = `${meta.html_url ?? `https://github.com/${fullName}`}/tree/${gitRef}`
	for (const n of result.graph.root.nodes) if (n.dir !== undefined && !n.link) n.link = `${base}/${prefix}${n.dir}`.replace(/\/+$/, '')
	const langs = Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 5)
	const total = langs.reduce((s, [, v]) => s + v, 0) || 1
	const header = [
		`source: https://github.com/${fullName}/tree/${gitRef}${subdir ? `/${subdir}` : ''}`,
		...(langs.length ? [`repo languages: ${langs.map(([l, v]) => `${l} ${Math.round((v / total) * 100)}%`).join(', ')}`] : []),
		...(result.findings.length ? [`scanned by octo-draw: ${result.findings.map((f) => `${f.analyzer} ${Math.round(f.confidence * 100)}%`).join(', ')}`] : []),
	]
	const findings = [
		{ analyzer: 'github', confidence: 1, notes: [`${fullName}@${gitRef}${subdir ? `/${subdir}` : ''}: ${files.size} files fetched of ${blobs.length}`, ...(langs.length ? [`languages: ${langs.map(([l]) => l).join(', ')}`] : []), ...(meta.description?.trim() ? [`description: ${meta.description.trim()}`] : []), ...(meta.archived ? ['archived repository'] : [])] },
		...result.findings,
	]
	return {
		code: emitGraph(result.graph, header),
		findings,
		warnings: [...warnings, ...result.warnings],
		source: { kind: 'github', id: fullName, ref: gitRef, ...(subdir ? { options: { subdir } } : {}) },
		files: sorted,
	}
}

export const githubConnector: Connector = {
	kind: 'github',
	parse: parseGithub,
	scan: scanGithub,
}
