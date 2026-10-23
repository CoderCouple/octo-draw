/**
 * Node-only helpers for the local official-icon cache written by
 * `pnpm icons:fetch` (packages/core/scripts/fetch-cloud-icons.ts).
 *
 * Kept out of `src/` so @octo-draw/core stays platform-free; the server, the
 * CLI and the fetch script import it directly:
 *   import { iconPacksFromCache } from '@octo-draw/core/node/iconCache'
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { IconCacheManifest, IconPack, IconVendor } from '../src/icons/packs'

export const ICON_VENDORS: readonly IconVendor[] = ['aws', 'gcp', 'azure']

/** `$OCTO_ICONS_DIR`, else `$XDG_CACHE_HOME/octo-draw/icons`, else `~/.cache/octo-draw/icons`. */
export function defaultIconsDir(env: Record<string, string | undefined> = process.env): string {
	if (env.OCTO_ICONS_DIR) return resolve(env.OCTO_ICONS_DIR)
	const base = env.XDG_CACHE_HOME ? resolve(env.XDG_CACHE_HOME) : join(homedir(), '.cache')
	return join(base, 'octo-draw', 'icons')
}

export const manifestPath = (dir: string) => join(dir, 'manifest.json')

/** The cache manifest, or null when no pack has been downloaded (or it's unreadable). */
export function readIconCacheManifest(dir = defaultIconsDir()): IconCacheManifest | null {
	const p = manifestPath(dir)
	if (!existsSync(p)) return null
	try {
		const m = JSON.parse(readFileSync(p, 'utf8')) as IconCacheManifest
		return m && m.schema === 1 && m.packs && typeof m.packs === 'object' ? m : null
	} catch {
		return null
	}
}

/** Absolute path of a pack icon's SVG inside the cache, or null (unknown vendor/name, or a path escaping the cache). */
export function iconFilePath(dir: string, manifest: IconCacheManifest, vendor: string, name: string): string | null {
	const pack = manifest.packs[vendor as IconVendor]
	if (!pack) return null
	const canonical = pack.icons[name] ? name : pack.aliases?.[name]
	const icon = canonical ? pack.icons[canonical] : undefined
	if (!icon?.file) return null
	const root = resolve(dir)
	const p = resolve(root, pack.dir ?? '', icon.file)
	return p.startsWith(root + sep) && existsSync(p) ? p : null
}

/**
 * Icon packs backed by the cache, ready for `registerIconPack`. SVGs are read
 * synchronously on first use and kept in memory.
 */
export function iconPacksFromCache(dir = defaultIconsDir(), manifest = readIconCacheManifest(dir)): IconPack[] {
	if (!manifest) return []
	const out: IconPack[] = []
	for (const vendor of ICON_VENDORS) {
		const m = manifest.packs[vendor]
		if (!m || !m.icons) continue
		const cache = new Map<string, string>()
		out.push({
			...m,
			svg(name) {
				let text = cache.get(name)
				if (text !== undefined) return text
				const p = iconFilePath(dir, manifest, vendor, name)
				try {
					text = p ? readFileSync(p, 'utf8') : ''
				} catch {
					text = ''
				}
				cache.set(name, text)
				return text
			},
		})
	}
	return out
}
