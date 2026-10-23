/**
 * `POST /api/expand`: turn a node without a page into a new drill-down page.
 *
 * - source mode: the node's `src` (relative to the document's `source`
 *   directive) goes to the scan expanders. Local sources must pass the
 *   OCTO_SCAN_ROOTS check (folders, and cloud export files); GitHub uses the
 *   server-side token. Never returns credentials.
 * - ai mode: Claude writes the page body from the whole document, the parent
 *   page and the node's neighbours (streamed); the body must parse
 *   (`parseOctoPages`), with one repair round-trip.
 * - auto: source when the node has a `src` that resolves, else AI.
 *
 * Either way the result is a normal code edit: `addPage(code, title, body)`
 * plus `drill: <title>` on the node via `setNodeProp(..., page)`.
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { addPage, drillTargets, pageNames, parsePage, setNodeProp, sourceDirective, splitPages, type IRNode } from '@octo-draw/core'
import { ConnectorError, expandNode, getExpander, parseSrc, resolveSource, type ConnectorFinding, type SourceRef } from '@octo-draw/scan'
import '@octo-draw/scan/node'
import { assertNotRefused, diagnosticsText } from './ai'
import { echoContent, textOf, type MessageParam, type StreamFn } from './claude'
import { EXPAND_SYSTEM, expandUserMessage, repairPrompt } from './prompts'
import { checkLocalPath, ghToken, ScanError, scanRoots, type ScanDeps } from './scan'
import { FenceFilter, stripFences } from './text'

export type ExpandMode = 'auto' | 'ai' | 'source'

export interface ExpandRequest {
	code: string
	/** Page the node is on (default root `''`). */
	page?: string
	/** Node key. */
	node: string
	mode?: ExpandMode
	/** Source mode: levels to generate (1-5, default 1). */
	depth?: number
	/** Kind-specific expander options (cloud: `export` JSON when the document has no source). */
	options?: Record<string, unknown>
}

export interface ExpandResponse {
	code: string
	/** The new page's name. */
	page: string
	/** Every page added (several for depth > 1). */
	pages: string[]
	mode: 'source' | 'ai'
	warnings: string[]
	findings: ConnectorFinding[]
}

export class ExpandError extends ScanError {}

export interface Target {
	page: string
	node: IRNode
	label: string
	src?: string
	source?: string
	existing: string[]
}

/** Finds the node and checks it has no page yet. */
export function findTarget(req: ExpandRequest): Target {
	if (typeof req.code !== 'string') throw new ExpandError(400, 'Missing "code"')
	if (!req.node || typeof req.node !== 'string') throw new ExpandError(400, 'Missing "node"')
	const page = req.page ?? ''
	const parsed = parsePage(req.code, page)
	if (!parsed) throw new ExpandError(404, `No page named "${page}"`)
	const canonical = page === '' ? '' : (splitPages(req.code).find((p) => p.name === page) ?? splitPages(req.code).find((p) => p.name.toLowerCase() === page.toLowerCase()))!.name
	const node = parsed.ir.nodes.find((n) => n.key === req.node)
	if (!node) throw new ExpandError(404, `No node "${req.node}" on ${page ? `page "${page}"` : 'the root page'}`)
	const names = pageNames(req.code)
	const has = drillTargets(parsed.ir, names, canonical)[node.key]
	if (has !== undefined) throw new ExpandError(409, `"${node.key}" already opens the page "${has}"`)
	return { page: canonical, node, label: node.label ?? node.key, src: node.ext?.src, source: sourceDirective(req.code), existing: names }
}

/** Applies a generated page: the page appended, the node patched with `drill:`. */
export function applyExpansion(code: string, t: Target, title: string, body: string): string {
	const withPage = addPage(code, title, body)
	return setNodeProp(withPage, t.node.key, 'drill', title, t.page)
}

/** Does the node's `src` point at something a source expander can open? */
export function srcResolves(t: Target): boolean {
	if (!t.src) return false
	const src = parseSrc(t.src)
	const kind = src.kind || (t.source ? resolveSource(t.source)?.ref.kind : undefined)
	if (!kind || !getExpander(kind)) return false
	// code refs are relative to the source directive; cloud ids work with an export option too
	if (kind === 'local' || kind === 'github' || src.kind === '') return !!t.source
	return true
}

async function checkLocalFile(path: string, env: Record<string, string | undefined>): Promise<void> {
	const expanded = path.startsWith('~/') ? homedir() + path.slice(1) : path
	let real: string
	try {
		real = await realpath(resolve(expanded))
	} catch {
		throw new ExpandError(404, `No such file: ${path}`)
	}
	const roots = await scanRoots(env)
	if (!roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) throw new ExpandError(403, `Reading ${path} is not allowed. Set OCTO_SCAN_ROOTS to include it`)
	if (!(await stat(real)).isFile()) throw new ExpandError(400, `Not a file: ${path}`)
}

/** Resolves the source directive and enforces the local-path policy. Returns the input to hand the expanders. */
export async function authorizeSource(source: string, env: Record<string, string | undefined>): Promise<{ input: string; ref: SourceRef }> {
	const hit = resolveSource(source)
	if (!hit) throw new ExpandError(400, `The document's source "${source}" is not a recognised source`)
	const ref = hit.ref
	if (ref.kind === 'local') {
		const real = await checkLocalPath(ref.id, env)
		return { input: real, ref: { ...ref, id: real } }
	}
	const file = typeof ref.options?.file === 'string' ? ref.options.file : undefined
	if (file) for (const f of file.split(',').map((s) => s.trim()).filter(Boolean)) await checkLocalFile(f, env)
	return { input: source, ref }
}

export async function expandWithSource(req: ExpandRequest, t: Target, deps: ScanDeps = {}): Promise<ExpandResponse> {
	const env = deps.env ?? process.env
	if (!t.src) throw new ExpandError(400, `"${t.node.key}" has no src to expand from`)
	const src = parseSrc(t.src)
	let sourceInput = t.source ?? ''
	let kind = src.kind
	if (sourceInput) {
		const auth = await authorizeSource(sourceInput, env)
		sourceInput = auth.input
		kind ||= auth.ref.kind
	} else if (kind === 'local' || kind === 'github' || kind === '') throw new ExpandError(400, 'The document has no `source` directive, so code refs cannot be resolved')
	const ctxEnv: Record<string, string | undefined> = { ...env }
	if (kind === 'github' && !ctxEnv.GITHUB_TOKEN && !ctxEnv.GH_TOKEN && deps.useGhCli !== false) ctxEnv.GITHUB_TOKEN = await ghToken()
	const depth = Math.max(1, Math.min(5, Math.floor(Number(req.depth) || 1)))
	const options: Record<string, unknown> = {}
	if (req.options && typeof req.options === 'object' && req.options.export !== undefined) options.export = req.options.export
	try {
		const r = await expandNode({ source: sourceInput, src: t.src, node: { key: t.node.key, label: t.node.label }, parentPage: t.page, depth, existingPages: t.existing, options }, { fetch: deps.fetch ?? fetch, env: ctxEnv })
		return { code: applyExpansion(req.code, t, r.title, r.body), page: r.title, pages: r.pages, mode: 'source', warnings: r.warnings, findings: r.findings }
	} catch (err) {
		if (err instanceof ConnectorError) throw new ExpandError(err.status, err.message)
		throw err
	}
}

/** Edges touching the node on its page, phrased for the prompt. */
function neighbours(code: string, t: Target): string[] {
	const ir = parsePage(code, t.page)?.ir
	if (!ir) return []
	const label = (k: string) => {
		const n = ir.nodes.find((x) => x.key === k)
		return n?.label && n.label !== k ? `${k} (${n.label})` : k
	}
	const out: string[] = []
	for (const e of ir.edges) {
		const l = e.label ? `: ${e.label}` : ''
		if (e.from === t.node.key && e.to !== t.node.key) out.push(`${t.node.key} -> ${label(e.to)}${l}`)
		else if (e.to === t.node.key && e.from !== t.node.key) out.push(`${label(e.from)} -> ${t.node.key}${l}`)
	}
	return out.slice(0, 40)
}

/** A page body: no `page` header lines, no `title` (a model may add them anyway). */
export function cleanBody(text: string): string {
	return stripFences(text)
		.split('\n')
		.filter((l) => !/^page[ \t]+\S/.test(l) && !/^title[ \t]/.test(l))
		.join('\n')
		.trim()
}

function nodeProps(n: IRNode): string {
	const parts: string[] = []
	if (n.shape) parts.push(`shape ${n.shape}`)
	if (n.icon) parts.push(`icon ${n.icon}`)
	if (n.isContainer) parts.push('a group')
	for (const [k, v] of Object.entries(n.ext ?? {})) if (k !== 'src') parts.push(`${k} ${v}`)
	return parts.join(', ')
}

export async function expandWithAi(stream: StreamFn, req: ExpandRequest, t: Target, onDelta: (delta: string) => void, signal?: AbortSignal): Promise<ExpandResponse> {
	const filter = new FenceFilter()
	const messages: MessageParam[] = [{ role: 'user', content: expandUserMessage({ code: req.code, page: t.page, node: { key: t.node.key, label: t.node.label, props: nodeProps(t.node) }, neighbours: neighbours(req.code, t) }) }]
	const first = await stream({ system: EXPAND_SYSTEM, messages, effort: 'medium', signal }, (delta) => {
		const out = filter.push(delta)
		if (out) onDelta(out)
	})
	const rest = filter.flush()
	if (rest) onDelta(rest)
	assertNotRefused(first)
	let body = cleanBody(textOf(first))
	let diagnostics = diagnosticsText(body)
	const warnings: string[] = []
	if (diagnostics || !body) {
		messages.push({ role: 'assistant', content: echoContent(first.content) })
		messages.push({ role: 'user', content: body ? repairPrompt(diagnostics).replace('FULL corrected octo DSL code', 'FULL corrected page body') : 'The page body was empty. Write the page body now (octo DSL only).' })
		const second = await stream({ system: EXPAND_SYSTEM, messages, effort: 'medium', signal })
		if (second.stop_reason !== 'refusal') {
			const repaired = cleanBody(textOf(second))
			if (repaired) {
				body = repaired
				diagnostics = diagnosticsText(body)
			}
		}
	}
	if (!body) throw new ExpandError(502, 'The model returned an empty page')
	if (diagnostics) warnings.push(`the generated page still has parse errors:\n${diagnostics}`)
	const title = uniqueTitle(t)
	return { code: applyExpansion(req.code, t, title, body), page: title, pages: [title], mode: 'ai', warnings, findings: [] }
}

/** `<parent> / <label>` (just the label under the root), unique among the document's pages. */
export function uniqueTitle(t: Target): string {
	const base = (t.page ? `${t.page} / ${t.label}` : t.label).replace(/["[\]{},:#\n\r]/g, ' ').replace(/\/\//g, '/').replace(/\s+/g, ' ').trim() || 'page'
	const taken = new Set(t.existing.map((n) => n.toLowerCase()))
	let name = base
	for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`
	return name
}

export { ghToken, ScanError }
