/**
 * Resolves DSL icon names for headless rendering: official AWS / Google Cloud /
 * Azure icons from the local cache (`pnpm icons:fetch`, read directly from
 * disk), then the core icon catalog (brand logos, generic badges for vendor
 * names, glyphs — see docs/ICONS.md), then any other lucide icon by name.
 */

import { clearIconPacks, iconCandidates, registerIconPack, resolveIcon, type IconResolver, type IconNode } from '@octo-draw/core'
import { defaultIconsDir, iconPacksFromCache } from '@octo-draw/core/node/iconCache'

let table: Record<string, IconNode> | null = null
let packsDir: string | null = null

/** Register the official icon packs found in `dir` (default: $OCTO_ICONS_DIR or ~/.cache/octo-draw/icons). Returns how many packs loaded. */
export function loadOfficialIcons(dir = defaultIconsDir()): number {
	if (packsDir === dir) return -1
	clearIconPacks()
	const packs = iconPacksFromCache(dir)
	for (const p of packs) registerIconPack(p)
	packsDir = dir
	return packs.length
}

export async function loadIconResolver(opts: { iconsDir?: string } = {}): Promise<IconResolver> {
	loadOfficialIcons(opts.iconsDir)
	if (!table) {
		try {
			table = (await import('lucide/dist/esm/iconsAndAliases.mjs')) as unknown as Record<string, IconNode>
		} catch {
			table = {}
		}
	}
	const t = table
	return (name) => {
		const hit = resolveIcon(name)
		if (hit) return hit
		for (const c of iconCandidates(name)) if (t[c]) return t[c]
		return null
	}
}
