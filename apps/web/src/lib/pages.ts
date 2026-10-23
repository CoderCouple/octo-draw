import type { Point } from '@octo-draw/core'
import { shortPageLabel } from './outline'

/**
 * Pure helpers for drill-down view state: per-page pin keys and the
 * breadcrumb stack. No store access, so they are unit-tested directly.
 */

/** Root pins keep their plain key (backward compatible); other pages use `<page>/<key>`. */
export function pinKey(page: string, key: string): string {
	return page ? `${page}/${key}` : key
}

/** Which page a stored pin key belongs to, given the document's page names. */
function pageOfPin(stored: string, pages: Set<string>): { page: string; key: string } {
	// longest page-name prefix wins, so "a/b" page beats "a" page
	let best = ''
	for (const p of pages) if (p && p.length > best.length && stored.startsWith(p + '/')) best = p
	return best ? { page: best, key: stored.slice(best.length + 1) } : { page: '', key: stored }
}

/**
 * The pins of one page, keyed by plain node key. `pageNames` lets root keys that
 * contain a slash (e.g. `main/vpc`) stay on the root page.
 */
export function pagePins(pins: Record<string, Point>, page: string, pageNames: Iterable<string> = [page]): Record<string, Point> {
	const names = new Set(pageNames)
	if (page) names.add(page)
	const out: Record<string, Point> = {}
	for (const [stored, p] of Object.entries(pins)) {
		const hit = pageOfPin(stored, names)
		if (hit.page === page) out[hit.key] = p
	}
	return out
}

/** Replaces one page's pins with `local` (plain keys), leaving other pages untouched. */
export function withPagePins(pins: Record<string, Point>, page: string, local: Record<string, Point>, pageNames: Iterable<string> = [page]): Record<string, Point> {
	const names = new Set(pageNames)
	if (page) names.add(page)
	const out: Record<string, Point> = {}
	for (const [stored, p] of Object.entries(pins)) if (pageOfPin(stored, names).page !== page) out[stored] = p
	for (const [k, p] of Object.entries(local)) out[pinKey(page, k)] = p
	return out
}

// ---------------------------------------------------------------------------
// breadcrumbs

/** One level of the drill path: a page, optionally focused on one of its groups. */
export interface Crumb {
	page: string
	focus?: string
	/** node key on the parent level we drilled through (camera animates back to it) */
	via?: string
}

export const ROOT_CRUMB: Crumb = { page: '' }

export const sameCrumb = (a: Crumb, b: Crumb) => a.page === b.page && (a.focus ?? '') === (b.focus ?? '')

/** Drills into `page` (from node `via`). Re-entering a page already on the path truncates back to it. */
export function drillInto(stack: Crumb[], page: string, via?: string): Crumb[] {
	const base = stack.length ? stack : [ROOT_CRUMB]
	const at = base.findIndex((c) => c.page === page && !c.focus)
	if (at >= 0) return base.slice(0, at + 1)
	return [...base, { page, via }]
}

/** Focuses a group on the current page. */
export function focusInto(stack: Crumb[], group: string): Crumb[] {
	const base = stack.length ? stack : [ROOT_CRUMB]
	const top = base[base.length - 1]
	const next: Crumb = { page: top.page, focus: group, via: group }
	const at = base.findIndex((c) => sameCrumb(c, next))
	if (at >= 0) return base.slice(0, at + 1)
	return [...base, next]
}

/** One level up; the root stays. */
export function goUp(stack: Crumb[]): Crumb[] {
	return stack.length > 1 ? stack.slice(0, -1) : [ROOT_CRUMB]
}

/** Back to crumb `index` (clicking a breadcrumb). */
export function goTo(stack: Crumb[], index: number): Crumb[] {
	if (index < 0) return [ROOT_CRUMB]
	return stack.slice(0, Math.min(index + 1, stack.length))
}

/**
 * Jumps to `page` without a drill (page tab, editor caret): keeps the path if
 * the page is already on it, otherwise starts a fresh `root › page` path.
 */
export function jumpTo(stack: Crumb[], page: string): Crumb[] {
	const at = stack.findIndex((c) => c.page === page && !c.focus)
	if (at >= 0) return stack.slice(0, at + 1)
	return page ? [ROOT_CRUMB, { page }] : [ROOT_CRUMB]
}

/** Drops levels whose page no longer exists (or whose focus group is gone). */
export function pruneStack(stack: Crumb[], pages: string[], groupsOf: (page: string) => string[] | null): Crumb[] {
	const out: Crumb[] = []
	for (const c of stack) {
		if (c.page && !pages.includes(c.page)) break
		if (c.focus && !(groupsOf(c.page) ?? []).includes(c.focus)) break
		out.push(c)
	}
	if (!out.length || out[0].page !== '' || out[0].focus) out.unshift(ROOT_CRUMB)
	return out
}

/** Display labels: the root shows the title, pages their name, a focus the group label. */
export function crumbLabels(stack: Crumb[], title: string, labelOf: (page: string, key: string) => string): string[] {
	return stack.map((c, i) => {
		if (c.focus) return labelOf(c.page, c.focus)
		if (!c.page) return title || 'Root'
		// path-style names (`a / b / c`) read as their last part under their parent page
		const parent = stack.slice(0, i).reverse().find((x) => x.page && x.page !== c.page)?.page
		return shortPageLabel(c.page, parent)
	})
}

/**
 * Deep link (outline, editor caret, agent hook): keeps the current path when
 * the page is already on it, otherwise rebuilds the trail from the page tree
 * (`pagePath`, root first), reusing the `via` nodes it reports.
 */
export function jumpToPath(stack: Crumb[], page: string, path: { page: string; via?: string }[]): Crumb[] {
	const at = stack.findIndex((c) => c.page === page && !c.focus)
	if (at >= 0) return stack.slice(0, at + 1)
	const out: Crumb[] = path.map((p) => (p.via !== undefined ? { page: p.page, via: p.via } : { page: p.page }))
	if (!out.length || out[0].page !== '') out.unshift(ROOT_CRUMB)
	if (out[out.length - 1].page !== page) out.push({ page })
	return out
}

/**
 * Which crumbs a trail of `count` levels shows: all of them up to `max`, else
 * the root, a "…" menu for the middle and the last two levels.
 */
export function truncateCrumbs(count: number, max = 4): { shown: (number | 'more')[]; hidden: number[] } {
	if (count <= max) return { shown: Array.from({ length: count }, (_, i) => i), hidden: [] }
	const hidden = Array.from({ length: count - 3 }, (_, i) => i + 1)
	return { shown: [0, 'more', count - 2, count - 1], hidden }
}
