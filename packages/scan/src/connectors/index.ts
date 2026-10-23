/**
 * Connector registry. Connectors are tried in registration order; the first
 * whose `parse` accepts the input wins. Pure (no node imports): the local
 * folder connector is registered by `@octo-draw/scan/node`.
 */

import { ConnectorError, type Connector, type ConnectorContext, type ConnectorResult, type SourceKind, type SourceRef } from './types'
import { githubConnector } from './github'
import { cloudConnectors } from './cloud'
import { huggingfaceConnector } from './huggingface'

export * from './types'

const registry: Connector[] = []

/** Adds (or replaces, by kind) a connector. Returns an unregister function. */
export function registerConnector(c: Connector): () => void {
	const i = registry.findIndex((x) => x.kind === c.kind)
	if (i >= 0) registry[i] = c
	else registry.push(c)
	return () => {
		const j = registry.indexOf(c)
		if (j >= 0) registry.splice(j, 1)
	}
}

export function listConnectors(): readonly Connector[] {
	return registry
}

export function getConnector(kind: SourceKind): Connector | undefined {
	return registry.find((c) => c.kind === kind)
}

/** Explicit `kind:` prefixes (`github:o/r`, `local:/x`) go straight to that connector. */
export function resolveSource(input: string): { connector: Connector; ref: SourceRef } | null {
	const text = input.trim()
	if (!text) return null
	// non-local connectors first: a local path like `owner/repo` would otherwise be ambiguous
	const ordered = [...registry.filter((c) => c.kind !== 'local'), ...registry.filter((c) => c.kind === 'local')]
	for (const connector of ordered) {
		const ref = connector.parse(text)
		if (ref) return { connector, ref }
	}
	return null
}

export async function scanAny(input: string | SourceRef, ctx: ConnectorContext): Promise<ConnectorResult> {
	if (typeof input !== 'string') {
		const c = getConnector(input.kind)
		if (!c) throw new ConnectorError(`no connector registered for "${input.kind}"`)
		return c.scan(input, ctx)
	}
	const hit = resolveSource(input)
	if (!hit) throw new ConnectorError(`not a recognised source: "${input}" (try a folder path, github.com/owner/repo, hf:org/model or aws:region)`)
	return hit.connector.scan(hit.ref, ctx)
}

registerConnector(githubConnector)
for (const c of cloudConnectors) registerConnector(c)
registerConnector(huggingfaceConnector)
