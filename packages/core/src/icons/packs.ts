/**
 * Official cloud icon packs (AWS, Google Cloud, Azure) loaded at runtime.
 *
 * The vendors' terms don't allow redistributing their icon files in an
 * open-source repo, so nothing here ships icon data. `pnpm icons:fetch`
 * downloads the official packs into a local cache and writes a manifest; the
 * server/CLI (or the web app, via the server) register them with
 * `registerIconPack`, and `resolveIcon('aws-ec2')` then returns the official
 * full-color icon. Without a pack, the catalog's generic badge icons are used.
 *
 * Platform-free: no fs, no fetch. Callers pass a synchronous `svg(name)`
 * reader (fs on the server/CLI, an in-memory cache on the web).
 */

import type { IconVendor } from './catalog'

export type { IconVendor }

export type IconPackKind = 'service' | 'resource' | 'category' | 'group'

export interface IconPackIcon {
	/** Human label, e.g. "Amazon EC2". */
	label: string
	/** File name inside the pack's directory (`aws-ec2.svg`). */
	file?: string
	kind?: IconPackKind
	/** Vendor category ("Compute", "databases", …). */
	category?: string
	/** The original file name in the vendor's zip. */
	source?: string
}

/** One vendor's entry in the manifest written by `pnpm icons:fetch`. */
export interface IconPackManifest {
	vendor: IconVendor
	version: string
	label?: string
	/** Pack directory, relative to the manifest's root. */
	dir?: string
	terms?: string
	/** canonical name → icon */
	icons: Record<string, IconPackIcon>
	/** alias (Eraser-style or long vendor name) → canonical name */
	aliases?: Record<string, string>
}

/** The cache-root manifest (`~/.cache/octo-draw/icons/manifest.json`). */
export interface IconCacheManifest {
	schema: 1
	generatedAt?: string
	packs: Partial<Record<IconVendor, IconPackManifest>>
}

export interface IconPack extends IconPackManifest {
	/**
	 * Raw SVG markup for a canonical icon name, synchronously, or undefined when
	 * it isn't available (yet). Undefined makes `resolveIcon` fall back to the
	 * generic badge icon, so a lazy loader can fill in later.
	 */
	svg?: (name: string) => string | undefined
}

/** A parsed, sanitized vendor SVG ready to embed inside another <svg>. */
export interface VendorSvg {
	viewBox: string
	/** Child markup, ids and CSS classes prefixed so several icons can share one document. */
	body: string
}

const packs = new Map<IconVendor, IconPack>()
let generation = 0
const listeners = new Set<() => void>()

/** Register (or replace) a vendor's icon pack. `resolveIcon` prefers it over the generic badge icons. */
export function registerIconPack(pack: IconPack): void {
	packs.set(pack.vendor, pack)
	changed()
}

export function unregisterIconPack(vendor: IconVendor): void {
	if (packs.delete(vendor)) changed()
}

export function clearIconPacks(): void {
	if (packs.size) {
		packs.clear()
		changed()
	}
}

/** Currently registered packs (vendor, version, icon count). */
export function listIconPacks(): { vendor: IconVendor; version: string; label?: string; count: number }[] {
	return [...packs.values()].map((p) => ({ vendor: p.vendor, version: p.version, label: p.label, count: Object.keys(p.icons).length }))
}

/** @internal */
export function allIconPacks(): IconPack[] {
	return [...packs.values()]
}

/** Every canonical name in the registered packs, sorted. */
export function iconPackNames(): string[] {
	return [...packs.values()].flatMap((p) => Object.keys(p.icons)).sort()
}

/** Bumps whenever packs change or a lazy pack loads an icon — use as a React re-render key. */
export function iconPackGeneration(): number {
	return generation
}

/** Subscribe to pack changes (registration, lazy loads). Returns an unsubscribe function. */
export function onIconPacksChange(fn: () => void): () => void {
	listeners.add(fn)
	return () => listeners.delete(fn)
}

/** @internal resolveIcon's cache invalidation hook. */
export const packHooks = { onChange: () => {} }

function changed() {
	generation++
	packHooks.onChange()
	for (const fn of listeners) fn()
}

/** Find a pack icon by normalized name or alias. */
export function lookupPackIcon(n: string): { pack: IconPack; name: string; icon: IconPackIcon } | null {
	if (!packs.size) return null
	const vendor = n.split('-', 1)[0] as IconVendor
	const order = packs.has(vendor) ? [packs.get(vendor)!] : [...packs.values()]
	for (const pack of order) {
		const name = pack.icons[n] ? n : pack.aliases?.[n]
		if (name && pack.icons[name]) return { pack, name, icon: pack.icons[name] }
	}
	return null
}

/**
 * A pack whose SVGs are fetched on demand and cached (for the browser). The
 * first `svg(name)` call returns undefined and starts `fetchSvg`; when it
 * resolves, listeners (`onIconPacksChange`) fire so the UI re-renders and the
 * next call returns the markup.
 */
export function lazyIconPack(manifest: IconPackManifest, fetchSvg: (name: string, icon: IconPackIcon) => Promise<string>): IconPack {
	const loaded = new Map<string, string>()
	const pending = new Set<string>()
	return {
		...manifest,
		svg(name) {
			const hit = loaded.get(name)
			if (hit !== undefined || pending.has(name)) return hit
			const icon = manifest.icons[name]
			if (!icon) return undefined
			pending.add(name)
			fetchSvg(name, icon)
				.then((text) => {
					loaded.set(name, text)
					changed()
				})
				.catch(() => loaded.set(name, ''))
				.finally(() => pending.delete(name))
			return undefined
		},
	}
}

// ---------------------------------------------------------------------------
// SVG sanitizing

const ROOT = /<svg\b([^>]*)>([\s\S]*)<\/svg>/i

function attr(attrs: string, name: string): string | undefined {
	return new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(attrs)?.slice(2).find((v) => v !== undefined)
}

/**
 * Parse vendor SVG markup into an embeddable body: drops scripts, event
 * handlers, external references, comments and titles; prefixes ids and CSS
 * classes with `prefix` so icons don't clash with each other (Google's icons
 * all use `.cls-1`, Azure's use gradient ids). Returns null if it isn't an SVG.
 */
export function parseVendorSvg(markup: string, prefix: string): VendorSvg | null {
	const m = ROOT.exec(markup)
	if (!m) return null
	const rootAttrs = m[1]
	let viewBox = attr(rootAttrs, 'viewBox')
	if (!viewBox) {
		const w = parseFloat(attr(rootAttrs, 'width') ?? '')
		const h = parseFloat(attr(rootAttrs, 'height') ?? '')
		if (!(w > 0 && h > 0)) return null
		viewBox = `0 0 ${w} ${h}`
	}
	const p = prefix.replace(/[^A-Za-z0-9_-]/g, '-')
	let body = m[2]
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<\?[\s\S]*?\?>/g, '')
		.replace(/<!DOCTYPE[^>]*>/gi, '')
		.replace(/<(script|foreignObject|title|desc|metadata)\b[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<(script|foreignObject|title|desc|metadata)\b[^>]*\/>/gi, '')
		.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
		// external references (keep in-document #refs and embedded raster data)
		.replace(/\s(xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (all, _x, _q, a, b) => {
			const v = (a ?? b ?? '').trim()
			return v.startsWith('#') || /^data:image\/(png|jpe?g|gif|webp);/i.test(v) ? all : ''
		})
		.replace(/javascript:/gi, '')

	// ids: keep only referenced ones, prefixed
	const refs = new Set<string>()
	for (const r of body.matchAll(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g)) refs.add(r[1])
	for (const r of body.matchAll(/href\s*=\s*["']#([^"']+)["']/g)) refs.add(r[1])
	body = body.replace(/\sid\s*=\s*("([^"]*)"|'([^']*)')/g, (_all, _q, a, b) => {
		const id = a ?? b
		return refs.has(id) ? ` id="${p}${id}"` : ''
	})
	body = body
		.replace(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g, (_all, id) => `url(#${p}${id})`)
		.replace(/(href\s*=\s*["'])#([^"']+)(["'])/g, (_all, a, id, c) => `${a}#${p}${id}${c}`)

	// classes: prefix selectors in <style> and class attributes
	body = body.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_all, open, css: string, close) => {
		const scoped = css
			.replace(/@import[^;]*;?/gi, '')
			.replace(/expression\s*\(/gi, '(')
			.replace(/\.(-?[A-Za-z_][\w-]*)(?=[^{}]*\{)/g, (_m, c) => `.${p}${c}`)
		return open + scoped + close
	})
	body = body.replace(/\sclass\s*=\s*("([^"]*)"|'([^']*)')/g, (_all, _q, a, b) => {
		const list = String(a ?? b)
			.split(/\s+/)
			.filter(Boolean)
			.map((c) => p + c)
		return list.length ? ` class="${list.join(' ')}"` : ''
	})

	body = body.replace(/>\s+</g, '><').trim()
	return { viewBox, body }
}
