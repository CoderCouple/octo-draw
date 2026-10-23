import { create } from 'zustand'
import type { IconCacheManifest, IconSearchHit, ResolvedIcon } from '@octo-draw/core'

export type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][]
type Catalog = typeof import('@octo-draw/core/src/icons')

/**
 * Diagram icons, resolved in two lazy layers (each its own chunk):
 * 1. core's icon catalog: brand logos, vendored lucide glyphs, aws/gcp/azure badges.
 * 2. the full lucide set, only for names the catalog doesn't know.
 *
 * Official AWS/GCP/Azure packs (downloaded locally with `pnpm icons:fetch`)
 * come from the server: the manifest loads with the catalog, each SVG is
 * fetched the first time it's resolved, and `version` bumps when it arrives.
 */
export type WebIcon = { kind: 'catalog'; icon: ResolvedIcon } | { kind: 'lucide'; nodes: IconNode }

const toPascal = (kebab: string) =>
	kebab
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((p) => p[0].toUpperCase() + p.slice(1))
		.join('')

const toKebab = (pascal: string) =>
	pascal
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/([A-Za-z])([0-9])/g, '$1-$2')
		.toLowerCase()

let catalog: Catalog | null = null
let lucideTable: Record<string, IconNode> | null = null
let lucideNames: string[] = []

interface IconState {
	/** Catalog loaded. */
	loaded: boolean
	/** Bumps whenever a set finishes loading, so memoized views re-render. */
	version: number
}
export const useIcons = create<IconState>(() => ({ loaded: false, version: 0 }))
const bump = () => useIcons.setState((s) => ({ loaded: !!catalog, version: s.version + 1 }))

let loadingCatalog: Promise<void> | null = null
/** Loads the icon catalog (its own chunk). Safe to call repeatedly. */
export function loadIcons(): Promise<void> {
	if (!loadingCatalog) {
		loadingCatalog = import('@octo-draw/core/src/icons')
			.then((m) => {
				catalog = m
				m.onIconPacksChange(bump)
				bump()
				void loadIconPacks(m)
			})
			.catch((err) => {
				// allow a retry on the next call instead of silently showing badges forever
				console.warn('icon catalog failed to load', err)
				loadingCatalog = null
			})
	}
	return loadingCatalog
}

/** Registers the server's official vendor packs; no server or no packs means badges stay. */
async function loadIconPacks(m: Catalog): Promise<void> {
	try {
		const res = await fetch('/api/icons/manifest')
		if (!res.ok) return
		const manifest = (await res.json()) as IconCacheManifest
		for (const pack of Object.values(manifest.packs ?? {})) {
			if (!pack) continue
			m.registerIconPack(
				m.lazyIconPack(pack, async (name) => {
					const r = await fetch(`/api/icons/${pack.vendor}/${encodeURIComponent(name)}.svg`)
					if (!r.ok) throw new Error(String(r.status))
					return r.text()
				}),
			)
		}
	} catch {
		// offline or no server: keep the badge fallbacks
	}
}

let loadingLucide: Promise<void> | null = null
/** Loads the full lucide set — the fallback for names outside the catalog. */
export function loadLucide(): Promise<void> {
	if (!loadingLucide) {
		loadingLucide = import('lucide/dist/esm/iconsAndAliases.mjs')
			.then((m) => {
				lucideTable = m as unknown as Record<string, IconNode>
				const names = new Set<string>()
				for (const k of Object.keys(lucideTable)) if (!k.endsWith('Icon') && !k.startsWith('Lucide')) names.add(toKebab(k))
				lucideNames = [...names].sort()
				bump()
			})
			.catch((err) => {
				console.warn('lucide icon set failed to load', err)
				loadingLucide = null
			})
	}
	return loadingLucide
}

/** The loaded catalog module (iconColor, iconPaint, badgeBox, …), or null before it loads. */
export function iconCatalog(): Catalog | null {
	return catalog
}

function lucideLookup(name: string): IconNode | null {
	const n = name.trim().toLowerCase()
	const bare = n.replace(/^(aws|gcp|azure)-/, '')
	for (const c of [n, bare]) {
		const hit = lucideTable?.[toPascal(c)]
		if (hit) return hit
	}
	return null
}

/** Icon for a DSL name, or null when unknown (render a text badge). */
export function getIcon(name: string | undefined): WebIcon | null {
	if (!name || !catalog) return null
	const icon = catalog.resolveIcon(name)
	if (icon) return { kind: 'catalog', icon }
	if (!lucideTable) {
		void loadLucide()
		return null
	}
	const nodes = lucideLookup(name)
	return nodes ? { kind: 'lucide', nodes } : null
}

/** Ranked icon suggestions: catalog search first, then lucide names with the same prefix. */
export function searchIconNames(query: string, limit = 50): IconSearchHit[] {
	if (!catalog) return []
	const hits = catalog.searchIcons(query, limit)
	if (hits.length >= limit || !lucideTable) return hits
	const q = query.trim().toLowerCase()
	if (!q) return hits
	const seen = new Set(hits.map((h) => h.name))
	for (const n of lucideNames) {
		if (hits.length >= limit) break
		if (n.startsWith(q) && !seen.has(n) && !catalog.resolveIcon(n)) hits.push({ name: n, label: 'lucide', score: 1 })
	}
	return hits
}

/** A standalone `<svg>` string for previews outside React (editor completions and tooltips). */
export function iconSvgString(name: string, size: number, color = 'currentColor'): string | null {
	const hit = getIcon(name)
	if (!hit) return null
	if (hit.kind === 'catalog') {
		const background = (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue('--popover').trim()) || '#ffffff'
		return catalog!.iconSvg(hit.icon, { size, color, background })
	}
	const body = hit.nodes.map(([tag, a]) => `<${tag}${Object.entries(a).map(([k, v]) => (v === undefined ? '' : ` ${k}="${String(v)}"`)).join('')}/>`).join('')
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
}
