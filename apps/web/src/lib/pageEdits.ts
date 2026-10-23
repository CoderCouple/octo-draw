import { addPage, parseOctoPages, printPageName, setNodeProp, splitPages } from './drillCore'

/**
 * Pure page-level edits for the outline and "Add sub-diagram": child page
 * names, create + link, rename (links follow) and delete (links removed).
 */

const lower = (s: string) => s.toLowerCase()

/** `<parent> / <label>` (just `<label>` under the root), made unique with ` 2`, ` 3`, … */
export function childPageName(src: string, parent: string, label: string): string {
	const base = (parent ? `${parent} / ${label}` : label).replace(/\s+/g, ' ').trim() || 'Page'
	const taken = new Set(splitPages(src).map((p) => lower(p.name)))
	if (!taken.has(lower(base))) return base
	let n = 2
	while (taken.has(lower(`${base} ${n}`))) n++
	return `${base} ${n}`
}

/** Creates an empty page for node `key` on `page` and links it with `drill:` (one edit). */
export function addSubDiagram(src: string, page: string, key: string, label: string, body = ''): { code: string; page: string } {
	const name = childPageName(src, page, label)
	const withPage = addPage(src, name, body)
	return { code: setNodeProp(withPage, key, 'drill', name, page), page: name }
}

/** Nodes (page, key) whose drill target is `name`: explicit `drill:`, bare `drill` or a key named like the page. */
function linksTo(src: string, name: string): { page: string; key: string; explicit: boolean }[] {
	const out: { page: string; key: string; explicit: boolean }[] = []
	for (const p of parseOctoPages(src).pages) {
		if (lower(p.name) === lower(name)) continue
		for (const n of p.ir.nodes) {
			const d = n.ext?.drill
			if (d !== undefined && d !== 'true') {
				if (lower(d) === lower(name)) out.push({ page: p.name, key: n.key, explicit: true })
			} else if (lower(n.key) === lower(name)) out.push({ page: p.name, key: n.key, explicit: d !== undefined })
		}
	}
	return out
}

function renameOne(src: string, from: string, to: string): string {
	const page = splitPages(src).find((p) => p.name === from)
	if (!page || !from) return src
	const links = linksTo(src, from)
	const headerEnd = page.bodyFrom > page.from && src[page.bodyFrom - 1] === '\n' ? page.bodyFrom - 1 : page.bodyFrom
	let out = src.slice(0, page.from) + `page ${printPageName(to)}` + src.slice(headerEnd)
	for (const l of links) out = setNodeProp(out, l.key, 'drill', to, l.page)
	return out
}

/**
 * Renames a page; every link to it follows (implicit key-named links get an
 * explicit `drill:`), and path-style child pages (`old / x`) are renamed too.
 * Returns `src` for the root, unknown pages or a name that is taken.
 */
export function renamePage(src: string, from: string, to: string): string {
	to = to.replace(/\s+/g, ' ').trim()
	if (!from || !to || from === to) return src
	const names = splitPages(src).map((p) => p.name)
	if (!names.includes(from)) return src
	if (names.some((n) => n !== from && lower(n) === lower(to))) return src
	let out = renameOne(src, from, to)
	const prefix = from + ' / '
	for (const n of names) if (n.startsWith(prefix)) {
		const next = to + ' / ' + n.slice(prefix.length)
		if (!splitPages(out).some((p) => lower(p.name) === lower(next))) out = renameOne(out, n, next)
	}
	return out
}

/** Deletes a page section and the `drill:` props that pointed at it. The root stays. */
export function deletePage(src: string, name: string): string {
	if (!name) return src
	const page = splitPages(src).find((p) => p.name === name)
	if (!page) return src
	const links = linksTo(src, name).filter((l) => l.explicit)
	let head = src.slice(0, page.from)
	const tail = src.slice(page.to)
	if (!tail) head = head.replace(/\n{2,}$/, '\n')
	let out = head + tail
	for (const l of links) out = setNodeProp(out, l.key, 'drill', null, l.page)
	return out
}
