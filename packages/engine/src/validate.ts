import { createResolver, type IconLoader, type Resolver, type ValidationResult, type ResolveResult } from '@eraserlabs/resolve'
import { stockLibrary } from '@eraserlabs/diagram-templates'
import { stockNormalizers } from '@eraserlabs/diagram-templates/normalizers'
import { octoIconLoader } from './icons'
import type { MdpDoc } from './mdp'

/**
 * Validation goes through Eraser's own resolver. The "profile" is the `library` handed to
 * `createResolver` (stock = `stockLibrary` from `@eraserlabs/diagram-templates`: tag schemas,
 * templates, palette, default connection tag); `resolver.validate(doc)` runs the whole pipeline
 * minus icon loading, `resolver.resolve(doc)` also inlines icons through our loader.
 */
const resolvers = new WeakMap<IconLoader, Promise<Resolver>>()

/** One warm resolver per icon loader (boot compiles the library's schemas once). */
export function octoResolver(iconLoader: IconLoader = octoIconLoader): Promise<Resolver> {
	let r = resolvers.get(iconLoader)
	if (!r) {
		r = createResolver({ library: stockLibrary, normalizers: stockNormalizers, iconLoader, onUnknownIcon: 'placeholder' })
		resolvers.set(iconLoader, r)
	}
	return r
}

/** The MDP part of a doc: `octo` (our sidecar) is not MDP. */
export function mdpOnly(doc: MdpDoc): { entities: MdpDoc['entities']; connections: MdpDoc['connections'] } {
	return { entities: doc.entities, connections: doc.connections }
}

export async function validateMdp(doc: MdpDoc): Promise<ValidationResult> {
	return (await octoResolver()).validate(mdpOnly(doc))
}

export async function resolveMdp(doc: MdpDoc): Promise<ResolveResult> {
	return (await octoResolver()).resolve(mdpOnly(doc))
}
