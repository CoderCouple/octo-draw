/**
 * Pre-generates deeper drill levels with the same functions the expander
 * uses: every node whose `src` is structural gets a page named
 * `<parent page> / <node key>` (root children: just the key) and a `drill:`.
 */

import type { Page } from './graph'

export type PageExpander = (src: string, name: string) => Page | null

/** Mutates `start` (adds drills) and appends new pages to `out`. `levels` = how many levels below `start`. */
export function deepen(start: Page, levels: number, expand: PageExpander, structural: (src: string) => boolean, out: Page[], seen = new Map<string, string>()): void {
	if (levels <= 0) return
	for (const n of start.nodes) {
		if (!n.src || n.drill || !structural(n.src)) continue
		const known = seen.get(n.src)
		if (known !== undefined) {
			if (known !== start.name) n.drill = known
			continue
		}
		const name = start.name ? `${start.name} / ${n.key}` : n.key
		if (out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue
		const page = expand(n.src, name)
		if (!page || !page.nodes.length) continue
		seen.set(n.src, page.name)
		n.drill = page.name
		out.push(page)
		deepen(page, levels - 1, expand, structural, out, seen)
	}
}
