/** Resolves DSL icon names to lucide vector icons for headless rendering. */

import { iconCandidates, type IconNode } from '@octo-draw/core'

let table: Record<string, IconNode> | null = null

export async function loadIconResolver(): Promise<(name: string) => IconNode | null> {
	if (!table) {
		try {
			table = (await import('lucide/dist/esm/iconsAndAliases.mjs')) as unknown as Record<string, IconNode>
		} catch {
			table = {}
		}
	}
	const t = table
	return (name) => {
		for (const c of iconCandidates(name)) if (t[c]) return t[c]
		return null
	}
}
