/**
 * Source scanning for the HTTP API and MCP: local folders (only under
 * OCTO_SCAN_ROOTS, default the home directory, after realpath) and any
 * registered connector (GitHub, ...). Credentials (GITHUB_TOKEN / GH_TOKEN /
 * `gh auth token`) are read here, server-side, and never returned.
 *
 * Also the optional AI "explain" pass: the scan result plus key files go to
 * Claude, which returns a summary and label refinements (applied per page).
 */

import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, resolve, sep } from 'node:path'
import { renameNodeLabel } from '@octo-draw/core'
import { ConnectorError, resolveSource, type ConnectorResult, type SourceRef } from '@octo-draw/scan'
import { localConnector } from '@octo-draw/scan/node'
import { assertNotRefused } from './ai'
import { textOf, type StreamFn } from './claude'

export class ScanError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message)
	}
}

/** Allowed local roots: OCTO_SCAN_ROOTS (path-delimiter separated), default the home directory. */
export async function scanRoots(env: Record<string, string | undefined> = process.env): Promise<string[]> {
	const raw = env.OCTO_SCAN_ROOTS ? env.OCTO_SCAN_ROOTS.split(delimiter).filter(Boolean) : [homedir()]
	const out: string[] = []
	for (const r of raw) {
		try {
			out.push(await realpath(resolve(r)))
		} catch {
			// a missing root allows nothing
		}
	}
	return out
}

/** Resolves a local path and checks it against the allowed roots. Returns the real path. */
export async function checkLocalPath(path: string, env: Record<string, string | undefined> = process.env): Promise<string> {
	const expanded = path.startsWith('~/') || path === '~' ? homedir() + path.slice(1) : path
	let real: string
	try {
		real = await realpath(resolve(expanded))
	} catch {
		throw new ScanError(404, `No such directory: ${path}`)
	}
	const roots = await scanRoots(env)
	if (!roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) {
		throw new ScanError(403, `Scanning ${path} is not allowed. Set OCTO_SCAN_ROOTS to include it (currently: ${roots.join(delimiter) || 'none'})`)
	}
	if (!(await stat(real)).isDirectory()) throw new ScanError(400, `Not a directory: ${path}`)
	return real
}

let ghTokenCache: Promise<string | undefined> | null = null
/** `gh auth token` (cached), if the GitHub CLI is installed and logged in. */
export function ghToken(): Promise<string | undefined> {
	ghTokenCache ??= new Promise((res) => {
		try {
			execFile('gh', ['auth', 'token'], { timeout: 4000 }, (err, stdout) => res(err ? undefined : stdout.trim() || undefined))
		} catch {
			res(undefined)
		}
	})
	return ghTokenCache
}

export interface ScanDeps {
	fetch?: typeof fetch
	env?: Record<string, string | undefined>
	/** Use `gh auth token` when no GitHub token is in the environment (default true). */
	useGhCli?: boolean
}

export interface ScanRequest {
	path?: string
	source?: string
	only?: string[]
	title?: string
	/** Levels of drill-down pages to pre-generate (1-5, default 1). */
	depth?: number
	/** Connector options (cloud: regions, profile, scope, subscriptions, export, ...). Filtered by SCAN_OPTION_KEYS. */
	options?: Record<string, unknown>
}

/** Connector options a client may set. Never `file`/`allowFiles`: the server doesn't read files on request. */
export const SCAN_OPTION_KEYS = ['regions', 'profile', 'roleArn', 'externalId', 'scope', 'subscriptions', 'kql', 'export', 'maxNodesPerPage', 'maxPages'] as const

function clientOptions(raw: Record<string, unknown> | undefined): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	if (!raw || typeof raw !== 'object') return out
	for (const k of SCAN_OPTION_KEYS) if (raw[k] !== undefined) out[k] = raw[k]
	return out
}

/** Runs a scan for `{ path }` (local) or `{ source }` (any connector input). */
export async function runScan(req: ScanRequest, deps: ScanDeps = {}): Promise<ConnectorResult> {
	const env = deps.env ?? process.env
	const input = req.path ?? req.source
	if (!input || typeof input !== 'string') throw new ScanError(400, 'Missing "path" or "source"')
	const depth = req.depth === undefined ? undefined : Math.max(1, Math.min(5, Math.floor(Number(req.depth) || 1)))
	const options = { ...clientOptions(req.options), ...(req.only ? { only: req.only } : {}), ...(req.title ? { title: req.title } : {}), ...(depth ? { depth } : {}), allowFiles: false }
	let ref: SourceRef | null = req.path !== undefined ? { kind: 'local', id: req.path } : localConnector.parse(input)
	let connector = ref ? localConnector : null
	if (!ref) {
		const hit = resolveSource(input)
		if (!hit) throw new ScanError(400, `Not a recognised source: "${input}" (a folder path, github.com/owner/repo, owner/repo@ref, ...)`)
		ref = hit.ref
		connector = hit.connector
	}
	if (ref.kind === 'local') ref = { ...ref, id: await checkLocalPath(ref.id, env) }
	const ctxEnv: Record<string, string | undefined> = { ...env }
	if (ref.kind === 'github' && !ctxEnv.GITHUB_TOKEN && !ctxEnv.GH_TOKEN && deps.useGhCli !== false) ctxEnv.GITHUB_TOKEN = await ghToken()
	try {
		// export files named in the source (`aws:/x.json`) are refused too: allowFiles is applied last
		return await connector!.scan({ ...ref, options: { ...ref.options, ...options } }, { fetch: deps.fetch ?? fetch, env: ctxEnv })
	} catch (err) {
		if (err instanceof ConnectorError) throw new ScanError(err.status, err.message)
		throw err
	}
}

/** The JSON a client gets: never files, never credentials. */
export function publicScan(r: ConnectorResult) {
	return { code: r.code, findings: r.findings, warnings: r.warnings, source: { kind: r.source.kind, id: r.source.id, ref: r.source.ref } }
}

// ---------------------------------------------------------------------------
// AI explain

export const EXPLAIN_SYSTEM = `You review architecture diagrams that octo-draw generated by statically scanning a code repository or infrastructure files.
You get the generated octo DSL (pages start with "page <Name>"), the scanner's findings, and excerpts of key files (README, manifests, entrypoints).
Reply with JSON only, matching the schema:
- summary: 2-4 sentences on what the system is and how its parts talk to each other, for someone new to the repo.
- labels: better display labels for nodes whose purpose the files make clear (e.g. "api" -> "REST API (NestJS)"). Use the exact page name ("" for the root page) and node key from the code. Max 20; never invent nodes.
- notes: up to 5 short caveats about things the static scan probably missed or got wrong.`

export const EXPLAIN_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['summary', 'labels', 'notes'],
	properties: {
		summary: { type: 'string' },
		labels: {
			type: 'array',
			items: { type: 'object', additionalProperties: false, required: ['page', 'key', 'label'], properties: { page: { type: 'string' }, key: { type: 'string' }, label: { type: 'string' } } },
		},
		notes: { type: 'array', items: { type: 'string' } },
	},
} as const

const KEY_FILE = /(^|\/)(README(\.md)?|package\.json|pyproject\.toml|go\.mod|Cargo\.toml|(docker-)?compose[\w.-]*\.ya?ml|Dockerfile)$|(^|\/)(src\/)?(index|main|server|app)\.(ts|js|mjs|py|go|rs)$/i

/** README, manifests and entrypoints, shallowest first, each truncated. */
export function keyFiles(files: Map<string, string> | undefined, maxEach = 2500, maxTotal = 40000): { path: string; text: string }[] {
	if (!files) return []
	const picked = [...files.keys()].filter((p) => KEY_FILE.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
	const out: { path: string; text: string }[] = []
	let total = 0
	for (const p of picked) {
		const t = files.get(p)!
		const text = t.length > maxEach ? `${t.slice(0, maxEach)}\n… (truncated)` : t
		if (total + text.length > maxTotal) break
		total += text.length
		out.push({ path: p, text })
	}
	return out
}

export interface ExplainOutput {
	summary: string
	labels: { page: string; key: string; label: string }[]
	notes: string[]
}

/** Applies a label to a node on one page (page bodies are patched in place, other pages untouched). */
export function relabel(code: string, page: string, key: string, label: string): string {
	const headers = [...code.matchAll(/^page[ \t]+(.+?)[ \t]*$/gm)]
	const unq = (s: string) => s.replace(/^"(.*)"$/, '$1')
	let from = 0
	let to = headers.length ? headers[0].index! : code.length
	if (page) {
		const i = headers.findIndex((h) => unq(h[1]) === page)
		if (i < 0) return code
		from = headers[i].index! + headers[i][0].length
		to = i + 1 < headers.length ? headers[i + 1].index! : code.length
	}
	const body = code.slice(from, to)
	const next = renameNodeLabel(body, key, label)
	return code.slice(0, from) + next + code.slice(to)
}

export function applyExplain(code: string, out: ExplainOutput): string {
	let next = code
	for (const l of out.labels.slice(0, 20)) if (l.key && l.label) next = relabel(next, l.page ?? '', l.key, l.label)
	const lines = [`// summary: ${out.summary.replace(/\s+/g, ' ').trim()}`, ...out.notes.slice(0, 5).map((n) => `// note: ${n.replace(/\s+/g, ' ').trim()}`)]
	// summary comments go right after the title line (or at the top)
	const m = /^title .*$/m.exec(next)
	const at = m && m.index < (next.search(/^page[ \t]/m) + 1 || Infinity) ? m.index + m[0].length + 1 : 0
	return next.slice(0, at) + lines.join('\n') + '\n' + next.slice(at)
}

export async function explainScan(stream: StreamFn, scan: ConnectorResult): Promise<ExplainOutput & { code: string }> {
	const files = keyFiles(scan.files)
	const prompt = [
		`Generated diagram:\n\`\`\`octo\n${scan.code}\`\`\``,
		`Findings:\n${scan.findings.map((f) => `- ${f.analyzer} (${Math.round(f.confidence * 100)}%): ${(f.notes ?? []).join('; ')}`).join('\n')}`,
		files.length ? `Key files:\n${files.map((f) => `--- ${f.path}\n${f.text}`).join('\n\n')}` : 'No file excerpts available.',
	].join('\n\n')
	const message = await stream({ system: EXPLAIN_SYSTEM, messages: [{ role: 'user', content: prompt }], effort: 'medium', outputFormat: { type: 'json_schema', schema: EXPLAIN_SCHEMA as unknown as Record<string, unknown> } })
	assertNotRefused(message)
	const text = textOf(message).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
	let parsed: ExplainOutput
	try {
		const v = JSON.parse(text) as Partial<ExplainOutput>
		parsed = {
			summary: typeof v.summary === 'string' ? v.summary : '',
			labels: Array.isArray(v.labels) ? v.labels.filter((l) => l && typeof l.key === 'string' && typeof l.label === 'string').map((l) => ({ page: typeof l.page === 'string' ? l.page : '', key: l.key, label: l.label })) : [],
			notes: Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === 'string') : [],
		}
	} catch {
		throw new ScanError(502, 'The model did not return valid JSON for the explanation')
	}
	return { ...parsed, code: applyExplain(scan.code, parsed) }
}
