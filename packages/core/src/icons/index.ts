/**
 * Icon catalog for architecture diagrams: Eraser-compatible names (`aws-ec2`,
 * `gcp-pubsub`, `azure-functions`, `kafka`, `postgres`, `react`, …) resolved to
 * vendored vector data. Zero runtime dependencies; see docs/ICONS.md.
 */

import { CATALOG, type CatalogEntry, type IconVendor } from './catalog'
import { BRANDS } from './data/brands'
import { GLYPHS } from './data/glyphs'
import { ICON_ALIASES } from '../render/iconAliases'

export { CATALOG, type CatalogEntry, type IconVendor } from './catalog'

export type IconElement = [tag: string, attrs: Record<string, string | number>]

export interface ResolvedIcon {
	/** Canonical catalog name (aliases resolve to it). */
	name: string
	label: string
	viewBox: string
	/** SVG child elements, drawn inside `viewBox`. */
	nodes: IconElement[]
	/** `fill`: solid shapes (brand logos); `stroke`: 2px outline glyphs (lucide). */
	paint: 'fill' | 'stroke'
	/** True when the icon has no brand color — it always uses the theme foreground. */
	monochrome: boolean
	/** Brand color ('#rrggbb'), used only when the node says `color: brand`. */
	brandColor?: string
	/** Short text drawn on a pill over the glyph's lower-right corner (vendor services, brand fallbacks). */
	badge?: string
	vendor?: IconVendor
	source: 'simple-icons' | 'lucide'
}

const VIEWBOX = '0 0 24 24'
const norm = (s: string) =>
	s
		.trim()
		.toLowerCase()
		.replace(/[\s_.]+/g, '-')
		.replace(/-+/g, '-')

const index = new Map<string, CatalogEntry>()
for (const e of CATALOG) index.set(e.name, e)
for (const e of CATALOG) for (const a of e.aliases ?? []) if (!index.has(a)) index.set(a, e)

/** Canonical icon names in the catalog, sorted. */
export const ICON_NAMES: readonly string[] = CATALOG.map((e) => e.name).sort()
/** Every accepted name (canonical + aliases), sorted. */
export const ICON_ALL_NAMES: readonly string[] = [...index.keys()].sort()

const cache = new Map<string, ResolvedIcon>()

function build(e: CatalogEntry): ResolvedIcon {
	const hit = cache.get(e.name)
	if (hit) return hit
	const b = e.slug ? BRANDS[e.slug] : undefined
	const icon: ResolvedIcon = b
		? { name: e.name, label: e.label, viewBox: VIEWBOX, nodes: [['path', { d: b.path }]], paint: 'fill', monochrome: false, brandColor: `#${b.hex}`, vendor: e.vendor, source: 'simple-icons' }
		: {
				name: e.name,
				label: e.label,
				viewBox: VIEWBOX,
				nodes: GLYPHS[e.glyph] ?? [],
				paint: 'stroke',
				monochrome: true,
				// a brand drawn as its generic fallback keeps a name badge so it stays recognisable
				badge: e.badge ?? (e.slug ? e.label.replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase() : undefined),
				vendor: e.vendor,
				source: 'lucide',
			}
	cache.set(e.name, icon)
	return icon
}

function glyphIcon(name: string, glyph: string): ResolvedIcon | null {
	const nodes = GLYPHS[glyph]
	if (!nodes) return null
	return { name, label: name, viewBox: VIEWBOX, nodes, paint: 'stroke', monochrome: true, source: 'lucide' }
}

/**
 * Resolve a DSL icon name (`icon: aws-ec2`) to vector data, or null when the
 * name is unknown (renderers then draw a text badge). Case/space-insensitive;
 * accepts aliases (`postgresql` → `postgres`, `k8s` → `kubernetes`).
 */
export function resolveIcon(name: string | undefined | null): ResolvedIcon | null {
	if (!name) return null
	const n = norm(name)
	if (!n) return null
	const e = index.get(n)
	if (e) return build(e)
	if (GLYPHS[n]) return glyphIcon(n, n)
	const alias = ICON_ALIASES[n]
	if (alias) {
		const viaCatalog = index.get(alias)
		return viaCatalog ? build(viaCatalog) : glyphIcon(n, alias)
	}
	// unknown vendor service (`aws-foo`): fall back to the bare name (`foo`)
	const bare = n.match(/^(?:aws|gcp|azure)-(.+)$/)?.[1]
	return bare ? resolveIcon(bare) : null
}

export interface IconSearchHit {
	name: string
	label: string
	/** The alias that matched, when it wasn't the canonical name. */
	matched?: string
	score: number
}

/**
 * Ranked search over names, aliases, labels and tags — for autocomplete and
 * pickers. Exact name > exact alias > name prefix > alias prefix > label word
 * prefix > substring > tag. Ties: shorter names first, then alphabetical.
 */
export function searchIcons(query: string, limit = 20): IconSearchHit[] {
	const q = norm(query)
	if (!q) return CATALOG.slice(0, limit).map((e) => ({ name: e.name, label: e.label, score: 0 }))
	const qWords = q.split('-').filter(Boolean)
	const hits: IconSearchHit[] = []
	for (const e of CATALOG) {
		let score = 0
		let matched: string | undefined
		const consider = (s: number, m?: string) => {
			if (s > score) {
				score = s
				matched = m
			}
		}
		if (e.name === q) consider(100)
		else if (e.name.startsWith(q)) consider(70)
		else if (e.name.includes(q)) consider(40)
		for (const a of e.aliases ?? []) {
			if (a === q) consider(90, a)
			else if (a.startsWith(q)) consider(60, a)
			else if (a.includes(q)) consider(30, a)
		}
		const label = norm(e.label)
		const words = label.split('-')
		if (label === q) consider(88)
		else if (qWords.every((w) => words.some((x) => x.startsWith(w)))) consider(qWords.length > 1 ? 55 : 50)
		else if (label.includes(q)) consider(35)
		if (score === 0 && qWords.every((w) => (e.tags ?? []).some((t) => t.startsWith(w)) || e.vendor === w)) consider(20)
		// vendor-prefixed queries ("aws lam") also match the service part of the name
		if (score === 0 && e.vendor && qWords[0] === e.vendor && qWords.length > 1) {
			const rest = qWords.slice(1).join('-')
			if (e.name.slice(e.vendor.length + 1).startsWith(rest)) consider(65)
		}
		if (score > 0) hits.push({ name: e.name, label: e.label, matched, score })
	}
	hits.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
	return hits.slice(0, limit)
}

export interface IconSvgOptions {
	/** Pixel size of the square icon. Default 24. */
	size?: number
	/** Foreground color. Default 'currentColor'. */
	color?: string
	/** Use the brand color when the icon has one (DSL `color: brand`). */
	brand?: boolean
	/** Background behind the badge pill. Default '#ffffff'. */
	background?: string
	/** Extra attributes on the outer <svg>, e.g. { x, y } when nesting. */
	attrs?: Record<string, string | number>
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const attrStr = (a: Record<string, string | number | undefined>) =>
	Object.entries(a)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => ` ${k}="${esc(String(v))}"`)
		.join('')

/** Badge pill geometry in the icon's 24×24 coordinates (shared by every renderer). */
export function badgeBox(text: string) {
	const fontSize = text.length > 4 ? 6.5 : 7.5
	const h = 10
	const w = Math.max(h, text.length * fontSize * 0.62 + 5)
	return { x: 26 - w, y: 16, w, h, rx: h / 2, fontSize, textX: 26 - w / 2, textY: 16 + h / 2 }
}

/** SVG child markup for an icon (no outer <svg>): paths plus the badge pill, if any. */
export function iconInnerSvg(icon: ResolvedIcon, color: string, background = '#ffffff'): string {
	const body = icon.nodes.map(([tag, a]) => `<${tag}${attrStr(a)}/>`).join('')
	if (!icon.badge) return body
	const b = badgeBox(icon.badge)
	return (
		body +
		`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.rx}" fill="${esc(background)}" stroke="${esc(color)}" stroke-width="1.2"/>` +
		`<text x="${b.textX}" y="${b.textY}" text-anchor="middle" dominant-baseline="central" font-size="${b.fontSize}" font-weight="700" font-family="ui-sans-serif, system-ui, sans-serif" fill="${esc(color)}" stroke="none">${esc(icon.badge)}</text>`
	)
}

/** Paint attributes for the icon's <svg>/<g> wrapper. */
export function iconPaint(icon: ResolvedIcon, color: string): Record<string, string | number> {
	return icon.paint === 'fill'
		? { fill: color, stroke: 'none' }
		: { fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
}

/** The color an icon should be drawn in: theme foreground unless `brand` is asked for and the brand color is legible on `background`. */
export function iconColor(icon: ResolvedIcon, foreground: string, opts: { brand?: boolean; background?: string } = {}): string {
	if (!opts.brand || !icon.brandColor) return foreground
	if (opts.background && contrast(icon.brandColor, opts.background) < 1.6) return foreground
	return icon.brandColor
}

/** A standalone <svg> string for an icon (pickers, the web canvas, exports). */
export function iconSvg(icon: ResolvedIcon, opts: IconSvgOptions = {}): string {
	const size = opts.size ?? 24
	const color = iconColor(icon, opts.color ?? 'currentColor', { brand: opts.brand, background: opts.background })
	const a = { ...opts.attrs, width: size, height: size, viewBox: icon.viewBox, ...iconPaint(icon, color), overflow: 'visible', 'data-icon': icon.name }
	return `<svg xmlns="http://www.w3.org/2000/svg"${attrStr(a)}>${iconInnerSvg(icon, color, opts.background)}</svg>`
}

function lum(hex: string) {
	const h = hex.replace('#', '')
	if (!/^[0-9a-f]{6}$/i.test(h)) return null
	const [r, g, b] = [0, 2, 4].map((i) => {
		const c = parseInt(h.slice(i, i + 2), 16) / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string) {
	const la = lum(a)
	const lb = lum(b)
	if (la === null || lb === null) return 21
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
