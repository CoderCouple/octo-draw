/**
 * Recursive page generation shared by `scan --depth N` and `expandNode({ depth })`.
 *
 * Breadth-first over pages: every expandable node on a page at level < depth
 * (root = level 0) that has no page yet gets one, named
 * `<parent page> / <label>` (just `<label>` under the root), with `drill:`
 * patched onto the node. Which nodes are expandable on a page:
 * - pages made by an expander: the `children` it listed;
 * - other pages: nodes whose `src` is structurally inside the `src` of the
 *   node that drills into the page (`isChildSrc`); on the root page (or pages
 *   reached from a node without `src`) every node with `src`.
 * The same `src` is expanded once; later nodes with it drill into that page.
 *
 * Written as a generator so one implementation drives both the sync scanners
 * (in-memory files / inventories) and async on-demand expansion.
 */

import { addPage, drillTargets, editPage, parseOcto, parsePage, ROOT_PAGE, setNodeProp, splitPages, type DiagramIR } from '@octo-draw/core'
import { safePageName } from '../scan'
import { isChildSrc, parseSrc } from './src'
import type { ExpandedPage, SrcRef } from './types'

export interface DeepenRequest {
	src: SrcRef
	node: { key: string; label?: string }
	/** The page the node is on. */
	page: string
	/** Name the new page will get. */
	name: string
}

export interface DeepenOptions {
	/** Levels below the start: a node on a page at level < depth gets a page. */
	depth: number
	/** Total page cap including existing pages (default 200). */
	maxPages?: number
	/** `Date.now()` deadline; generation stops (with a warning) after it. */
	deadline?: number
	/**
	 * Start from these nodes on existing pages instead of the whole document
	 * (on-demand expansion). They are at level 0: their pages are level 1.
	 */
	seeds?: { page: string; key: string; label?: string; src: string }[]
	/** Page name for the first seed's page (otherwise derived from the label). */
	seedName?: string
}

export interface DeepenResult {
	/** New pages in breadth-first order. */
	pages: { name: string; body: string }[]
	/** `drill:` props to set on nodes of EXISTING pages (new pages already have theirs). */
	drills: { page: string; key: string; name: string }[]
	warnings: string[]
	findings: NonNullable<ExpandedPage['findings']>
	/** Nodes left unexpanded because of the page cap or the deadline. */
	skipped: number
}

interface Entry {
	page: string
	ir: DiagramIR
	level: number
	/** Expander pages: the keys to recurse into. */
	children?: Set<string>
	/** Src of the node that drills here (scanner pages). */
	parentSrc?: SrcRef
}

const labelOf = (n: { key: string; label?: string }) => (n.label ?? n.key).replace(/\/+$/, '').trim() || n.key

/** `<parent> / <label>` (just `<label>` under the root), safe for `page` / `drill:`. */
export function childPageName(parent: string, label: string): string {
	return safePageName(parent ? `${parent} / ${label}` : label)
}

/** Makes `want` unique against `taken` (lower-cased names), adding ` 2`, ` 3`, ... and records it. */
export function uniquePageName(want: string, taken: Set<string>): string {
	let name = want
	for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${want} ${n}`
	taken.add(name.toLowerCase())
	return name
}

export function* deepenSteps(code: string, opts: DeepenOptions): Generator<DeepenRequest, DeepenResult, ExpandedPage | null> {
	const maxPages = opts.maxPages ?? 200
	const split = splitPages(code)
	const names = split.map((p) => p.name)
	const taken = new Set(names.filter((n) => n !== ROOT_PAGE).map((n) => n.toLowerCase()))
	const out: DeepenResult = { pages: [], drills: [], warnings: [], findings: [], skipped: 0 }
	const bodies = new Map<string, string>()
	const pendingDrills = new Map<string, { key: string; name: string }[]>()
	const seen = new Map<string, string>()
	const irCache = new Map<string, DiagramIR>()
	const irOf = (page: string): DiagramIR | null => {
		if (irCache.has(page)) return irCache.get(page)!
		const r = parsePage(code, page)
		if (r) irCache.set(page, r.ir)
		return r?.ir ?? null
	}
	let pageCount = names.length
	let stopped: 'cap' | 'time' | null = null
	let first = true

	const queue: Entry[] = []
	let seedKeys: Map<string, Set<string>> | null = null
	if (opts.seeds) {
		seedKeys = new Map()
		for (const s of opts.seeds) {
			const set = seedKeys.get(s.page) ?? new Set<string>()
			set.add(s.key)
			seedKeys.set(s.page, set)
		}
		for (const [page, keys] of seedKeys) {
			const ir = irOf(page)
			if (ir) queue.push({ page, ir, level: 0, children: keys })
		}
	} else {
		// existing pages by BFS level, with the src of the node that drills into each
		const root = irOf(ROOT_PAGE)
		if (root) queue.push({ page: ROOT_PAGE, ir: root, level: 0 })
		const placed = new Set<string>([ROOT_PAGE])
		for (let i = 0; i < queue.length; i++) {
			const e = queue[i]
			const targets = drillTargets(e.ir, names, e.page)
			for (const n of e.ir.nodes) {
				const t = targets[n.key]
				if (t === undefined || placed.has(t.toLowerCase())) continue
				placed.add(t.toLowerCase())
				const ir = irOf(t)
				if (ir) queue.push({ page: t, ir, level: e.level + 1, parentSrc: n.ext?.src ? parseSrc(n.ext.src) : undefined })
			}
		}
		// existing pages are already expanded: remember their srcs
		for (const e of queue) {
			const targets = drillTargets(e.ir, names, e.page)
			for (const n of e.ir.nodes) if (n.ext?.src && targets[n.key] !== undefined && !seen.has(n.ext.src)) seen.set(n.ext.src, targets[n.key])
		}
	}

	for (let i = 0; i < queue.length; i++) {
		const e = queue[i]
		if (e.level >= opts.depth) continue
		const generated = bodies.has(e.page)
		// seeds were checked by the caller (and may match a page by name only because of placeholders)
		const targets = opts.seeds && e.level === 0 ? {} : drillTargets(e.ir, generated ? [] : names, e.page)
		for (const n of e.ir.nodes) {
			const srcText = n.ext?.src
			if (!srcText || n.ext?.ghost || targets[n.key] !== undefined) continue
			const src = parseSrc(srcText)
			if (e.children) {
				if (!e.children.has(n.key)) continue
			} else if (e.parentSrc && !isChildSrc(e.parentSrc, src)) continue
			const known = seen.get(srcText)
			if (known !== undefined) {
				if (known.toLowerCase() !== e.page.toLowerCase()) addDrill(e.page, n.key, known)
				continue
			}
			if (stopped || pageCount >= maxPages || (opts.deadline !== undefined && Date.now() > opts.deadline)) {
				stopped ??= pageCount >= maxPages ? 'cap' : 'time'
				out.skipped++
				continue
			}
			const want = first && opts.seedName ? opts.seedName : childPageName(e.page, labelOf(n))
			first = false
			const name = uniquePageName(want, taken)
			const result = yield { src, node: { key: n.key, label: n.label }, page: e.page, name }
			if (!result || !result.body.trim()) {
				taken.delete(name.toLowerCase())
				out.warnings.push(...(result?.warnings ?? []))
				continue
			}
			const parsed = parseOcto(result.body)
			if (!parsed.ir.nodes.length) {
				taken.delete(name.toLowerCase())
				continue
			}
			pageCount++
			seen.set(srcText, name)
			bodies.set(name, result.body)
			out.pages.push({ name, body: result.body })
			out.warnings.push(...(result.warnings ?? []))
			out.findings.push(...(result.findings ?? []))
			addDrill(e.page, n.key, name)
			queue.push({ page: name, ir: parsed.ir, level: e.level + 1, children: new Set(result.children ?? []) })
		}
	}
	if (stopped === 'cap') out.warnings.push(`page cap reached (${maxPages} pages): ${out.skipped} node${out.skipped === 1 ? '' : 's'} were not expanded; expand them on demand`)
	if (stopped === 'time') out.warnings.push(`time budget reached: ${out.skipped} node${out.skipped === 1 ? '' : 's'} were not expanded; expand them on demand`)
	// drills on generated pages go into their bodies
	for (const p of out.pages) {
		const ds = pendingDrills.get(p.name)
		if (!ds) continue
		let body = p.body
		for (const d of ds) body = setNodeProp(body, d.key, 'drill', d.name)
		p.body = body
		pendingDrills.delete(p.name)
	}
	for (const [page, ds] of pendingDrills) for (const d of ds) out.drills.push({ page, key: d.key, name: d.name })
	return out

	function addDrill(page: string, key: string, name: string) {
		const list = pendingDrills.get(page) ?? []
		list.push({ key, name })
		pendingDrills.set(page, list)
	}
}

/** Runs the steps with a synchronous expander. */
export function deepenSync(code: string, expand: (req: DeepenRequest) => ExpandedPage | null, opts: DeepenOptions): DeepenResult {
	const g = deepenSteps(code, opts)
	let r = g.next()
	while (!r.done) {
		let page: ExpandedPage | null
		try {
			page = expand(r.value)
		} catch (err) {
			page = { body: '', warnings: [`${r.value.src.raw}: ${err instanceof Error ? err.message : String(err)}`] }
		}
		r = g.next(page)
	}
	return r.value
}

/** Runs the steps with an async expander (one call at a time). */
export async function deepenAsync(code: string, expand: (req: DeepenRequest) => Promise<ExpandedPage | null>, opts: DeepenOptions): Promise<DeepenResult> {
	const g = deepenSteps(code, opts)
	let r = g.next()
	while (!r.done) {
		let page: ExpandedPage | null
		try {
			page = await expand(r.value)
		} catch (err) {
			if (opts.seeds && r.value.page === opts.seeds[0]?.page && r.value.node.key === opts.seeds[0]?.key) throw err
			page = { body: '', warnings: [`${r.value.src.raw}: ${err instanceof Error ? err.message : String(err)}`] }
		}
		r = g.next(page)
	}
	return r.value
}

/** Applies a deepen result to the document: drills on existing pages, then the new pages appended. */
export function applyDeepen(code: string, r: DeepenResult): string {
	const byPage = new Map<string, { key: string; name: string }[]>()
	for (const d of r.drills) {
		const list = byPage.get(d.page) ?? []
		list.push(d)
		byPage.set(d.page, list)
	}
	let out = code
	for (const [page, ds] of byPage) {
		out = editPage(out, page, (body) => {
			let b = body
			for (const d of ds) b = setNodeProp(b, d.key, 'drill', d.name)
			return b
		})
	}
	for (const p of r.pages) out = addPage(out, p.name, p.body)
	return out
}
