/**
 * Hugging Face connector: models, datasets, Spaces and collections → octo
 * diagrams through the public Hub API (`ctx.fetch`; `HF_TOKEN` from
 * `ctx.env` for gated/private repos, never returned).
 *
 * Output: root page + one level (Architecture / Pipeline / Config / App code /
 * item-type pages). Every node carries `src: "hf:<id>#<path>"` and the root
 * page a `source hf:<id>` directive, so deeper levels (block → sublayer →
 * projections) come from `expandHuggingface` on demand; `options.depth > 1`
 * pre-generates them with the same code.
 */


import { ConnectorError, type Connector, type ConnectorContext, type ConnectorFinding, type ConnectorResult, type SourceRef } from '../types'
import { createClient } from './client'
import { emitDocument } from './graph'
import { parseHuggingface, type HfRepoType } from './parse'
import { render, sourceOf, type HfScanOptions } from './render'

export { parseHuggingface, hfUrl, type HfRef, type HfRepoType } from './parse'
export { analyzeConfig, specSummary, type ArchSpec, type StackSpec } from './config'
export { estimateParams } from './params'
export { analyzeModelIndex } from './diffusers'
export { analyzeApp, parseRequirements } from './space'
export { parseFrontMatter, baseModels } from './card'
export { sourceOf, type HfScanOptions } from './render'
export { expandHuggingface, huggingfaceExpander, resolveSrc, type HfExpandInput, type HfExpandResult } from './expand'

export async function scanHuggingface(ref: SourceRef, ctx: ConnectorContext): Promise<ConnectorResult> {
	const o = (ref.options ?? {}) as HfScanOptions
	const type: HfRepoType = o.type ?? 'model'
	const id = ref.id
	if (!id) throw new ConnectorError('Hugging Face: missing repo id (expected org/name)')
	const hf = createClient(ctx, o)
	ctx.log?.(`huggingface: ${type} ${id}${ref.ref ? `@${ref.ref}` : ''}`)
	const r = await render(hf, type, id, ref.ref, o)
	const source = sourceOf(type, id, ref.ref)
	const code = emitDocument(o.title ?? r.title, r.root, r.pages, r.header, source)
	const findings: ConnectorFinding[] = [{ analyzer: 'huggingface', confidence: r.confidence, notes: r.notes }]
	const options: Record<string, unknown> = { type }
	return { code, findings, warnings: r.warnings, source: { kind: 'huggingface', id, ...(ref.ref ? { ref: ref.ref } : {}), options } }
}

export const huggingfaceConnector: Connector = {
	kind: 'huggingface',
	parse: parseHuggingface,
	scan: scanHuggingface,
}

