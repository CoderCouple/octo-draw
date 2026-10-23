import { parseOctoPages } from './drillCore'

/**
 * One parse per code text: the pipeline, breadcrumbs, the outline and the
 * expand client all read the same memoized `parseOctoPages` result, so
 * navigating, collapsing or opening the outline never re-parses.
 */

type Parsed = ReturnType<typeof parseOctoPages>

let lastSrc: string | null = null
let lastParsed: Parsed | null = null

export function parsedDoc(src: string): Parsed {
	if (src !== lastSrc || !lastParsed) {
		lastParsed = parseOctoPages(src)
		lastSrc = src
	}
	return lastParsed
}

/** The parsed page (exact name, then case-insensitive), or null. */
export function parsedPage(src: string, name: string) {
	const { pages } = parsedDoc(src)
	return pages.find((p) => p.name === name) ?? pages.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
}

/** A node's label on a page (falls back to the key). */
export function nodeLabel(src: string, page: string, key: string): string {
	const n = parsedPage(src, page)?.ir.nodes.find((x) => x.key === key)
	return n?.label ?? key
}
