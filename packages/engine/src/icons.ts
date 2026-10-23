import { normalizeFetchedIcon } from '@eraserlabs/diagram-templates/svg-transforms'
import { iconSvg, resolveIcon } from '@octo-draw/core'

/**
 * Eraser's resolver takes an injected `IconLoader = (name) => Promise<svg>`. This one answers from
 * octo's own catalog (`resolveIcon` / `iconSvg`: simple-icons brands, lucide glyphs, and any
 * registered official AWS/GCP/Azure pack served from `/api/icons`), never from Eraser's GCS bucket.
 *
 * Name grammar: `<octo icon name>` draws in `currentColor`; `<name>~brand` uses the brand color
 * (octo's `color: brand`). Unknown names reject, which resolve maps onto `onUnknownIcon`.
 */
export const BRAND_SUFFIX = '~brand'

export function octoIconName(icon: string, brand = false): string {
	return brand ? icon + BRAND_SUFFIX : icon
}

export function parseOctoIconName(name: string): { icon: string; brand: boolean } {
	return name.endsWith(BRAND_SUFFIX) ? { icon: name.slice(0, -BRAND_SUFFIX.length), brand: true } : { icon: name, brand: false }
}

export async function octoIconLoader(name: string): Promise<string> {
	const { icon, brand } = parseOctoIconName(name)
	const resolved = resolveIcon(icon)
	if (!resolved) throw new Error(`unknown icon "${icon}"`)
	// Pack icons may be lazy (fetched from /api/icons on first resolve): the catalog returns a
	// badge until the SVG arrives, which is acceptable for a spike (re-resolve on pack change).
	// Eraser's sanitizer is an allowlist: `data-*` attributes reject the whole icon.
	const svg = iconSvg(resolved, { size: 24, brand, color: 'currentColor' }).replace(/\s(data-[\w-]+)="[^"]*"/g, '')
	// Vendor pack SVGs use <style> class palettes and shared ids; Eraser's fetch-time normalizer
	// inlines the classes, prefixes ids and drops what its sanitizer would reject.
	return resolved.svg !== undefined ? normalizeFetchedIcon(svg, name.replace(/[^\w-]/g, '-')) : svg
}
