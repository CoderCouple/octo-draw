/**
 * Minimal text edits on octo DSL source. Everything outside the touched
 * declaration is preserved byte-for-byte.
 */

import { analyzeOcto } from './parse'
import { printEdge, quoteName, quoteValue } from './print'
import { editPage, findPage, splitPages } from '../drill/pages'

function splice(src: string, from: number, to: number, text: string): string {
	return src.slice(0, from) + text + src.slice(to)
}

/** Append a line at the end of the source, adding a newline separator when needed. */
export function appendLine(src: string, line: string): string {
	if (src === '') return line + '\n'
	return src.endsWith('\n') ? src + line + '\n' : src + '\n' + line + '\n'
}

/** Run `edit` on one page's body (root by default); an unknown page leaves `src` unchanged. */
function onPage(src: string, page: string | undefined, edit: (body: string) => string): string {
	if (!page && !src.includes('page')) return edit(src)
	if (page && !findPage(splitPages(src), page)) return src
	return editPage(src, page, edit)
}

/**
 * `page` (default root `''`) limits the edit to that page's section of a
 * multi-page source; an implicit node gets its declaration line inside it.
 */
export function setNodeProp(src: string, key: string, prop: string, value: string | null, page?: string): string {
	return onPage(src, page, (body) => patchNodeProp(body, key, prop, value))
}

function patchNodeProp(src: string, key: string, prop: string, value: string | null): string {
	const { decls } = analyzeOcto(src)
	const d = decls.get(key)
	if (!d) {
		if (value === null) return src
		return appendLine(src, `${quoteName(key)} [${prop}: ${quoteValue(value)}]`)
	}
	if (!d.props) {
		if (value === null) return src
		return splice(src, d.nameTo, d.nameTo, ` [${prop}: ${quoteValue(value)}]`)
	}
	const block = d.props
	const entries = block.entries
	let idx = -1
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].key === prop) {
			idx = i
			break
		}
	}
	if (value === null) {
		if (idx < 0) return src
		let out: string
		if (entries.length === 1) out = splice(src, d.nameTo, block.to, '')
		else if (idx < entries.length - 1) out = splice(src, entries[idx].from, entries[idx + 1].from, '')
		else out = splice(src, entries[idx - 1].to, entries[idx].to, '')
		// Remove duplicates of the same prop, if any.
		return entries.filter((e) => e.key === prop).length > 1 ? patchNodeProp(out, key, prop, null) : out
	}
	const text = `${prop}: ${quoteValue(value)}`
	if (idx >= 0) return splice(src, entries[idx].keyTo, entries[idx].to, `: ${quoteValue(value)}`)
	const close = block.closed ? '' : ']'
	if (entries.length === 0) return splice(src, block.from + 1, block.from + 1, text + close)
	const last = entries[entries.length - 1]
	return splice(src, last.to, last.to, `, ${text}${close}`)
}

export function renameNodeLabel(src: string, key: string, label: string, page?: string): string {
	return setNodeProp(src, key, 'label', label, page)
}

/** Split a props-block body on top-level commas (quotes respected). */
function splitEntries(body: string): string[] {
	const out: string[] = []
	let cur = ''
	let q = false
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]
		if (ch === '\\' && q) {
			cur += ch + (body[i + 1] ?? '')
			i++
			continue
		}
		if (ch === '"') q = !q
		if (ch === ',' && !q) {
			out.push(cur)
			cur = ''
			continue
		}
		cur += ch
	}
	out.push(cur)
	return out.map((s) => s.trim()).filter(Boolean)
}

const entryKey = (raw: string) => raw.split(':')[0].trim()

/**
 * Sets (or with `null` removes) a property on one connection, identified by
 * its edge key (`id` or `${from}->${to}#n`). A single-edge statement gets a
 * minimal edit of its trailing `[...]`; a branching/chained statement is split
 * into one line per edge first so only the target edge changes.
 */
export function setEdgeProp(src: string, edgeKey: string, prop: string, value: string | null, page?: string): string {
	return onPage(src, page, (body) => patchEdgeProp(body, edgeKey, prop, value))
}

function patchEdgeProp(src: string, edgeKey: string, prop: string, value: string | null): string {
	const { statements } = analyzeOcto(src)
	for (const s of statements) {
		if (s.kind !== 'connection') continue
		const hit = s.edges.find((e) => e.edge.key === edgeKey)
		if (!hit) continue
		if (s.edges.length === 1) {
			const last = s.items[s.items.length - 1]
			// first unquoted `[` after the last name is the connection's props block
			let open = -1
			let q = false
			for (let i = last ? last.to : s.from; i < s.to; i++) {
				const ch = src[i]
				if (ch === '\\' && q) {
					i++
					continue
				}
				if (ch === '"') q = !q
				else if (ch === '[' && !q) {
					open = i
					break
				}
			}
			if (open < 0) {
				if (value === null) return src
				return splice(src, s.to, s.to, ` [${prop}: ${quoteValue(value)}]`)
			}
			const closed = src[s.to - 1] === ']'
			const bodyEnd = closed ? s.to - 1 : s.to
			const entries = splitEntries(src.slice(open + 1, bodyEnd))
			const idx = entries.findIndex((e) => entryKey(e) === prop)
			let next = entries
			if (value === null) {
				if (idx < 0) return src
				next = entries.filter((e) => entryKey(e) !== prop)
			} else if (idx >= 0) {
				next = entries.map((e, i) => (i === idx ? `${prop}: ${quoteValue(value)}` : e))
			} else next = [...entries, `${prop}: ${quoteValue(value)}`]
			if (!next.length) {
				let from = open
				while (from > 0 && (src[from - 1] === ' ' || src[from - 1] === '\t')) from--
				return splice(src, from, s.to, '')
			}
			return splice(src, open, s.to, `[${next.join(', ')}]`)
		}
		// split: inline node declarations first, then one line per edge
		const ls = src.lastIndexOf('\n', s.from - 1) + 1
		const indent = /^[ \t]*/.exec(src.slice(ls, s.from))?.[0] ?? ''
		const lines: string[] = []
		for (const item of s.items) if (item.props) lines.push(src.slice(item.from, item.to))
		for (const e of s.edges) {
			if (e.edge !== hit.edge) {
				lines.push(printEdge(e.edge, e.explicitId))
				continue
			}
			const edge = { ...e.edge, style: { ...e.edge.style } }
			if (prop === 'color' || prop === 'dash') {
				if (value === null) delete (edge.style as Record<string, string>)[prop]
				else (edge.style as Record<string, string>)[prop] = value
				lines.push(printEdge(edge, e.explicitId))
			} else if (prop === 'label') {
				if (value === null) delete edge.label
				else edge.label = value
				lines.push(printEdge(edge, e.explicitId))
			} else {
				const line = printEdge(edge, e.explicitId)
				lines.push(value === null ? line : setEdgePropLine(line, prop, value))
			}
		}
		return splice(src, s.from, s.to, lines.join('\n' + indent))
	}
	return src
}

function setEdgePropLine(line: string, prop: string, value: string): string {
	return line.endsWith(']') ? `${line.slice(0, -1)}, ${prop}: ${quoteValue(value)}]` : `${line} [${prop}: ${quoteValue(value)}]`
}
