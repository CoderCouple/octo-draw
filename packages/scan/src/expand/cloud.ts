/**
 * Cloud expander (`aws:` / `gcp:` / `azure:` src refs): loads the same
 * inventory the scan used (the document's `source` directive: an export
 * file or a live read-only collection; or an inline `options.export`) once
 * per run (`ctx.cache`), then draws one resource's page with
 * `expandCloudResource`.
 */

import { ConnectorError, type SourceRef } from '../connectors/types'
import { loadCloudGraph, parseAwsInput, parseAzureInput, parseGcpInput, type CloudClientFactories, type LoadedCloudGraph } from '../connectors/cloud/connectors'
import type { CloudProvider } from '../connectors/cloud/model'
import { expandCloudResource } from '../connectors/cloud/expand'
import type { Expander, ExpanderRequest } from './types'

export { expandCloudResource, type CloudExpandOptions } from '../connectors/cloud/expand'

const PROVIDERS: readonly string[] = ['aws', 'gcp', 'azure']

/** The inventory source for a request: inline export first, then the document's `source` directive. */
function inventoryRef(req: ExpanderRequest, provider: CloudProvider): SourceRef {
	const o = req.options ?? {}
	const guard = o.allowFiles === false ? { allowFiles: false } : {}
	if (o.export !== undefined) return { kind: provider, id: 'export', options: { export: o.export, detect: true } }
	const ref = req.source && PROVIDERS.includes(req.source.kind) ? req.source : req.sourceInput ? (parseAwsInput(req.sourceInput) ?? parseGcpInput(req.sourceInput) ?? parseAzureInput(req.sourceInput)) : null
	if (!ref) throw new ConnectorError(`no cloud inventory to expand ${req.src.raw}: the document has no ${provider}: source directive (or pass the export as options.export)`, 400)
	return { ...ref, options: { ...ref.options, ...guard } }
}

export function createCloudExpander(f: CloudClientFactories = {}): Expander {
	return async (req, ctx) => {
		const provider = req.src.kind as CloudProvider
		if (!PROVIDERS.includes(provider)) throw new ConnectorError(`not a cloud src: ${req.src.raw}`, 400)
		const ref = inventoryRef(req, provider)
		const kind = (PROVIDERS.includes(ref.kind) ? ref.kind : provider) as CloudProvider
		const key = `cloud:${ref.options?.export !== undefined ? `export:${typeof ref.options.export === 'string' ? ref.options.export.length : 'obj'}:${req.sourceInput}` : req.sourceInput || `${ref.kind}:${ref.id}`}`
		let pending = ctx.cache?.get(key) as Promise<LoadedCloudGraph> | undefined
		if (!pending) {
			pending = loadCloudGraph(kind, ref, ctx, f)
			ctx.cache?.set(key, pending)
			pending.catch(() => ctx.cache?.delete(key))
		}
		const loaded = await pending
		const page = expandCloudResource(loaded.graph, req.src.path, { maxNodes: req.maxNodes })
		if (!page) throw new ConnectorError(`${req.src.path} is not in the ${loaded.label} inventory`, 404)
		return page
	}
}

export const cloudExpander: Expander = createCloudExpander()
