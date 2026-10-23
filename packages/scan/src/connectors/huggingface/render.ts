/** Shared by the connector and the expander: collect + render one repo / collection. */

import { createClient, type HfClient, type HfOptions } from './client'
import { collectCollection, renderCollection } from './collection'
import { collectDataset, renderDataset } from './dataset'
import type { Page } from './graph'
import { collectModel, renderModel } from './model'
import type { HfRepoType } from './parse'
import { collectSpace, renderSpace } from './space'

export interface HfScanOptions extends HfOptions {
	type?: HfRepoType
	/** Levels below the root to pre-generate (default 1). */
	depth?: number
}

/** `hf:org/name[@rev]` / `hf:datasets/org/name` ... (the `source` directive and `src` prefix). */
export function sourceOf(type: HfRepoType, id: string, rev?: string): string {
	const prefix = type === 'dataset' ? 'datasets/' : type === 'space' ? 'spaces/' : type === 'collection' ? 'collections/' : ''
	return `hf:${prefix}${id}${rev && rev !== 'main' ? `@${rev}` : ''}`
}

export interface Rendered {
	root: Page
	pages: Page[]
	header: string[]
	notes: string[]
	confidence: number
	warnings: string[]
	title: string
}

export async function render(hf: HfClient, type: HfRepoType, id: string, rev: string | undefined, o: HfScanOptions): Promise<Rendered> {
	const srcBase = sourceOf(type, id, rev)
	const depth = Math.max(1, o.depth ?? 1)
	if (type === 'model') {
		const f = await collectModel(hf, id, rev, o.lineageDepth ?? 3)
		const r = renderModel(f, srcBase, depth, hf.endpoint)
		return { ...r, warnings: f.warnings, title: f.meta.id }
	}
	if (type === 'dataset') {
		const f = await collectDataset(hf, id, rev, o.maxTrainedModels ?? 6)
		return { ...renderDataset(f, srcBase, hf.endpoint), warnings: f.warnings, title: `${f.meta.id} (dataset)` }
	}
	if (type === 'space') {
		const f = await collectSpace(hf, id, rev)
		return { ...renderSpace(f, srcBase, hf.endpoint), warnings: f.warnings, title: `${f.meta.id} (Space)` }
	}
	const c = await collectCollection(hf, id)
	return { ...renderCollection(c, id, srcBase, o.maxCollectionItems ?? 40, hf.endpoint), warnings: [], title: c.title ? `${c.title} (collection)` : id }
}
