/**
 * Pages: one octo source holds several sub-diagrams. A line that is exactly
 * `page <Name>` (column 0, name may be quoted, optional trailing comment)
 * starts a page that runs until the next such line. Everything before the
 * first one is the root page `''`.
 *
 * Page bodies are parsed with every offset kept relative to the FULL source
 * (text outside the page is blanked, newlines kept), so spans, lines and
 * diagnostics can be used directly by the editor and the text patchers.
 */

import type { DiagramIR, Diagnostic, ParseResult } from '../ir'
import { analyzeOcto, OPS, type OctoAnalysis } from '../dsl/parse'

export interface OctoPage {
	/** `''` for the root page. */
	name: string
	/** Start of the `page` line (0 for root). */
	from: number
	/** Exclusive end: start of the next `page` line, or the source length. */
	to: number
	/** Just after the header line (0 for root). */
	bodyFrom: number
	/** 1-based line of `from`. */
	line: number
}

export type ParsedPage = OctoPage & ParseResult

export const ROOT_PAGE = ''

const NAME_BAD = /[[\]{},:"]/

/** Parses a `page <Name>` header line; returns the page name or null when the line is not a header. */
export function parsePageHeader(line: string): string | null {
	if (line.endsWith('\r')) line = line.slice(0, -1)
	const m = /^page[ \t]+/.exec(line)
	if (!m) return null
	let rest = line.slice(m[0].length)
	if (rest.startsWith('"')) {
		let name = ''
		let i = 1
		let closed = false
		while (i < rest.length) {
			const c = rest[i]
			if (c === '\\' && (rest[i + 1] === '"' || rest[i + 1] === '\\')) {
				name += rest[i + 1]
				i += 2
				continue
			}
			if (c === '"') {
				closed = true
				i++
				break
			}
			name += c
			i++
		}
		if (!closed || name === '') return null
		const tail = rest.slice(i)
		if (!isCommentTail(tail)) return null
		return name
	}
	// Strip a trailing comment: `//` or a lone `#` preceded by whitespace (the
	// header keyword's whitespace counts for the very first character).
	rest = ' ' + rest
	const cut = /[ \t](\/\/|#(?=[ \t]|$))/.exec(rest)
	if (cut) rest = rest.slice(0, cut.index)
	const parts = rest.trim().split(/[ \t]+/).filter(Boolean)
	if (parts.length === 0) return null
	if (parts.some((p) => NAME_BAD.test(p) || (OPS as readonly string[]).includes(p))) return null
	return parts.join(' ')
}

function isCommentTail(tail: string): boolean {
	const t = tail.trim()
	return t === '' || (/^[ \t]/.test(tail) && (t.startsWith('//') || /^#([ \t]|$)/.test(t)))
}

/** All pages in source order; the root page is always first (possibly empty). */
export function splitPages(src: string): OctoPage[] {
	const pages: OctoPage[] = [{ name: ROOT_PAGE, from: 0, to: src.length, bodyFrom: 0, line: 1 }]
	let at = 0
	let line = 1
	while (at <= src.length) {
		const nl = src.indexOf('\n', at)
		const end = nl < 0 ? src.length : nl
		if (src.startsWith('page', at)) {
			const name = parsePageHeader(src.slice(at, end))
			if (name !== null) {
				pages[pages.length - 1].to = at
				pages.push({ name, from: at, to: src.length, bodyFrom: nl < 0 ? src.length : nl + 1, line })
			}
		}
		if (nl < 0) break
		at = nl + 1
		line++
	}
	return pages
}

/** Page names in order, root (`''`) first. */
export function pageNames(src: string): string[] {
	return splitPages(src).map((p) => p.name)
}

/** Finds a page by name: exact match first, then case-insensitive. */
export function findPage(pages: OctoPage[], name: string): OctoPage | undefined {
	if (name === ROOT_PAGE) return pages[0]
	return pages.find((p) => p.name === name) ?? pages.find((p) => p.name !== ROOT_PAGE && p.name.toLowerCase() === name.toLowerCase())
}

/** The full source truncated at the page's end with everything before its body blanked (newlines kept). */
function maskedSource(src: string, page: OctoPage): string {
	if (page.bodyFrom === 0) return page.to === src.length ? src : src.slice(0, page.to)
	return src.slice(0, page.bodyFrom).replace(/[^\n]/g, ' ') + src.slice(page.bodyFrom, page.to)
}

/** Statement-level analysis of one page with offsets into the full source. */
export function analyzePage(src: string, page: OctoPage): OctoAnalysis {
	const a = analyzeOcto(maskedSource(src, page))
	if (page.name !== ROOT_PAGE) {
		const title = a.statements.find((s) => s.kind === 'directive' && s.name === 'title' && s.parent === undefined)
		if (title) {
			delete a.result.ir.title
			a.result.diagnostics.push({ from: title.from, to: title.to, severity: 'warning', message: '"title" is only read from the root page' })
			a.result.diagnostics.sort((x, y) => x.from - y.from)
		}
	}
	return a
}

/** Parses one page's body. Spans and diagnostics are offsets into the full source. Null when no such page. */
export function parsePage(src: string, name: string): ParseResult | null {
	const page = findPage(splitPages(src), name)
	return page ? analyzePage(src, page).result : null
}

/** Maps node key to its drill target page name (`drill: P`, else a page named like the key, case-insensitive). */
export function drillTargets(ir: DiagramIR, pageNames: string[], self?: string): Record<string, string> {
	const byLower = new Map<string, string>()
	for (const p of pageNames) {
		if (p === ROOT_PAGE) continue
		if (self !== undefined && p.toLowerCase() === self.toLowerCase()) continue
		const k = p.toLowerCase()
		if (!byLower.has(k)) byLower.set(k, p)
	}
	const exact = new Set(byLower.values())
	const resolve = (name: string) => (exact.has(name) ? name : byLower.get(name.toLowerCase()))
	const out: Record<string, string> = {}
	for (const n of ir.nodes) {
		const drill = n.ext?.drill
		const target = (drill !== undefined && drill !== 'true' ? resolve(drill) : undefined) ?? resolve(n.key)
		if (target !== undefined) out[n.key] = target
	}
	return out
}

/** Parses every page and adds cross-page warnings (unknown `drill:` targets, duplicate page names). */
export function parseOctoPages(src: string): { pages: ParsedPage[]; diagnostics: Diagnostic[] } {
	const split = splitPages(src)
	const names = split.map((p) => p.name)
	const pages: ParsedPage[] = []
	const diagnostics: Diagnostic[] = []
	const seen = new Set<string>()
	for (const page of split) {
		const a = analyzePage(src, page)
		pages.push({ ...page, ...a.result })
		diagnostics.push(...a.result.diagnostics)
		if (page.name !== ROOT_PAGE) {
			const lower = page.name.toLowerCase()
			if (seen.has(lower)) {
				const end = page.bodyFrom > page.from && src[page.bodyFrom - 1] === '\n' ? page.bodyFrom - 1 : page.bodyFrom
				diagnostics.push({ from: page.from, to: end, severity: 'warning', message: `Duplicate page "${page.name}" (only the first one is used)` })
			}
			seen.add(lower)
		}
		const lowerNames = new Set(names.filter((n) => n !== ROOT_PAGE && n.toLowerCase() !== page.name.toLowerCase()).map((n) => n.toLowerCase()))
		for (const s of a.statements) {
			const items = s.kind === 'decl' || s.kind === 'connection' ? s.items : s.kind === 'group' ? [s.item] : []
			for (const item of items) {
				for (const e of item.props?.entries ?? []) {
					if (e.key !== 'drill') continue
					const target = e.value === 'true' ? item.key : e.value
					if (!lowerNames.has(target.toLowerCase())) {
						diagnostics.push({ from: e.from, to: e.to, severity: 'warning', message: `No page named "${target}" to drill into` })
					}
				}
			}
		}
	}
	diagnostics.sort((a, b) => a.from - b.from)
	return { pages, diagnostics }
}

/** The page containing `offset` (a `page` line belongs to the page it starts). */
export function pageAt(src: string, offset: number): string {
	const pages = splitPages(src)
	for (let i = pages.length - 1; i > 0; i--) if (offset >= pages[i].from) return pages[i].name
	return ROOT_PAGE
}

/** Quotes a page name when it would not read back as a bare `page <Name>` header. */
export function printPageName(name: string): string {
	const bare = name.replace(/[ \t]+/g, ' ')
	if (bare === name && parsePageHeader(`page ${name}`) === name) return name
	return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Appends a page (`page <Name>` + body). Returns `src` unchanged if a page with that name (case-insensitive) exists or the name is empty. */
export function addPage(src: string, name: string, body = ''): string {
	name = name.replace(/\r?\n/g, ' ')
	if (name.trim() === '') return src
	const pages = splitPages(src)
	if (pages.some((p) => p.name !== ROOT_PAGE && p.name.toLowerCase() === name.toLowerCase())) return src
	let out = src
	if (out !== '' && !out.endsWith('\n')) out += '\n'
	if (out !== '' && !out.endsWith('\n\n')) out += '\n'
	out += `page ${printPageName(name)}\n`
	if (body !== '') out += body.endsWith('\n') ? body : body + '\n'
	return out
}

/**
 * Runs a text transform on one page's body as if it were a standalone source,
 * and splices the result back so only that page changes. Blank lines that
 * separate the page from the next one stay at its end. Unknown pages throw.
 */
export function editPage(src: string, page: string | undefined, edit: (body: string) => string): string {
	if (page === undefined || page === ROOT_PAGE) {
		const pages = splitPages(src)
		if (pages.length === 1) return edit(src)
		return spliceBody(src, pages[0], pages.length > 1, edit)
	}
	const pages = splitPages(src)
	const p = findPage(pages, page)
	if (!p) throw new Error(`Unknown page "${page}"`)
	return spliceBody(src, p, p.to < src.length, edit)
}

function spliceBody(src: string, p: OctoPage, followed: boolean, edit: (body: string) => string): string {
	let body = src.slice(p.bodyFrom, p.to)
	let trailer = ''
	if (followed) {
		const m = /(?<=\n)(?:[ \t]*\n)+$/.exec(body)
		if (m) {
			trailer = m[0]
			body = body.slice(0, m.index)
		}
	}
	body = edit(body)
	if (followed && body !== '' && !body.endsWith('\n')) body += '\n'
	// The header line may lack a newline when the page was empty at EOF.
	const head = src.slice(0, p.bodyFrom)
	const sep = p.name !== ROOT_PAGE && body !== '' && head !== '' && !head.endsWith('\n') ? '\n' : ''
	return head + sep + body + trailer + src.slice(p.to)
}
