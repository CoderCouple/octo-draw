/**
 * Cloud resource graph → multi-page octo DSL.
 *
 * Root page: account → regions → VPCs (→ subnets) with the visible resources
 * and edges from real relations. Every page is capped (~40 nodes, groups
 * included); over the cap we fold, in order: subnets into their VPC, tagged
 * applications into one node, same-type resources into a count node
 * ("37 Lambda functions"), whole VPCs, whole regions, and finally a
 * "N more" continuation. Folded nodes drill (`drill:`) into a page that
 * lists what they hide, which is capped the same way. Applications (tags
 * `app` / `service` / CloudFormation stack / k8s labels / resource group)
 * also get a page each.
 */

import { printOcto, printPageName, type DiagramIR, type IREdge, type IRNode } from '@octo-draw/core'
import { cleanKey, KeyAllocator, plural } from '../../util'
import { kindOrFallback, type CloudKind } from './catalog'
import { ACCOUNT_TYPE, REGION_TYPE, type CloudGraph, type CloudRelation, type CloudResource, type RelationKind } from './model'

export interface RenderOptions {
	title?: string
	/** Max nodes (groups included) per page; default 40. */
	maxNodesPerPage?: number
	/** Max application pages; default 25. */
	maxAppPages?: number
	/** `source` directive for the root page (the connector input that re-creates this inventory). */
	source?: string
}

export interface RenderResult {
	code: string
	pages: string[]
	stats: { resources: number; drawn: number; relations: number; edges: number; apps: number }
	warnings: string[]
}

const APP_TAGS = ['app', 'application', 'app-name', 'appname', 'service', 'service-name', 'app.kubernetes.io/part-of', 'app.kubernetes.io/name', 'k8s-app', 'aws:cloudformation:stack-name', 'serverless:stack', 'project', 'workload', 'system', 'component']

const PROVIDER_ICON = { aws: 'aws', gcp: 'gcp', azure: 'azure' } as const
const PROVIDER_LABEL = { aws: 'AWS account', gcp: 'GCP project', azure: 'Azure subscription' } as const

export const REL_LABEL: Record<RelationKind, string> = {
	invokes: 'invokes',
	triggers: 'triggers',
	routes: 'routes',
	publishes: 'publishes',
	subscribes: 'delivers',
	reads: 'reads',
	writes: 'writes',
	uses: 'uses',
	connects: 'connects',
	origin: 'origin',
	alias: 'alias',
	'runs-on': 'runs on',
	attached: 'attached',
	'private-link': 'private link',
	env: 'env',
}
export const DOTTED: Set<RelationKind> = new Set(['env', 'uses', 'private-link', 'runs-on'])

interface Ctx {
	g: CloudGraph
	byId: Map<string, CloudResource>
	kind: Map<string, CloudKind>
	children: Map<string, string[]>
	app: Map<string, string>
	appMembers: Map<string, string[]>
	appPage: Map<string, string>
	rels: CloudRelation[]
	relsBy: Map<string, CloudRelation[]>
	cap: number
	pageNames: Set<string>
	queue: PageSpec[]
	out: { name: string; ir: DiagramIR }[]
	warnings: string[]
	drawn: Set<string>
	edges: number
	listPages: Map<string, string>
}

type PageMode = 'root' | 'vpc' | 'region' | 'app' | 'list'

interface PageSpec {
	name: string
	mode: PageMode
	members: string[]
	/** The container shown as the outermost group (vpc / region pages). */
	top?: string
	/** For app pages: don't fold this app again. */
	app?: string
}

interface Unit {
	key?: string
	members: string[]
	/** Container id this unit sits in (undefined = top level). */
	parent?: string
	label?: string
	icon?: string
	shape?: 'cylinder'
	drill?: string
	color?: string
	external?: boolean
	folded?: boolean
}

const isContainerKind = (k: CloudKind | undefined) => !!k?.container

export function renderCloudGraph(g: CloudGraph, opts: RenderOptions = {}): RenderResult {
	const cap = Math.max(8, opts.maxNodesPerPage ?? 40)
	const byId = new Map(g.resources.map((r) => [r.id, r]))
	const kind = new Map<string, CloudKind>()
	for (const r of g.resources) if (r.type !== ACCOUNT_TYPE && r.type !== REGION_TYPE) kind.set(r.id, kindOrFallback(r.type, g.provider))
	const children = new Map<string, string[]>()
	for (const r of g.resources) {
		if (!r.parent) continue
		const list = children.get(r.parent) ?? []
		list.push(r.id)
		children.set(r.parent, list)
	}
	const ctx: Ctx = {
		g,
		byId,
		kind,
		children,
		app: new Map(),
		appMembers: new Map(),
		appPage: new Map(),
		rels: [],
		relsBy: new Map(),
		cap,
		pageNames: new Set(),
		queue: [],
		out: [],
		warnings: [...g.warnings],
		drawn: new Set(),
		edges: 0,
		listPages: new Map(),
	}
	const leaves = g.resources.filter((r) => isLeaf(ctx, r)).map((r) => r.id)
	const leafSet = new Set(leaves)
	ctx.rels = g.relations.filter((r) => leafSet.has(r.from) && leafSet.has(r.to))
	for (const rel of ctx.rels) {
		for (const end of [rel.from, rel.to]) {
			const list = ctx.relsBy.get(end) ?? []
			list.push(rel)
			ctx.relsBy.set(end, list)
		}
	}

	// applications
	for (const id of leaves) {
		const a = appOf(byId.get(id)!)
		if (!a) continue
		ctx.app.set(id, a)
		const list = ctx.appMembers.get(a) ?? []
		list.push(id)
		ctx.appMembers.set(a, list)
	}
	// an app holding (almost) everything is just the account again: no page for it
	const apps = [...ctx.appMembers.entries()].filter(([, m]) => m.length >= 2 && m.length <= Math.max(2, leaves.length * 0.8)).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
	const maxApps = opts.maxAppPages ?? 25
	for (const [a, members] of apps.slice(0, maxApps)) {
		const name = uniquePage(ctx, `App · ${a}`)
		ctx.appPage.set(a, name)
		ctx.queue.push({ name, mode: 'app', members, app: a })
	}
	if (apps.length > maxApps) ctx.warnings.push(`${apps.length - maxApps} more applications were not given their own page`)

	const title = opts.title ?? g.scopeName ?? `${PROVIDER_LABEL[g.provider]} ${g.scope}`
	renderPage(ctx, { name: '', mode: 'root', members: leaves }, title)
	if (opts.source && ctx.out[0]) ctx.out[0].ir.source = opts.source
	// root first, then pages in discovery order (app pages were queued first but render after root)
	for (let i = 0; i < ctx.queue.length; i++) renderPage(ctx, ctx.queue[i])

	const parts: string[] = []
	for (const p of ctx.out) {
		const body = printOcto(p.ir).trimEnd()
		parts.push(p.name === '' ? body : `page ${printPageName(p.name)}\n${body}`)
	}
	if (!leaves.length) ctx.warnings.push('no drawable resources found in the inventory')
	return {
		code: parts.join('\n\n') + '\n',
		pages: ctx.out.map((p) => p.name),
		stats: { resources: g.resources.length, drawn: ctx.drawn.size, relations: ctx.rels.length, edges: ctx.edges, apps: ctx.appPage.size },
		warnings: ctx.warnings,
	}
}

function isLeaf(ctx: Ctx, r: CloudResource): boolean {
	if (r.type === ACCOUNT_TYPE || r.type === REGION_TYPE) return false
	const k = ctx.kind.get(r.id)
	return !!k && !k.hidden && !k.container
}

function isContainer(ctx: Ctx, id: string): boolean {
	const r = ctx.byId.get(id)
	if (!r) return false
	return r.type === ACCOUNT_TYPE || r.type === REGION_TYPE || isContainerKind(ctx.kind.get(id))
}

function appOf(r: CloudResource): string | undefined {
	const lower = new Map(Object.entries(r.tags).map(([k, v]) => [k.toLowerCase(), v]))
	for (const t of APP_TAGS) {
		const v = lower.get(t)
		if (v && v !== '[redacted]' && v.trim()) return v.trim()
	}
	return r.props.resourceGroup || undefined
}

function uniquePage(ctx: Ctx, want: string): string {
	let name = want.replace(/[\r\n]+/g, ' ').trim()
	for (let n = 2; ctx.pageNames.has(name.toLowerCase()); n++) name = `${want} ${n}`
	ctx.pageNames.add(name.toLowerCase())
	return name
}

/** Nearest container ancestor (the leaf's own group). */
function containerOf(ctx: Ctx, id: string): string | undefined {
	let p = ctx.byId.get(id)?.parent
	while (p && !isContainer(ctx, p)) p = ctx.byId.get(p)?.parent
	return p
}

function chain(ctx: Ctx, id: string | undefined): string[] {
	const out: string[] = []
	while (id) {
		out.unshift(id)
		id = ctx.byId.get(id)?.parent
		while (id && !isContainer(ctx, id)) id = ctx.byId.get(id)?.parent
	}
	return out
}

function containerKindOf(ctx: Ctx, id: string): 'account' | 'region' | 'vpc' | 'subnet' {
	const r = ctx.byId.get(id)!
	if (r.type === ACCOUNT_TYPE) return 'account'
	if (r.type === REGION_TYPE) return 'region'
	return ctx.kind.get(id)?.container ?? 'vpc'
}

function containerLabel(ctx: Ctx, id: string): string {
	const r = ctx.byId.get(id)!
	const k = containerKindOf(ctx, id)
	if (k === 'account') return r.name && r.name !== r.id ? `${r.name}` : `${PROVIDER_LABEL[ctx.g.provider]} ${r.id}`
	if (k === 'region') return r.name
	if (k === 'vpc') return r.props.cidr ? `${r.name} ${r.props.cidr}` : r.name
	return r.props.cidr ? `${r.name} ${r.props.cidr}` : r.name
}

function containerIcon(ctx: Ctx, id: string): string | undefined {
	const k = containerKindOf(ctx, id)
	const r = ctx.byId.get(id)!
	if (k === 'account') return PROVIDER_ICON[ctx.g.provider]
	if (k === 'region') return ctx.g.provider === 'aws' ? 'aws-group-region' : undefined
	if (k === 'subnet' && ctx.g.provider === 'aws') return r.props.public === 'true' ? 'aws-group-public-subnet' : 'aws-group-private-subnet'
	return ctx.kind.get(id)?.icon
}

function containerColor(ctx: Ctx, id: string): string | undefined {
	const k = containerKindOf(ctx, id)
	if (k === 'region') return 'blue'
	if (k === 'vpc') return 'green'
	if (k === 'subnet') return ctx.byId.get(id)!.props.public === 'true' ? 'lime' : 'teal'
	return undefined
}

function renderPage(ctx: Ctx, spec: PageSpec, title?: string) {
	const memberSet = new Set(spec.members)
	if (spec.name) ctx.pageNames.add(spec.name.toLowerCase())

	// containers never drawn on this page: the account on sub-pages, everything above a vpc/region page's top
	const hidden = new Set<string>()
	if (spec.mode !== 'root') {
		for (const r of ctx.g.resources) if (r.type === ACCOUNT_TYPE) hidden.add(r.id)
		if (spec.top) for (const c of chain(ctx, spec.top)) if (c !== spec.top) hidden.add(c)
	}
	const visible = (id: string | undefined): string | undefined => {
		while (id && hidden.has(id)) id = containerOf(ctx, id)
		return id
	}
	const containersOf = (us: Unit[]): Set<string> => {
		const set = new Set<string>()
		for (const u of us) if (!u.external) for (const c of chain(ctx, u.parent)) if (!hidden.has(c)) set.add(c)
		return set
	}
	const countOf = (us: Unit[]) => us.length + containersOf(us).size

	let units: Unit[] = spec.members.map((id) => ({ members: [id], parent: containerOf(ctx, id) }))
	const foldable = spec.mode !== 'list'
	// 1. subnets → VPC
	if (countOf(units) > ctx.cap && foldable) {
		for (const u of units) {
			if (u.parent && containerKindOf(ctx, u.parent) === 'subnet') {
				hidden.add(u.parent)
				u.parent = containerOf(ctx, u.parent)
			}
		}
	}
	// 2./3. greedy: the biggest group first, either a tagged application or a resource type, per container
	if (foldable) {
		const appKey = (u: Unit) => (spec.mode !== 'app' && u.members.length === 1 ? ctx.app.get(u.members[0]) : undefined)
		const typeKey = (u: Unit) => (u.members.length === 1 ? ctx.byId.get(u.members[0])!.type.toLowerCase() : undefined)
		while (countOf(units) > ctx.cap) {
			const best = biggestGroup(units, [
				['app', appKey],
				['type', typeKey],
			], memberSet.size)
			if (!best) break
			const members = best.us.flatMap((u) => u.members)
			let made: Partial<Unit>
			if (best.strategy === 'app') {
				made = { label: `${best.key} (${plural(members.length, 'resource')})`, icon: commonIcon(ctx, members), drill: ctx.appPage.get(best.key) }
			} else {
				const k = ctx.kind.get(members[0])!
				const where = best.parent ? containerLabel(ctx, best.parent) : (ctx.g.scopeName ?? ctx.g.scope)
				made = { label: `${members.length} ${k.plural}`, icon: k.icon, shape: k.shape, drill: listPage(ctx, `${k.plural} · ${where}`, members) }
			}
			units = units.filter((u) => !best.us.includes(u))
			units.push({ members, parent: best.parent, folded: true, ...made })
		}
	}
	// 4./5. whole VPCs, then whole regions
	for (const level of ['vpc', 'region'] as const) {
		if (countOf(units) <= ctx.cap || !foldable) break
		const groups = [...containersOf(units)].filter((c) => containerKindOf(ctx, c) === level && c !== spec.top)
		const sized = groups.map((c) => ({ c, us: units.filter((u) => !u.external && chain(ctx, u.parent).includes(c)) })).sort((a, b) => b.us.length - a.us.length)
		for (const { c, us } of sized) {
			if (countOf(units) <= ctx.cap) break
			const members = us.flatMap((u) => u.members)
			if (!members.length || (members.length >= memberSet.size && spec.mode !== 'root')) continue
			const r = ctx.byId.get(c)!
			const name = listPage(ctx, `${level === 'vpc' ? 'VPC' : 'Region'} · ${r.name}`, members, level, c)
			units = units.filter((u) => !us.includes(u))
			units.push({ members, parent: visible(containerOf(ctx, c)), label: `${containerLabel(ctx, c)} (${plural(members.length, 'resource')})`, icon: containerIcon(ctx, c), drill: name, folded: true })
		}
	}
	// 6. continuation page
	if (countOf(units) > ctx.cap) {
		const ordered = [...units].sort((a, b) => b.members.length - a.members.length)
		let keep = ordered.length
		while (keep > 1 && countOf(ordered.slice(0, keep)) + 1 > ctx.cap) keep--
		const rest = ordered.slice(keep)
		const members = rest.flatMap((u) => u.members)
		const m = / \(more(?: (\d+))?\)$/.exec(spec.name)
		const base = m ? spec.name.slice(0, m.index) : spec.name || 'Overview'
		const name = listPage(ctx, `${base} (more${m ? ` ${(m[1] ? Number(m[1]) : 1) + 1}` : ''})`, members)
		units = [...ordered.slice(0, keep), { members, label: `${members.length} more resources`, icon: 'layers', drill: name, folded: true }]
	}
	for (const u of units) u.parent = visible(u.parent)

	// outside neighbours on sub-pages (context), while there is room
	if (spec.mode !== 'root') {
		const inside = new Set(units.flatMap((u) => u.members))
		const score = new Map<string, number>()
		for (const m of inside) {
			for (const rel of ctx.relsBy.get(m) ?? []) {
				const other = rel.from === m ? rel.to : rel.from
				if (!inside.has(other)) score.set(other, (score.get(other) ?? 0) + 1)
			}
		}
		const ranked = [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		for (const [id] of ranked) {
			if (countOf(units) >= ctx.cap) break
			units.push({ members: [id], external: true })
		}
	}

	ctx.out.push({ name: spec.name, ir: buildIR(ctx, spec, units, hidden, title) })
}

function commonIcon(ctx: Ctx, members: string[]): string {
	const counts = new Map<string, number>()
	for (const m of members) {
		const k = ctx.kind.get(m)
		if (k) counts.set(k.icon, (counts.get(k.icon) ?? 0) + 1)
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'layers'
}

type Strategy = 'app' | 'type'

/** The largest foldable group (≥ 2 units, smaller than the whole page) across strategies; apps win ties. */
function biggestGroup(units: Unit[], strategies: [Strategy, (u: Unit) => string | undefined][], total: number): { strategy: Strategy; key: string; parent?: string; us: Unit[] } | undefined {
	let best: { strategy: Strategy; key: string; parent?: string; us: Unit[] } | undefined
	for (const [strategy, keyOf] of strategies) {
		const groups = new Map<string, { strategy: Strategy; key: string; parent?: string; us: Unit[] }>()
		for (const u of units) {
			if (u.folded || u.external) continue
			const k = keyOf(u)
			if (!k) continue
			const gk = `${u.parent ?? ''}\u0000${k}`
			const grp = groups.get(gk) ?? { strategy, key: k, parent: u.parent, us: [] }
			grp.us.push(u)
			groups.set(gk, grp)
		}
		for (const g of groups.values()) {
			if (g.us.length < 2 || g.us.length >= total) continue
			if (!best || g.us.length > best.us.length || (g.us.length === best.us.length && g.key < best.key && g.strategy === best.strategy)) best = g
		}
	}
	return best
}

/** One list page per distinct member set (pages that fold the same bucket share it). */
function listPage(ctx: Ctx, want: string, members: string[], mode: PageMode = 'list', top?: string): string {
	const sig = `${mode}\u0000${top ?? ''}\u0000${[...members].sort().join('\u0000')}`
	const have = ctx.listPages.get(sig)
	if (have) return have
	const name = uniquePage(ctx, want)
	ctx.listPages.set(sig, name)
	ctx.queue.push({ name, mode, members, top })
	return name
}

function buildIR(ctx: Ctx, spec: PageSpec, units: Unit[], hidden: Set<string>, title?: string): DiagramIR {
	const keys = new KeyAllocator()
	const nodes: IRNode[] = []
	const containerKey = new Map<string, string>()
	const ensureContainer = (id: string): string | undefined => {
		if (hidden.has(id)) return undefined
		const have = containerKey.get(id)
		if (have) return have
		const parentChain = chain(ctx, containerOf(ctx, id))
		let parentKey: string | undefined
		for (let i = parentChain.length - 1; i >= 0; i--) {
			const pk = ensureContainer(parentChain[i])
			if (pk) {
				parentKey = pk
				break
			}
		}
		const label = short(containerLabel(ctx, id))
		const key = keys.take(label)
		containerKey.set(id, key)
		const node: IRNode = { key, isContainer: true, parent: parentKey }
		if (key !== label) node.label = label
		node.ext = { src: resourceSrc(ctx.g.provider, id) }
		const icon = containerIcon(ctx, id)
		if (icon) node.icon = icon
		const color = containerColor(ctx, id)
		if (color) node.style = { color }
		nodes.push(node)
		return key
	}
	const unitOf = new Map<string, string>()
	const pending: IRNode[] = []
	for (const u of units) {
		let parentKey: string | undefined
		if (!u.external && u.parent) {
			const ch = chain(ctx, u.parent)
			for (let i = ch.length - 1; i >= 0; i--) {
				const pk = ensureContainer(ch[i])
				if (pk) {
					parentKey = pk
					break
				}
			}
		}
		let node: IRNode
		if (u.members.length === 1 && !u.folded) {
			const r = ctx.byId.get(u.members[0])!
			const k = ctx.kind.get(r.id)!
			const want = short(r.name)
			node = { key: keys.take(want), icon: k.icon, parent: parentKey }
			if (node.key !== want) node.label = want
			if (k.shape) node.shape = k.shape
			if (u.external) node.style = { color: 'gray', dash: 'dashed' }
			node.ext = { src: resourceSrc(ctx.g.provider, r.id) }
			ctx.drawn.add(r.id)
		} else {
			const want = short(u.label ?? `${u.members.length} resources`)
			node = { key: keys.take(want), icon: u.icon, parent: parentKey }
			if (node.key !== want) node.label = want
			if (u.shape) node.shape = u.shape
			if (u.drill) node.ext = { drill: u.drill }
		}
		for (const m of u.members) unitOf.set(m, node.key)
		pending.push(node)
	}
	nodes.push(...pending)

	// edges between distinct visible units
	const agg = new Map<string, { from: string; to: string; labels: Set<string>; kinds: Set<RelationKind>; n: number }>()
	for (const rel of ctx.rels) {
		const a = unitOf.get(rel.from)
		const b = unitOf.get(rel.to)
		if (!a || !b || a === b) continue
		const k = `${a}\u0000${b}`
		const e = agg.get(k) ?? { from: a, to: b, labels: new Set<string>(), kinds: new Set<RelationKind>(), n: 0 }
		e.labels.add(rel.label ?? REL_LABEL[rel.kind])
		e.kinds.add(rel.kind)
		e.n++
		agg.set(k, e)
	}
	const edges: IREdge[] = []
	const pairCount = new Map<string, number>()
	for (const e of agg.values()) {
		// security-group reachability (`connects`) only labels an edge nothing more specific explains
		const labels = [...e.labels]
		const specific = e.kinds.size > 1 && e.kinds.has('connects') ? labels.filter((l) => !/^:\d+$/.test(l)) : labels
		const label = specific.length === 1 ? specific[0] : `${specific.length} links`
		const dotted = [...e.kinds].every((k) => DOTTED.has(k))
		const pk = `${e.from}->${e.to}`
		const n = pairCount.get(pk) ?? 0
		pairCount.set(pk, n + 1)
		edges.push({ key: `${pk}#${n}`, from: e.from, to: e.to, label, arrow: { start: 'none', end: 'arrow' }, line: { dash: dotted ? 'dotted' : 'solid' } })
	}
	ctx.edges += edges.length

	return {
		version: 1,
		kind: 'architecture',
		direction: 'right',
		style: { colorMode: 'pastel', styleMode: 'shadow', typeface: 'clean' },
		title: spec.mode === 'root' ? title : undefined,
		nodes,
		edges,
	}
}

/** `src` of a node standing for one resource: `<provider>:<resource id>`. */
export function resourceSrc(provider: string, id: string): string {
	return `${provider}:${id}`
}

export function short(s: string): string {
	const c = cleanKey(s)
	return c.length > 56 ? `${c.slice(0, 55)}…` : c
}
