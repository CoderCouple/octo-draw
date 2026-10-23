/**
 * Expander registry and `expandNode`.
 *
 * `registerExpander(kind, fn)` plugs in a source kind (`local` and `github`
 * share the code expander; `aws` / `gcp` / `azure` the cloud one; the
 * Hugging Face connector registers `huggingface`). `expandNode` resolves the
 * document's `source` directive, dispatches on the `src` scheme and, for
 * `depth > 1`, recurses with the shared breadth-first deepener.
 *
 * Code sources read files through a `FileSource` registered per kind:
 * `@octo-draw/scan/node` registers `local` (fs, confined to the source root),
 * the GitHub connector registers `github` (REST tree + raw contents).
 */

import { ConnectorError, type ConnectorFinding, type SourceRef } from '../connectors/types'
import { resolveSource } from '../connectors'
import { githubFileSource } from '../connectors/github'
import type { ScanFiles } from '../types'
import { expandCode, isSourcePath } from './code'
import { expandConfig, isConfigPath } from './config'
import { childPageName, deepenAsync, uniquePageName, type DeepenResult } from './deepen'
import { kindScheme, parseSrc } from './src'
import type { ExpandContext, Expander, ExpandedPage, ExpandNodeInput, ExpandNodeResult, SrcRef } from './types'
import { addPage } from '@octo-draw/core'
import { huggingfaceExpander } from '../connectors/huggingface/expand'

export * from './types'
export { parseSrc, formatSrc, isChildSrc, schemeKind, kindScheme } from './src'
export { deepenSync, deepenAsync, deepenSteps, applyDeepen, childPageName, uniquePageName, type DeepenOptions, type DeepenRequest, type DeepenResult } from './deepen'
export { expandCode, codeTarget, CODE_ICONS, type CodeExpandOptions } from './code'
export { expandConfig } from './config'
export { expandCloudResource, createCloudExpander, cloudExpander } from './cloud'

// ---------------------------------------------------------------------------
// registry

const expanders = new Map<string, Expander>()

/** Registers (or replaces) the expander for a source kind (`local`, `github`, `aws`, `huggingface`, ...). Returns an unregister function. */
export function registerExpander(kind: string, fn: Expander): () => void {
	expanders.set(kind, fn)
	return () => {
		if (expanders.get(kind) === fn) expanders.delete(kind)
	}
}

export function getExpander(kind: string): Expander | undefined {
	return expanders.get(kind)
}

export function listExpanders(): string[] {
	return [...expanders.keys()]
}

// ---------------------------------------------------------------------------
// file sources (code expansion)

export interface FileSource {
	/** Every file path of the source (repo-relative POSIX), possibly capped. */
	list(): Promise<string[]>
	/** File text, or null when missing / unreadable / not allowed. */
	read(path: string): Promise<string | null>
}

export type FileSourceFactory = (ref: SourceRef, ctx: ExpandContext) => FileSource | Promise<FileSource>

const fileSources = new Map<string, FileSourceFactory>()

/** Registers how code expanders read files for a source kind. */
export function registerFileSource(kind: string, factory: FileSourceFactory): () => void {
	fileSources.set(kind, factory)
	return () => {
		if (fileSources.get(kind) === factory) fileSources.delete(kind)
	}
}

/** Budgets for loading files for one code expansion. */
const LOAD = { maxFiles: 600, maxBytes: 6 * 1024 * 1024, maxFileBytes: 512 * 1024 }

const isManifest = (p: string) => /(^|\/)(package\.json|tsconfig\.json|jsconfig\.json|go\.mod|Cargo\.toml|pyproject\.toml|setup\.py)$/.test(p)

/** Loads what a code expansion of `src` needs into a ScanFiles map (unread paths present with ''). */
export async function loadCodeFiles(fs: FileSource, src: SrcRef, warnings: string[], cache?: Map<string, unknown>): Promise<ScanFiles> {
	const ck = 'code:paths'
	let paths = cache?.get(ck) as string[] | undefined
	if (!paths) {
		paths = await fs.list()
		cache?.set(ck, paths)
	}
	const files: ScanFiles = (cache?.get('code:files') as ScanFiles | undefined) ?? new Map()
	cache?.set('code:files', files)
	for (const p of paths) if (!files.has(p)) files.set(p, '')
	const readSet = new Set<string>()
	const isFile = src.path !== '' && paths.includes(src.path)
	if (isFile) readSet.add(src.path)
	else {
		const prefix = src.path ? src.path + '/' : ''
		for (const p of paths) if ((prefix === '' || p.startsWith(prefix)) && isSourcePath(p)) readSet.add(p)
	}
	for (const p of paths) if (isManifest(p)) readSet.add(p)
	let bytes = 0
	let n = 0
	let capped = false
	for (const p of readSet) {
		if (files.get(p)) continue
		if (n >= LOAD.maxFiles || bytes >= LOAD.maxBytes) {
			capped = true
			break
		}
		const text = await fs.read(p)
		if (text === null || text.length > LOAD.maxFileBytes || text.includes('\u0000')) continue
		files.set(p, text)
		bytes += text.length
		n++
	}
	if (capped) warnings.push(`read ${n} of ${readSet.size} files (budget ${LOAD.maxFiles} files / ${Math.round(LOAD.maxBytes / 1048576)} MB): the page may be partial`)
	return files
}

/** Sync expansion over an in-memory file map: code (dirs, source files, symbols, dependency users) or config files. */
export function expandInFiles(files: ScanFiles, src: SrcRef, opts: { maxNodes?: number; scheme?: string } = {}): ExpandedPage | null {
	if (src.path !== '' && files.has(src.path) && isConfigPath(src.path) && !isSourcePath(src.path)) return expandConfig(files, src.path, src.fragment, opts)
	return expandCode(files, src, opts)
}

/** The code expander (`local`, `github`): loads files through the registered FileSource, then `expandInFiles`. */
export const codeExpander: Expander = async (req, ctx) => {
	if (!req.source) throw new ConnectorError(`"${req.src.raw}" is relative to the document's source, but the document has no \`source\` directive`, 400)
	const factory = fileSources.get(req.source.kind)
	if (!factory) throw new ConnectorError(`no file source registered for "${req.source.kind}"`, 501)
	const key = `fs:${req.sourceInput}`
	let fs = ctx.cache?.get(key) as FileSource | undefined
	if (!fs) {
		fs = await factory(req.source, ctx)
		ctx.cache?.set(key, fs)
	}
	const warnings: string[] = []
	const files = await loadCodeFiles(fs, req.src, warnings, ctx.cache)
	const page = expandInFiles(files, req.src, { maxNodes: req.maxNodes, scheme: req.src.scheme || kindScheme(req.source.kind) })
	if (!page) throw new ConnectorError(`nothing to expand at ${req.src.raw}`, 404)
	return { ...page, warnings: [...warnings, ...(page.warnings ?? [])] }
}

registerExpander('local', codeExpander)
registerExpander('github', codeExpander)
registerExpander('huggingface', huggingfaceExpander)
registerFileSource('github', (ref, ctx) => githubFileSource(ref, ctx))
// cloud: loaded lazily (keeps the cloud connector graph out of module init cycles)
const cloud: Expander = async (req, ctx) => (await import('./cloud')).cloudExpander(req, ctx)
for (const k of ['aws', 'gcp', 'azure']) registerExpander(k, cloud)

// ---------------------------------------------------------------------------
// expandNode

const labelOf = (n: { key: string; label?: string }) => (n.label ?? n.key).replace(/\/+$/, '').trim() || n.key

/** Parses the `source` directive with the connector registry (local paths need `@octo-draw/scan/node`). */
export function resolveSourceDirective(source: string): SourceRef | null {
	const t = source.trim()
	if (!t) return null
	return resolveSource(t)?.ref ?? null
}

/**
 * Expands one node into a page body (plus deeper `page` sections for
 * `depth > 1`). Throws `ConnectorError` (400 no source / bad src, 404 nothing
 * at that src, 501 no expander for the kind).
 */
export async function expandNode(input: ExpandNodeInput, ctx: ExpandContext): Promise<ExpandNodeResult> {
	const src = parseSrc(input.src)
	const sourceRef = resolveSourceDirective(input.source)
	const kind = src.kind || sourceRef?.kind || ''
	if (src.kind === '' && sourceRef) src.kind = sourceRef.kind
	const expander = expanders.get(kind)
	if (!expander) throw new ConnectorError(`no expander for "${kind || input.src}"`, 501)
	const context: ExpandContext = { ...ctx, cache: ctx.cache ?? new Map() }
	const depth = Math.max(1, Math.min(8, Math.floor(input.depth ?? 1)))
	const maxNodes = input.maxNodesPerPage ?? 30
	const taken = new Set((input.existingPages ?? []).filter((p) => p !== '').map((p) => p.toLowerCase()))
	const title = uniquePageName(childPageName(input.parentPage, labelOf(input.node)), new Set(taken))
	const call = (s: SrcRef, node: { key: string; label?: string }) => {
		const ex = expanders.get(s.kind || kind)
		if (!ex) return Promise.resolve(null)
		return ex({ source: sourceRef, sourceInput: input.source, src: s.kind ? s : { ...s, kind }, node, options: input.options ?? {}, maxNodes }, context)
	}
	// a synthetic one-node document so the deepener can drive the recursion
	const seedDoc = buildSeedDoc(input)
	const r: DeepenResult = await deepenAsync(seedDoc.code, (req) => call(req.src, req.node), {
		depth,
		maxPages: (input.maxPages ?? 200) + seedDoc.pages,
		deadline: Date.now() + (input.timeBudgetMs ?? 20000),
		seeds: [{ page: seedDoc.page, key: input.node.key, label: input.node.label, src: input.src }],
		seedName: title,
	})
	if (!r.pages.length) throw new ConnectorError(`nothing to expand at ${input.src}`, 404)
	const [first, ...rest] = r.pages
	let body = first.body.endsWith('\n') ? first.body : first.body + '\n'
	for (const p of rest) body = addPage(body, p.name, p.body)
	const findings: ConnectorFinding[] = r.findings
	return { body, title: first.name, findings, warnings: r.warnings, pages: r.pages.map((p) => p.name) }
}

/** A document holding just the node on a page named like the parent page, plus placeholder pages for the taken names. */
function buildSeedDoc(input: ExpandNodeInput): { code: string; page: string; pages: number } {
	const esc = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
	const decl = `${esc(input.node.key)} [src: ${esc(input.src)}${input.node.label !== undefined ? `, label: ${esc(input.node.label)}` : ''}]\n`
	let code = input.parentPage ? '' : decl
	let pages = 1
	if (input.parentPage) {
		code = addPage(code, input.parentPage, decl)
		pages++
	}
	for (const name of input.existingPages ?? []) {
		if (!name || name.toLowerCase() === input.parentPage.toLowerCase()) continue
		code = addPage(code, name, '')
		pages++
	}
	return { code, page: input.parentPage, pages }
}
