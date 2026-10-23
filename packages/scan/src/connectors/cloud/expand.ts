/**
 * One cloud resource → one page body (on-demand expansion and `depth > 1`).
 * Pure: reads a CloudGraph, prints octo with core's formatter.
 *
 * - Containers (account, region, VPC / VNet, subnet): what they hold. A VPC
 *   shows its subnets as groups with their resources; regions and accounts
 *   show their child networks as expandable nodes. Over the cap, resources of
 *   one type fold into a count node ("12 Lambda functions").
 * - Everything else: a details page: the resource, a note with its key
 *   (non-secret) props, containers it runs (ECS), its IAM role, env var
 *   names, the network it sits in, and related resources: incoming relations
 *   (triggers, routes, subscriptions) on the left, outgoing ones (invokes,
 *   writes, env references) on the right. Plumbing between them (target
 *   groups, listeners, subscriptions) is drawn as its own hop.
 */

import { printOcto, type DiagramIR, type IREdge, type IRNode } from '@octo-draw/core'
import type { ExpandedPage } from '../../expand/types'
import { KeyAllocator, plural } from '../../util'
import { kindOrFallback, type CloudKind } from './catalog'
import { ACCOUNT_TYPE, isSecretKey, REDACTED, REGION_TYPE, type CloudGraph, type CloudRelation, type CloudResource } from './model'
import { DOTTED, REL_LABEL, resourceSrc, short } from './render'

export interface CloudExpandOptions {
	/** Max nodes on the page, groups included (default 30). */
	maxNodes?: number
}

const PROVIDER_ICON = { aws: 'aws', gcp: 'gcp', azure: 'azure' } as const
const GHOST = { color: 'gray', dash: 'dashed' } as const
/** Props that are bookkeeping, not facts worth showing. */
const SKIP_PROPS = new Set(['envKeys', 'clusterMember', 'resourceGroup'])

class PageBuilder {
	keys = new KeyAllocator()
	nodes: IRNode[] = []
	keyOf = new Map<string, string>()
	children: string[] = []
	private edgeMap = new Map<string, { from: string; to: string; labels: Set<string>; dotted: boolean }>()

	constructor(private g: CloudGraph) {}

	kind(r: CloudResource): CloudKind | undefined {
		return r.type === ACCOUNT_TYPE || r.type === REGION_TYPE ? undefined : kindOrFallback(r.type, this.g.provider)
	}

	resource(r: CloudResource, o: { parent?: string; ghost?: boolean; child?: boolean; group?: boolean; label?: string } = {}): string {
		const have = this.keyOf.get(r.id)
		if (have) return have
		const want = short(o.label ?? resourceLabel(this.g, r))
		const key = this.keys.take(want)
		const k = this.kind(r)
		const node: IRNode = { key, ext: { src: resourceSrc(this.g.provider, r.id) } }
		if (key !== want) node.label = want
		const icon = r.type === ACCOUNT_TYPE ? PROVIDER_ICON[this.g.provider] : k?.icon
		if (icon) node.icon = icon
		if (k?.shape && !o.group) node.shape = k.shape
		if (o.parent) node.parent = o.parent
		if (o.group) node.isContainer = true
		if (o.ghost) node.style = { ...GHOST }
		else if (o.group && k?.container) node.style = { color: k.container === 'vpc' ? 'green' : r.props.public === 'true' ? 'lime' : 'teal' }
		this.nodes.push(node)
		this.keyOf.set(r.id, key)
		if (o.child) this.children.push(key)
		return key
	}

	/** A node for something that is not one resource (notes, folds, containers, roles). `key` overrides the key (long notes keep a short key). */
	plain(want: string, o: { icon?: string; shape?: IRNode['shape']; parent?: string; ghost?: boolean; key?: string } = {}): string {
		const label = o.key ? want.replace(/[\r\n]+/g, ' ') : short(want)
		const key = this.keys.take(o.key ?? label)
		const node: IRNode = { key }
		if (key !== label) node.label = label
		if (o.icon) node.icon = o.icon
		if (o.shape) node.shape = o.shape
		if (o.parent) node.parent = o.parent
		if (o.ghost) node.style = { ...GHOST }
		this.nodes.push(node)
		return key
	}

	edge(from: string, to: string, label?: string, dotted = false) {
		if (from === to) return
		const k = `${from}\u0000${to}`
		const e = this.edgeMap.get(k) ?? { from, to, labels: new Set<string>(), dotted: true }
		if (label) e.labels.add(label)
		e.dotted &&= dotted
		this.edgeMap.set(k, e)
	}

	rel(rel: CloudRelation, from: string, to: string) {
		this.edge(from, to, rel.label ?? REL_LABEL[rel.kind], DOTTED.has(rel.kind))
	}

	body(): string {
		const edges: IREdge[] = []
		for (const e of this.edgeMap.values()) {
			const labels = [...e.labels]
			const label = labels.length === 0 ? undefined : labels.length === 1 ? labels[0] : `${labels.length} links`
			edges.push({ key: `${e.from}->${e.to}#0`, from: e.from, to: e.to, label, arrow: { start: 'none', end: 'arrow' }, line: { dash: e.dotted ? 'dotted' : 'solid' } })
		}
		const ir: DiagramIR = { version: 1, kind: 'architecture', direction: 'right', style: { colorMode: 'pastel', styleMode: 'shadow', typeface: 'clean' }, nodes: this.nodes, edges }
		return printOcto(ir)
	}
}

function resourceLabel(g: CloudGraph, r: CloudResource): string {
	if (r.type === ACCOUNT_TYPE) return r.name && r.name !== r.id ? r.name : `${g.provider.toUpperCase()} ${r.id}`
	if (r.type === REGION_TYPE) return r.name
	const k = kindOrFallback(r.type, g.provider)
	if (k.container && r.props.cidr) return `${r.name} ${r.props.cidr}`
	return r.name
}

function containerKind(g: CloudGraph, r: CloudResource): 'account' | 'region' | 'vpc' | 'subnet' | undefined {
	if (r.type === ACCOUNT_TYPE) return 'account'
	if (r.type === REGION_TYPE) return 'region'
	return kindOrFallback(r.type, g.provider).container
}

const isHidden = (g: CloudGraph, r: CloudResource) => r.type !== ACCOUNT_TYPE && r.type !== REGION_TYPE && !!kindOrFallback(r.type, g.provider).hidden

/** Finds a resource by id: exact, then case-insensitive (ARM ids), then by name when unique. */
function findResource(g: CloudGraph, id: string): CloudResource | undefined {
	const exact = g.resources.find((r) => r.id === id)
	if (exact) return exact
	const low = id.toLowerCase()
	return g.resources.find((r) => r.id.toLowerCase() === low)
}

export function expandCloudResource(graph: CloudGraph, id: string, opts: CloudExpandOptions = {}): ExpandedPage | null {
	const r = findResource(graph, id)
	if (!r) return null
	const cap = Math.max(6, opts.maxNodes ?? 30)
	const ck = containerKind(graph, r)
	const page = ck ? containerPage(graph, r, ck, cap) : detailsPage(graph, r, cap)
	const what = r.type === ACCOUNT_TYPE ? 'account' : r.type === REGION_TYPE ? 'region' : kindOrFallback(r.type, graph.provider).label
	return { ...page, findings: [{ analyzer: graph.provider, confidence: 0.8, notes: [`${what} ${r.name}: ${page.note}`] }] }
}

// ---------------------------------------------------------------------------
// containers

interface Slot {
	/** Resource ids represented. */
	members: string[]
	/** Group (subnet) id this slot sits in. */
	group?: string
	fold?: { label: string; icon?: string; shape?: IRNode['shape'] }
}

function containerPage(g: CloudGraph, r: CloudResource, ck: 'account' | 'region' | 'vpc' | 'subnet', cap: number): ExpandedPage & { note: string } {
	const byParent = new Map<string, CloudResource[]>()
	for (const x of g.resources) {
		if (!x.parent) continue
		const list = byParent.get(x.parent) ?? []
		list.push(x)
		byParent.set(x.parent, list)
	}
	const kids = (id: string) => (byParent.get(id) ?? []).filter((x) => !isHidden(g, x))
	const direct = kids(r.id)
	// a VPC draws its subnets as groups; accounts and regions draw child containers as (expandable) nodes
	const groups = ck === 'vpc' ? direct.filter((x) => containerKind(g, x) === 'subnet') : []
	const slots: Slot[] = []
	for (const x of direct) if (!groups.includes(x)) slots.push({ members: [x.id] })
	for (const s of groups) for (const x of kids(s.id)) slots.push({ members: [x.id], group: s.id })
	const count = () => slots.length + groups.length
	// fold the largest same-type set (per group) until the page fits
	while (count() > cap) {
		const buckets = new Map<string, Slot[]>()
		for (const s of slots) {
			if (s.fold || s.members.length !== 1) continue
			const x = g.resources.find((y) => y.id === s.members[0])!
			if (containerKind(g, x)) continue
			const k = `${s.group ?? ''}\u0000${x.type.toLowerCase()}`
			const list = buckets.get(k) ?? []
			list.push(s)
			buckets.set(k, list)
		}
		const best = [...buckets.values()].filter((b) => b.length >= 2).sort((a, b) => b.length - a.length)[0]
		if (!best) break
		const first = g.resources.find((y) => y.id === best[0].members[0])!
		const k = kindOrFallback(first.type, g.provider)
		const members = best.flatMap((s) => s.members)
		for (const s of best) slots.splice(slots.indexOf(s), 1)
		slots.push({ members, group: best[0].group, fold: { label: `${members.length} ${k.plural}`, icon: k.icon, shape: k.shape } })
	}
	if (count() > cap) {
		const keep = Math.max(1, cap - groups.length - 1)
		const rest = slots.splice(keep)
		const members = rest.flatMap((s) => s.members)
		slots.push({ members, fold: { label: `${plural(members.length, 'more resource')}`, icon: 'layers' } })
	}

	const b = new PageBuilder(g)
	const unit = new Map<string, string>()
	for (const s of groups) unit.set(s.id, b.resource(s, { group: true, child: slots.some((x) => x.group === s.id) }))
	if (!groups.length && !slots.length) {
		const self = b.resource(r)
		b.edge(b.plain('no drawable resources inside', { shape: 'document', icon: 'file-text', key: 'details' }), self, undefined, true)
		return { body: b.body(), children: [], note: 'empty' }
	}
	for (const s of slots) {
		const parent = s.group ? b.keyOf.get(s.group) : undefined
		if (s.fold) {
			const key = b.plain(s.fold.label, { icon: s.fold.icon, shape: s.fold.shape, parent })
			for (const m of s.members) unit.set(m, key)
			continue
		}
		const x = g.resources.find((y) => y.id === s.members[0])!
		unit.set(x.id, b.resource(x, { parent, child: true }))
	}
	// everything below a drawn resource maps to it (hidden plumbing inside subnets, nested containers)
	const groupIds = new Set(groups.map((x) => x.id))
	const resolve = (id: string): string | undefined => {
		let cur: string | undefined = id
		for (let i = 0; cur && i < 12; i++) {
			const u = unit.get(cur)
			// hidden plumbing inside a subnet (NICs) is not the subnet itself
			if (u && (!groupIds.has(cur) || cur === id)) return u
			if (u) return undefined
			cur = g.resources.find((y) => y.id === cur)?.parent
		}
		return undefined
	}
	const inside = new Set<string>()
	for (const x of g.resources) if (resolve(x.id) !== undefined) inside.add(x.id)
	const outside = new Map<string, number>()
	for (const rel of g.relations) {
		const a = resolve(rel.from)
		const z = resolve(rel.to)
		if (a && z) {
			// edges into a subnet group from what it holds are containment, not traffic
			if (!groupIds.has(rel.from) && !groupIds.has(rel.to)) b.rel(rel, a, z)
			continue
		}
		if (ck === 'subnet' && (a || z)) {
			const other = a ? rel.to : rel.from
			outside.set(other, (outside.get(other) ?? 0) + 1)
		}
	}
	// a subnet's outside neighbours, as ghosts (expandable, not children)
	if (outside.size) {
		const ranked = [...outside.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
		for (const [oid] of ranked) {
			if (b.nodes.length >= cap) break
			const o = g.resources.find((y) => y.id === oid)
			if (!o || isHidden(g, o)) continue
			b.resource(o, { ghost: true })
		}
		for (const rel of g.relations) {
			const a = resolve(rel.from) ?? b.keyOf.get(rel.from)
			const z = resolve(rel.to) ?? b.keyOf.get(rel.to)
			if (a && z && (inside.has(rel.from) !== inside.has(rel.to))) b.rel(rel, a, z)
		}
	}
	const total = slots.reduce((n, s) => n + s.members.length, 0) + groups.length
	return { body: b.body(), children: b.children, note: `${plural(total, 'resource')} inside` }
}

// ---------------------------------------------------------------------------
// leaf resources

function detailsPage(g: CloudGraph, r: CloudResource, cap: number): ExpandedPage & { note: string } {
	const byId = new Map(g.resources.map((x) => [x.id, x]))
	const b = new PageBuilder(g)
	const self = b.resource(r)
	const k = kindOrFallback(r.type, g.provider)

	// key facts
	const facts: string[] = [k.label]
	if (r.region) facts.push(r.region)
	for (const [key, v] of Object.entries(r.props)) {
		if (SKIP_PROPS.has(key) || key.startsWith('container.') || key === 'role' || isSecretKey(key) || v === REDACTED || !v) continue
		facts.push(`${key}: ${v.length > 40 ? `${v.slice(0, 39)}…` : v}`)
	}
	const factText = facts.join(' · ')
	const note = b.plain(factText.length > 160 ? `${factText.slice(0, 159)}…` : factText, { shape: 'document', icon: 'file-text', key: 'details' })
	b.edge(note, self, undefined, true)

	// containers (ECS task definition facts), IAM role
	for (const [key, v] of Object.entries(r.props)) {
		if (!key.startsWith('container.')) continue
		const c = b.plain(`container ${key.slice(10)}${v ? ` (${v})` : ''}`, { icon: g.provider === 'aws' ? 'aws-ecs' : k.icon })
		b.edge(self, c, 'runs')
	}
	if (r.props.role) {
		const roleKind = kindOrFallback(g.provider === 'aws' ? 'AWS::IAM::Role' : g.provider === 'gcp' ? 'iam.googleapis.com/ServiceAccount' : 'microsoft.managedidentity/userassignedidentities', g.provider)
		const role = b.plain(`role ${r.props.role}`, { icon: roleKind.icon })
		b.edge(self, role, 'assumes', true)
	}

	// the network it sits in
	if (r.parent) {
		const p = byId.get(r.parent)
		const pk0 = p && containerKind(g, p)
		if (p && (pk0 === 'vpc' || pk0 === 'subnet')) {
			const pk = b.resource(p, { ghost: true })
			b.edge(self, pk, 'in', true)
		}
	}

	// related resources; hidden plumbing (target groups, listeners) as its own hop
	const incoming = g.relations.filter((x) => x.to === r.id && x.from !== r.id)
	const outgoing = g.relations.filter((x) => x.from === r.id && x.to !== r.id)
	const viaHidden = new Set<string>()
	const hop: { rel: CloudRelation; dir: 'in' | 'out' }[] = []
	const neighbours: { rel: CloudRelation; dir: 'in' | 'out'; other: CloudResource }[] = []
	for (const [list, dir] of [[incoming, 'in'], [outgoing, 'out']] as const) {
		for (const rel of list) {
			const other = byId.get(dir === 'in' ? rel.from : rel.to)
			if (!other) continue
			neighbours.push({ rel, dir, other })
			if (isHidden(g, other)) {
				// the other ends of the plumbing
				for (const next of g.relations) {
					if (dir === 'out' && next.from === other.id && next.to !== r.id) {
						hop.push({ rel: next, dir })
						viaHidden.add(next.to)
					}
					if (dir === 'in' && next.to === other.id && next.from !== r.id) {
						hop.push({ rel: next, dir })
						viaHidden.add(next.from)
					}
				}
			}
		}
	}
	const envKeysShown = new Set<string>()
	const budget = Math.max(3, cap - b.nodes.length - 2)
	const shown = neighbours.filter((n) => !(viaHidden.has(n.other.id) && !isHidden(g, n.other)))
	// fold by type and direction when there are too many
	const drawn = shown.slice(0, budget)
	const folded = shown.slice(budget)
	for (const n of drawn) {
		const key = b.resource(n.other, { ghost: isHidden(g, n.other) })
		if (n.dir === 'in') b.rel(n.rel, key, self)
		else b.rel(n.rel, self, key)
		const env = /^env (.+)$/.exec(n.rel.label ?? '')
		if (env) envKeysShown.add(env[1])
	}
	for (const h of hop) {
		const a = b.keyOf.get(h.rel.from) ?? (h.dir === 'in' && b.nodes.length < cap ? b.resource(byId.get(h.rel.from)!) : undefined)
		const z = b.keyOf.get(h.rel.to) ?? (h.dir === 'out' && b.nodes.length < cap ? b.resource(byId.get(h.rel.to)!) : undefined)
		if (a && z) b.rel(h.rel, a, z)
	}
	if (folded.length) {
		const buckets = new Map<string, typeof folded>()
		for (const n of folded) {
			const kk = `${n.dir}\u0000${n.other.type.toLowerCase()}`
			buckets.set(kk, [...(buckets.get(kk) ?? []), n])
		}
		for (const list of buckets.values()) {
			const kind = kindOrFallback(list[0].other.type, g.provider)
			const key = b.plain(list.length === 1 ? list[0].other.name : `${list.length} ${list.length === 1 ? kind.label : kind.plural}`, { icon: kind.icon, shape: kind.shape })
			if (list[0].dir === 'in') b.edge(key, self, REL_LABEL[list[0].rel.kind])
			else b.edge(self, key, REL_LABEL[list[0].rel.kind])
		}
	}
	// env var NAMES not explained by a relation (never values; secret-looking names are left out too)
	const envKeys = [...new Set((r.props.envKeys ?? '').split(','))].filter((x) => x && !envKeysShown.has(x) && !isSecretKey(x))
	if (envKeys.length) {
		const text = envKeys.length > 6 ? `${envKeys.slice(0, 6).join(', ')} +${envKeys.length - 6}` : envKeys.join(', ')
		const env = b.plain(`env ${text}`, { shape: 'document', icon: 'settings', key: 'env' })
		b.edge(self, env, undefined, true)
	}
	return { body: b.body(), children: [], note: `${plural(new Set(neighbours.map((n) => n.other.id)).size, 'related resource')}` }
}
