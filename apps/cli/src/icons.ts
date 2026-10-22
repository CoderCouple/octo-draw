/**
 * Resolves DSL icon names for headless rendering: the core icon catalog first
 * (brand logos, aws-/gcp-/azure- names, generic glyphs — see docs/ICONS.md),
 * then any other lucide icon by name.
 */

import { iconCandidates, resolveIcon, type IconResolver, type IconNode } from '@octo-draw/core'

let table: Record<string, IconNode> | null = null

export async function loadIconResolver(): Promise<IconResolver> {
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
