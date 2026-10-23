/**
 * The common cloud resource graph every provider normalizes into. Pure data:
 * no SDKs, no I/O. `parent` builds the containment tree
 * (account / project / subscription → region → VPC / VNet → subnet);
 * `relations` are the edges inferred from real configuration
 * (event sources, integrations, subscriptions, network attachments, ...).
 */

export type CloudProvider = 'aws' | 'gcp' | 'azure'

export interface CloudResource {
	/** Provider-native id: ARN, full resource name, ARM id; pseudo containers use `region:<scope>/<name>`. */
	id: string
	/** Provider-native type: `AWS::Lambda::Function`, `run.googleapis.com/Service`, `microsoft.web/sites`; pseudo: `account`, `region`. */
	type: string
	name: string
	region?: string
	/** Id of the containing resource (region, VPC, subnet, account). */
	parent?: string
	/** Redacted (see `redactTags`). */
	tags: Record<string, string>
	/** Small, non-secret facts (cidr, runtime, engine, env var NAMES). */
	props: Record<string, string>
}

export type RelationKind =
	| 'invokes'
	| 'triggers'
	| 'routes'
	| 'publishes'
	| 'subscribes'
	| 'reads'
	| 'writes'
	| 'uses'
	| 'connects'
	| 'origin'
	| 'alias'
	| 'runs-on'
	| 'attached'
	| 'private-link'
	| 'env'

export interface CloudRelation {
	from: string
	to: string
	kind: RelationKind
	/** Short edge label override (`env ORDERS_TABLE`, `:443`). */
	label?: string
}

export interface CloudGraph {
	provider: CloudProvider
	/** Root scope: account id, project id, subscription id. */
	scope: string
	/** Display name for the root container. */
	scopeName?: string
	resources: CloudResource[]
	relations: CloudRelation[]
	warnings: string[]
}

export const ACCOUNT_TYPE = 'account'
export const REGION_TYPE = 'region'

const SECRET_KEY = /secret|token|password|passwd|key|credential|private/i

export const REDACTED = '[redacted]'

/** Tag / label values whose key looks secret are replaced. Keys are kept (they are names, not secrets). */
export function redactTags(tags: Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(tags ?? {})) out[k] = SECRET_KEY.test(k) ? REDACTED : String(v)
	return out
}

export function isSecretKey(key: string): boolean {
	return SECRET_KEY.test(key)
}

/**
 * Builds a graph incrementally: resources merge by id (later facts fill gaps),
 * relations may reference ids, short ids or names that are resolved at the end
 * through `alias`.
 */
export class GraphBuilder {
	private byId = new Map<string, CloudResource>()
	private aliases = new Map<string, string>()
	private rels: CloudRelation[] = []
	warnings: string[] = []

	constructor(
		readonly provider: CloudProvider,
		public scope = 'unknown',
		public scopeName?: string,
	) {}

	has(id: string): boolean {
		return this.byId.has(id)
	}

	get(id: string): CloudResource | undefined {
		return this.byId.get(id) ?? this.byId.get(this.aliases.get(id) ?? '')
	}

	/** Adds or merges a resource. Tags are redacted here, so nothing unredacted is ever stored. */
	add(r: Omit<CloudResource, 'tags' | 'props'> & { tags?: Record<string, string>; props?: Record<string, string> }): CloudResource {
		const tags = redactTags(r.tags)
		const props = r.props ?? {}
		const prev = this.byId.get(r.id)
		if (prev) {
			if ((!prev.name || prev.name === prev.id) && r.name) prev.name = r.name
			prev.region ??= r.region
			prev.parent ??= r.parent
			if (prev.type.startsWith('?') && !r.type.startsWith('?')) prev.type = r.type
			Object.assign(prev.tags, tags)
			for (const [k, v] of Object.entries(props)) prev.props[k] ??= v
			return prev
		}
		const res: CloudResource = { id: r.id, type: r.type, name: r.name || r.id, region: r.region, parent: r.parent, tags, props: { ...props } }
		this.byId.set(r.id, res)
		return res
	}

	/** `key` (short id, name, URL, lowercase id) resolves to `id`. First registration wins. */
	alias(key: string | undefined, id: string) {
		if (!key) return
		if (!this.aliases.has(key)) this.aliases.set(key, id)
		const lower = key.toLowerCase()
		if (!this.aliases.has(lower)) this.aliases.set(lower, id)
	}

	resolve(ref: string | undefined): string | undefined {
		if (!ref) return undefined
		if (this.byId.has(ref)) return ref
		return this.aliases.get(ref) ?? this.aliases.get(ref.toLowerCase())
	}

	relate(from: string | undefined, to: string | undefined, kind: RelationKind, label?: string) {
		if (!from || !to) return
		this.rels.push({ from, to, kind, label })
	}

	/** Sets a resource's parent once it exists (refs resolved). */
	setParent(id: string, parentRef: string | undefined, force = false) {
		const r = this.get(id)
		const p = this.resolve(parentRef)
		if (r && p && p !== r.id && (force || !r.parent)) r.parent = p
	}

	build(): CloudGraph {
		const relations: CloudRelation[] = []
		const seen = new Set<string>()
		let dropped = 0
		for (const rel of this.rels) {
			const from = this.resolve(rel.from)
			const to = this.resolve(rel.to)
			if (!from || !to) {
				dropped++
				continue
			}
			if (from === to) continue
			const k = `${from}\u0000${to}\u0000${rel.kind}`
			if (seen.has(k)) continue
			seen.add(k)
			relations.push({ ...rel, from, to })
		}
		// parents must exist and must not form cycles
		const resources = [...this.byId.values()]
		for (const r of resources) {
			if (r.parent && !this.byId.has(r.parent)) r.parent = this.resolve(r.parent)
			const chain = new Set([r.id])
			let p = r.parent
			while (p) {
				if (chain.has(p)) {
					r.parent = undefined
					break
				}
				chain.add(p)
				p = this.byId.get(p)?.parent
			}
		}
		const warnings = [...this.warnings]
		if (dropped) warnings.push(`${dropped} relation${dropped === 1 ? '' : 's'} pointed at resources outside the inventory and were left out`)
		return { provider: this.provider, scope: this.scope, scopeName: this.scopeName, resources, relations, warnings }
	}
}

/** Ensures account and region pseudo containers exist; returns the region id. */
export function regionContainer(b: GraphBuilder, scopeId: string, region: string | undefined): string {
	if (!region || region === 'global') return scopeId
	const id = `region:${scopeId}/${region}`
	if (!b.has(id)) b.add({ id, type: REGION_TYPE, name: region, region, parent: scopeId })
	return id
}

/**
 * Relations through hidden plumbing (target groups, URL maps, backend
 * services, NEGs, subscriptions, NICs) become direct relations between the
 * visible ends: `lb → proxy → url map → backend → NEG → service` adds
 * `lb → service`. The first hop's kind is kept; the original relations stay.
 */
export function bypassHidden(g: CloudGraph, isHidden: (r: CloudResource) => boolean, maxDepth = 6): CloudGraph {
	const byId = new Map(g.resources.map((r) => [r.id, r]))
	const hidden = (id: string) => {
		const r = byId.get(id)
		return !!r && isHidden(r)
	}
	const out = new Map<string, CloudRelation[]>()
	for (const rel of g.relations) {
		const list = out.get(rel.from) ?? []
		list.push(rel)
		out.set(rel.from, list)
	}
	const added: CloudRelation[] = []
	const seen = new Set(g.relations.map((r) => `${r.from}\u0000${r.to}\u0000${r.kind}`))
	for (const rel of g.relations) {
		if (hidden(rel.from) || !hidden(rel.to)) continue
		const stack: { id: string; depth: number; label?: string }[] = [{ id: rel.to, depth: 1, label: rel.label }]
		const visited = new Set<string>([rel.from])
		while (stack.length) {
			const cur = stack.pop()!
			if (visited.has(cur.id)) continue
			visited.add(cur.id)
			for (const next of out.get(cur.id) ?? []) {
				if (visited.has(next.to)) continue
				if (hidden(next.to)) {
					if (cur.depth < maxDepth) stack.push({ id: next.to, depth: cur.depth + 1, label: cur.label ?? next.label })
					continue
				}
				const k = `${rel.from}\u0000${next.to}\u0000${rel.kind}`
				if (seen.has(k)) continue
				seen.add(k)
				added.push({ from: rel.from, to: next.to, kind: rel.kind, label: cur.label ?? next.label })
			}
		}
	}
	return { ...g, relations: [...g.relations, ...added] }
}
