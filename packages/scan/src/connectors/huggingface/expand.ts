/**
 * On-demand expansion of `src: "hf:<id>#<path>"` refs: `huggingfaceExpander`
 * for the scan expander registry (one page + `children`), and
 * `expandHuggingface` (standalone, any depth).
 */

import type { ExpandedPage, Expander } from '../../expand/types'
import { asStr, isObj, type Obj } from '../../util'
import { ConnectorError, type ConnectorContext, type ConnectorFinding } from '../types'
import { expandArch, isStructural } from './arch'
import { createClient, jsonFile, type HfClient, type HfOptions } from './client'
import { analyzeConfig } from './config'
import { collectDataset, configPage } from './dataset'
import { deepen } from './deepen'
import { analyzeModelIndex, componentPage, componentSummary, pipelinePage } from './diffusers'
import { emitPages, Page } from './graph'
import { hfUrl, parseHuggingface, type HfRef } from './parse'
import { render, sourceOf, type HfScanOptions } from './render'
import { analyzeApp, appCodePage, collectSpace, type SpaceFacts } from './space'
// On-demand expansion

export interface HfExpandInput {
	/** The document's `source` directive (`hf:org/name`), used for relative `src`. */
	source?: string
	/** `hf:org/name#decoder.attn`, or `#decoder.attn` relative to `source`. */
	src: string
	node: { key: string; label?: string }
	parentPage: string
	depth?: number
	options?: HfOptions
}

export interface HfExpandResult {
	body: string
	title: string
	findings: ConnectorFinding[]
	warnings: string[]
}

/** Splits `hf:...#path` (absolute or relative to `source`) into ref + path. */
export function resolveSrc(src: string, source?: string): { ref: HfRef; path: string } | null {
	let s = src.trim()
	if (!/^(hf|huggingface):/i.test(s)) {
		if (!source) return null
		s = source.trim().replace(/#.*$/, '') + (s.startsWith('#') ? s : `#${s}`)
	}
	const hash = s.indexOf('#')
	const head = hash < 0 ? s : s.slice(0, hash)
	const path = hash < 0 ? '' : s.slice(hash + 1)
	const ref = parseHuggingface(head)
	return ref ? { ref, path } : null
}

/** Renames generated pages to live under `title` (`title / Architecture`) and fixes their drills. */
function nestPages(first: Page, rest: Page[], title: string): Page[] {
	const rename = new Map<string, string>()
	for (const p of rest) rename.set(p.name, `${title} / ${p.name}`)
	first.name = title
	for (const p of [first, ...rest]) {
		if (p !== first) p.name = rename.get(p.name) ?? p.name
		for (const n of p.nodes) if (n.drill && rename.has(n.drill)) n.drill = rename.get(n.drill)
	}
	return [first, ...rest]
}

function notePage(name: string, text: string, src: string): Page {
	const p = new Page(name, 'down')
	p.node('Details', { shape: 'document', label: text, src })
	return p
}

/** Body of a Python function (by indentation), or null. */
function functionBody(code: string, fn: string): string | null {
	const m = new RegExp(`^([ \\t]*)(?:async[ \\t]+)?def[ \\t]+${fn}\\b[^\\n]*\\n`, 'm').exec(code)
	if (!m) return null
	const indent = m[1].length
	const lines = code.slice(m.index + m[0].length).split('\n')
	const body: string[] = []
	for (const l of lines) {
		if (l.trim() && l.length - l.trimStart().length <= indent) break
		body.push(l)
	}
	return body.join('\n')
}

async function expandModelPath(hf: HfClient, ref: HfRef, path: string, title: string, depth: number, o: HfScanOptions): Promise<{ pages: Page[]; warnings: string[] }> {
	const id = ref.id
	const rev = ref.ref
	const srcBase = sourceOf('model', id, rev)
	const warnings: string[] = []
	if (path === 'pipeline' || path.startsWith('pipeline.')) {
		const mi = await jsonFile<Obj>(hf, 'model', id, 'model_index.json', rev)
		const spec = analyzeModelIndex(mi.data)
		if (!spec) return { pages: [notePage(title, mi.gated ? 'model_index.json is gated: set HF_TOKEN' : 'no diffusers model_index.json', `${srcBase}#pipeline`)], warnings }
		const details: Record<string, string> = {}
		for (const c of spec.components.filter((x) => x.role === 'denoiser')) {
			const cfg = await jsonFile<Obj>(hf, 'model', id, `${c.name}/config.json`, rev)
			if (cfg.data) details[c.name] = componentSummary(cfg.data)
		}
		return { pages: [pipelinePage(spec, srcBase, title, details)], warnings }
	}
	// `<subfolder>/<arch path>`: a pipeline component or a nested transformers config
	const slash = path.indexOf('/')
	const sub = slash >= 0 ? path.slice(0, slash) : ''
	const rest = slash >= 0 ? path.slice(slash + 1) : path
	let cfgFile = sub ? `${sub}/config.json` : 'config.json'
	let cfg = await jsonFile<Obj>(hf, 'model', id, cfgFile, rev)
	for (const alt of sub ? ['scheduler_config.json', 'tokenizer_config.json', 'preprocessor_config.json'] : []) {
		if (cfg.data || cfg.gated) break
		cfgFile = `${sub}/${alt}`
		cfg = await jsonFile<Obj>(hf, 'model', id, cfgFile, rev)
	}
	if (!cfg.data) {
		if (cfg.gated) warnings.push(`${id} is gated: ${cfgFile} needs HF_TOKEN for an account with access`)
		return { pages: [notePage(title, cfg.gated ? `${cfgFile} is gated (set HF_TOKEN after accepting the license)` : `${cfgFile} not found`, `${srcBase}#${path}`)], warnings }
	}
	if (sub && isObj(cfg.data) && !cfg.data.model_type) return { pages: [componentPage(sub, cfg.data, srcBase, title)], warnings }
	const spec = analyzeConfig(cfg.data)
	if (!spec) return { pages: [notePage(title, `${cfgFile}: unsupported config`, `${srcBase}#${path}`)], warnings }
	warnings.push(...spec.assumed)
	const ctx = { srcBase, prefix: sub ? `${sub}/` : undefined, params: undefined }
	const archPath = rest || 'architecture'
	const first = expandArch(spec, archPath, ctx, title)
	if (!first) return { pages: [notePage(title, `nothing to expand at ${path}`, `${srcBase}#${path}`)], warnings }
	const pages = [first]
	const strip = (src: string) => src.slice(src.indexOf('#') + 1).slice(sub ? sub.length + 1 : 0)
	deepen(first, depth - 1, (src, name) => expandArch(spec, strip(src), ctx, name), (src) => src.startsWith(srcBase + '#') && isStructural(strip(src)), pages)
	void o
	return { pages, warnings }
}

async function expandSpacePath(hf: HfClient, ref: HfRef, path: string, title: string): Promise<{ pages: Page[]; warnings: string[] }> {
	const f: SpaceFacts = await collectSpace(hf, ref.id, ref.ref)
	const srcBase = sourceOf('space', ref.id, ref.ref)
	if (path === 'app') return { pages: [appCodePage(f, srcBase, title, hf.endpoint)], warnings: f.warnings }
	const code = [...f.files].filter(([p]) => p.endsWith('.py')).map(([, t]) => t).join('\n')
	let scoped: Map<string, string> | null = null
	if (path.startsWith('app/')) {
		const body = functionBody(code, path.slice(4))
		if (body) scoped = new Map([['handler.py', body]])
	} else if (path.startsWith('file/')) {
		const file = f.files.get(path.slice(5))
		if (file) scoped = new Map([[path.slice(5), file]])
	}
	if (!scoped) return { pages: [notePage(title, `${path}: nothing more to show`, `${srcBase}#${path}`)], warnings: f.warnings }
	const a = analyzeApp(scoped, f.meta.sdk)
	const body = scoped.values().next().value ?? ''
	if (path.startsWith('app/')) {
		// module-level `pipe = X.from_pretrained(...)` / `client = InferenceClient(...)` used inside the handler
		for (const m of code.matchAll(/^([A-Za-z_]\w*)[ \t]*=[ \t]*(.+)$/gm)) {
			if (!new RegExp(`\\b${m[1]}\\b`).test(body)) continue
			for (const c of analyzeApp(new Map([['line.py', `${code.match(/^[A-Z_]+\s*=\s*["'][^"'\n]+["']$/gm)?.join('\n') ?? ''}\n${m[0]}`]]), f.meta.sdk).calls) {
				if (!a.calls.some((x) => x.target === c.target)) a.calls.push(c)
			}
		}
	}
	const p = new Page(title, 'right')
	const fnKey = p.node(path.slice(path.indexOf('/') + 1), { icon: path.startsWith('app/') ? 'function' : 'python', src: `${srcBase}#${path}` })
	for (const c of a.calls) {
		const repo = /^[\w.-]+\/[\w.-]+$/.test(c.target)
		const k = p.node(c.target, { label: `${c.target} · ${c.via}`, icon: repo ? 'huggingface' : 'ai', src: repo ? `hf:${c.target}` : `${srcBase}#call/${c.target}` })
		p.edge(fnKey, k, c.kind === 'api' ? 'API call' : 'calls')
	}
	for (const e of a.externals.filter((x) => x.kind !== 'llm-api')) {
		const k = p.node(e.name, { icon: e.icon, shape: e.kind === 'vector-db' ? 'cylinder' : undefined, src: `${srcBase}#deps/${e.name}` })
		p.edge(fnKey, k, 'uses')
	}
	if (path.startsWith('app/')) {
		// other app functions it calls, and module objects of local classes it uses
		for (const m of code.matchAll(/^(?:async[ \t]+)?def[ \t]+(\w+)/gm)) {
			if (m[1] === path.slice(4) || !new RegExp(`\\b${m[1]}\\(`).test(body)) continue
			p.edge(fnKey, p.node(`${m[1]}()`, { icon: 'function', src: `${srcBase}#app/${m[1]}` }), 'calls')
		}
		for (const m of code.matchAll(/^(\w+)[ \t]*=[ \t]*([A-Z]\w*)\(/gm)) {
			if (!new RegExp(`\\b${m[1]}\\b`).test(body)) continue
			const file = [...f.files].find(([, t]) => new RegExp(`^class[ \t]+${m[2]}\\b`, 'm').test(t))?.[0]
			if (!file) continue
			p.edge(fnKey, p.node(m[2], { label: `${m[2]} (${file})`, icon: 'python', src: `${srcBase}#file/${file}` }), `uses ${m[1]}`)
		}
	} else {
		for (const m of body.matchAll(/^(?:async[ \t]+)?def[ \t]+(\w+)|^class[ \t]+(\w+)/gm)) {
			const name = m[1] ?? m[2]
			p.edge(fnKey, p.node(m[1] ? `${name}()` : name, { icon: m[1] ? 'function' : 'python', src: `${srcBase}#app/${name}` }), 'defines', { dotted: true })
		}
	}
	if (p.nodes.length === 1) p.node('Details', { shape: 'document', label: 'no model calls or services found in this code', src: `${srcBase}#${path}` })
	return { pages: [p], warnings: f.warnings }
}

/** Expands one `src` into an octo page body (more `page` sections when `depth > 1`). */
async function expandPages(hf: HfClient, ref: HfRef, path: string, title: string, depth: number, o: HfScanOptions, src: string): Promise<{ pages: Page[]; warnings: string[] }> {
	const type = ref.options.type
	if (!path) {
		const r = await render(hf, type, ref.id, ref.ref, { ...o, depth })
		return { pages: nestPages(r.root, r.pages, title), warnings: r.warnings }
	}
	if (type === 'model') return expandModelPath(hf, ref, path, title, depth, o)
	if (type === 'dataset' && path.startsWith('config/')) {
		const f = await collectDataset(hf, ref.id, ref.ref, 0)
		const name = path.slice(7).split('/')[0]
		const c = f.configs.find((x) => x.name === name)
		return { pages: [c ? configPage(c, sourceOf('dataset', ref.id, ref.ref), title) : notePage(title, `config ${name} not found`, src)], warnings: f.warnings }
	}
	if (type === 'space') return expandSpacePath(hf, ref, path, title)
	return { pages: [notePage(title, `${hfUrl(type, ref.id, hf.endpoint)} · ${path}`, src)], warnings: [] }
}

/** Expands one `src` into an octo page body (more `page` sections when `depth > 1`). */
export async function expandHuggingface(input: HfExpandInput, ctx: ConnectorContext): Promise<HfExpandResult> {
	const hit = resolveSrc(input.src, input.source)
	if (!hit) throw new ConnectorError(`not a Hugging Face src: "${input.src}"`)
	const o: HfScanOptions = { ...(input.options ?? {}), depth: input.depth }
	const hf = createClient(ctx, o)
	const depth = Math.max(1, input.depth ?? 1)
	const title = input.node.label?.trim() || input.node.key
	const { pages, warnings } = await expandPages(hf, hit.ref, hit.path, title, depth, o, input.src)
	return {
		body: emitPages(pages),
		title,
		findings: [{ analyzer: 'huggingface', confidence: 0.9, notes: [`expanded ${input.src} into ${pages.length} page(s)`] }],
		warnings,
	}
}

/** Is this child `src` structurally inside the page it sits on (recursed into for depth > 1)? */
export function isChildPath(base: string, src: string | undefined): boolean {
	if (!src) return false
	const hash = src.indexOf('#')
	if (hash < 0 || src.slice(0, hash) !== base) return false
	const frag = src.slice(hash + 1)
	if (/^config\/[^/]+$/.test(frag) || frag === 'app' || /^app\/\w+$/.test(frag) || frag === 'pipeline') return true
	if (/^[\w.-]+\/$/.test(frag)) return true
	const slash = frag.indexOf('/')
	return isStructural(slash >= 0 ? frag.slice(slash + 1) : frag)
}

/** Registry adapter (`registerExpander('huggingface', huggingfaceExpander)`): one page per call; the shared deepener recurses through `children`. */
export const huggingfaceExpander: Expander = async (req, ctx): Promise<ExpandedPage | null> => {
	const raw = req.src.raw.trim()
	const hit = resolveSrc(raw, req.sourceInput)
	if (!hit) throw new ConnectorError(`not a Hugging Face src: "${raw}"`, 400)
	const o: HfScanOptions = { ...(req.options as HfOptions), depth: 1 }
	const hf = createClient(ctx, o)
	const title = req.node.label?.trim() || req.node.key
	const { pages, warnings } = await expandPages(hf, hit.ref, hit.path, title, 1, o, raw)
	const page = pages[0]
	if (!page || !page.nodes.length) return null
	const base = sourceOf(hit.ref.options.type, hit.ref.id, hit.ref.ref)
	// a page that is already a whole repo's diagram has its drill pages inline; keep only the first
	for (const n of page.nodes) if (n.drill) delete n.drill
	return {
		body: emitPages([page]),
		children: page.nodes.filter((n) => isChildPath(base, n.src)).map((n) => n.key),
		findings: [{ analyzer: 'huggingface', confidence: 0.9, notes: [`expanded ${raw}`] }],
		warnings,
	}
}
