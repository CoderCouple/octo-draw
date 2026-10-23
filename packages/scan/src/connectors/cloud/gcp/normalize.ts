/**
 * Google Cloud Asset Inventory JSON → CloudGraph. Accepts, in any mix:
 *
 * - `gcloud asset search-all-resources --format=json` (array of ResourceSearchResult,
 *   or the API's `{ results: [...] }`): breadth, labels, locations.
 * - `gcloud asset list --content-type=resource --format=json` / `exportAssets`
 *   output (`{ name, assetType, resource: { data } }`, newline-delimited JSON too):
 *   full configuration, which is where relations come from.
 * - Relationship content (`relatedAsset` / `relatedAssets`).
 *
 * Environment variable values are read only to find references; never stored.
 */

import { asArr, asObj, asStr, isObj, type Obj } from '../../../util'
import { cloudKind } from '../catalog'
import { GraphBuilder, ACCOUNT_TYPE, regionContainer, type CloudGraph, type RelationKind } from '../model'

export const GCP_INVENTORY_KIND = 'octo-draw/gcp-inventory'

export interface GcpInventory {
	kind: typeof GCP_INVENTORY_KIND
	version: 1
	scope: string
	/** searchAllResources results. */
	resources: unknown[]
	/** assets.list RESOURCE content (full data). */
	assets: unknown[]
	/** assets.list RELATIONSHIP content. */
	relationships: unknown[]
	warnings?: string[]
}

export interface GcpNormalizeOptions {
	/** Root scope label (project, folders/123, organizations/456). */
	scope?: string
}

interface Asset {
	name: string
	assetType: string
	project?: string
	/** `projects/<number>` from search results. */
	projectNumber?: string
	location?: string
	displayName?: string
	labels: Record<string, string>
	data: Obj
	attrs: Obj
}

const COMPUTE_PREFIXES = [/^https:\/\/www\.googleapis\.com\/compute\/(?:v1|beta|alpha)\//, /^https:\/\/compute\.googleapis\.com\/compute\/(?:v1|beta|alpha)\//]

/** Full resource name (`//svc/path`) → path. */
const pathOf = (name: string) => name.replace(/^\/\/[^/]+\//, '')

function projectOf(name: string): string | undefined {
	return /(?:^|\/)projects\/([^/]+)/.exec(name)?.[1]
}

/** `us-central1-a` → `us-central1`; `global` / multi-regions stay. */
function regionOf(loc: string | undefined): string | undefined {
	if (!loc) return undefined
	loc = loc.toLowerCase()
	if (/^[a-z]+-[a-z]+\d+-[a-z]$/.test(loc)) return loc.slice(0, -2)
	return loc
}

/** selfLinks and partial paths → lookup keys. */
function refKey(s: string | undefined): string | undefined {
	if (!s) return undefined
	let v = s.trim()
	for (const re of COMPUTE_PREFIXES) if (re.test(v)) return `//compute.googleapis.com/${v.replace(re, '')}`
	if (v.startsWith('//')) return v
	v = v.replace(/^https:\/\/[a-z]+\.googleapis\.com\/v\d+\//, '')
	return v
}

function hostOf(s: string): string | undefined {
	const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/?#\s]+)/i.exec(s)
	return m?.[1]?.toLowerCase()
}

class GcpNormalizer {
	b = new GraphBuilder('gcp')
	assets = new Map<string, Asset>()
	projects = new Map<string, number>()
	pending: { from: string; ref: string | undefined; kind: RelationKind; label?: string; alt?: string[] }[] = []
	parents: { id: string; ref: string | undefined }[] = []
	env: { from: string; key: string; refs: string[] }[] = []
	/** Cloud Run service backing a 2nd-gen function → the function. */
	backing = new Map<string, string>()
	migMembers: { mig: string; subnet?: string }[] = []

	constructor(private opts: GcpNormalizeOptions) {}

	walk(input: unknown): void {
		if (typeof input === 'string') {
			// newline-delimited JSON (exportAssets to a file)
			for (const line of input.split('\n')) {
				const t = line.trim()
				if (!t) continue
				try {
					this.walk(JSON.parse(t))
				} catch {
					// skip
				}
			}
			return
		}
		if (Array.isArray(input)) {
			for (const x of input) this.walk(x)
			return
		}
		if (!isObj(input)) return
		if (input.kind === GCP_INVENTORY_KIND) {
			for (const k of ['resources', 'assets', 'relationships']) this.walk(input[k])
			for (const w of asArr(input.warnings)) if (typeof w === 'string') this.b.warnings.push(w)
			return
		}
		if (Array.isArray(input.results)) return this.walk(input.results)
		if (Array.isArray(input.assets)) return this.walk(input.assets)
		if (typeof input.name === 'string' && typeof input.assetType === 'string') this.asset(input)
	}

	asset(o: Obj) {
		const name = asStr(o.name)!
		const assetType = asStr(o.assetType)!
		const res = asObj(o.resource)
		const data = asObj(res.data)
		const prev = this.assets.get(name)
		const a: Asset = prev ?? { name, assetType, labels: {}, data: {}, attrs: {} }
		a.project ??= projectOf(name) ?? projectOf(asStr(o.project) ?? '')
		a.projectNumber ??= projectOf(asStr(o.project) ?? '')
		a.location ??= asStr(o.location) ?? asStr(res.location) ?? asStr(data.location) ?? asStr(data.region) ?? asStr(data.zone)
		a.displayName ??= asStr(o.displayName) ?? asStr(asObj(data.metadata).name) ?? asStr(data.displayName)
		Object.assign(a.labels, asObj(o.labels), asObj(data.labels), asObj(asObj(data.metadata).labels))
		Object.assign(a.data, data)
		Object.assign(a.attrs, asObj(o.additionalAttributes))
		this.assets.set(name, a)
		// relationship content
		const related = [...(isObj(o.relatedAsset) ? [o.relatedAsset] : []), ...asArr(asObj(o.relatedAssets).assets)]
		const relType = asStr(asObj(asObj(o.relatedAssets).relationshipAttributes).type) ?? asStr(asObj(o.relatedAsset).relationshipType)
		for (const r of related) {
			const target = asStr(asObj(r).asset)
			if (!target) continue
			const rt = relType ?? asStr(asObj(r).relationshipType) ?? ''
			if (/INSTANCE_TO_INSTANCEGROUP|_TO_NETWORK$|_TO_SUBNETWORK$/.test(rt)) this.parents.push({ id: name, ref: target })
			else this.pending.push({ from: name, ref: target, kind: 'uses', label: undefined })
		}
	}

	/** Project number ↔ id (asset names mix both). */
	numToId = new Map<string, string>()
	idToNum = new Map<string, string>()

	variants(path: string): string[] {
		const out = [path]
		const p = projectOf(path)
		if (!p) return out
		const other = this.numToId.get(p) ?? this.idToNum.get(p)
		if (other) out.push(path.replace(`projects/${p}`, `projects/${other}`))
		return out
	}

	finish(): CloudGraph {
		const b = this.b
		for (const a of this.assets.values()) {
			if (a.project && a.projectNumber && /^\d+$/.test(a.projectNumber) && !/^\d+$/.test(a.project)) {
				this.numToId.set(a.projectNumber, a.project)
				this.idToNum.set(a.project, a.projectNumber)
			}
		}
		for (const a of this.assets.values()) if (a.project && /^\d+$/.test(a.project)) a.project = this.numToId.get(a.project) ?? a.project
		for (const a of this.assets.values()) if (a.project) this.projects.set(a.project, (this.projects.get(a.project) ?? 0) + 1)
		const projects = [...this.projects.keys()]
		const multi = projects.length > 1
		const scope = this.opts.scope ?? (multi ? 'organization' : (projects[0] ?? 'unknown'))
		b.scope = scope
		b.scopeName = multi ? `GCP ${scope}` : `GCP project ${scope}`
		b.add({ id: scope, type: ACCOUNT_TYPE, name: b.scopeName })
		if (multi) for (const p of projects) b.add({ id: `project:${p}`, type: ACCOUNT_TYPE, name: `project ${p}`, parent: scope })
		const projectContainer = (p: string | undefined) => (multi && p ? `project:${p}` : scope)

		for (const a of this.assets.values()) this.add(a)
		for (const a of this.assets.values()) this.relations(a)

		for (const m of this.migMembers) {
			const mig = this.variants(m.mig).map((k) => b.resolve(k)).find(Boolean)
			if (mig && m.subnet) this.parents.push({ id: mig, ref: m.subnet })
		}
		for (const p of this.parents) {
			const ref = refKey(p.ref)
			b.setParent(p.id, ref ? this.variants(ref).map((k) => b.resolve(k)).find(Boolean) : undefined)
		}
		for (const r of b.build().resources) {
			if (r.type === ACCOUNT_TYPE || r.parent) continue
			const a = this.assets.get(r.id)
			const kind = cloudKind(r.type)
			const pc = projectContainer(a?.project)
			r.parent = kind?.container === 'vpc' || !r.region || r.region === 'global' ? pc : regionContainer(b, pc, r.region)
		}
		for (const p of this.pending) {
			const keys = [refKey(p.ref), ...(p.alt ?? [])].flatMap((k) => (k ? this.variants(k) : []))
			const to = keys.map((k) => b.resolve(k)).find(Boolean)
			const from = this.variants(p.from).map((k) => b.resolve(k)).find(Boolean)
			if (to && from) b.relate(from, to, p.kind, p.label)
		}
		for (const e of this.env) {
			for (const ref of e.refs) {
				const to = b.resolve(refKey(ref)) ?? b.resolve(ref)
				if (to && to !== e.from) {
					b.relate(e.from, to, 'env', `env ${e.key}`)
					break
				}
			}
		}
		this.resolveRev()
		const g = b.build()
		if (this.backing.size) {
			const map = (x: string) => this.backing.get(x) ?? x
			g.resources = g.resources.filter((r) => !this.backing.has(r.id))
			g.relations = g.relations.map((r) => ({ ...r, from: map(r.from), to: map(r.to) })).filter((r) => r.from !== r.to)
		}
		if (!this.assets.size) g.warnings.push('no Google Cloud assets recognised in the input')
		return g
	}

	add(a: Asset) {
		const b = this.b
		const short = a.name.split('/').pop() ?? a.name
		let name = a.displayName && a.displayName.length < 80 ? a.displayName : short
		const region = regionOf(a.location)
		const props: Record<string, string> = {}
		const d = a.data
		if (a.assetType === 'compute.googleapis.com/Subnetwork') {
			const cidr = asStr(d.ipCidrRange) ?? asStr(a.attrs.ipCidrRange)
			if (cidr) props.cidr = cidr
			if (region && !name.includes(region)) name = `${name} (${region})`
		}
		if (a.assetType === 'compute.googleapis.com/Network' && d.autoCreateSubnetworks === true) props.auto = 'true'
		const type = a.assetType === 'cloudfunctions.googleapis.com/Function' || a.assetType === 'cloudfunctions.googleapis.com/CloudFunction' ? 'cloudfunctions.googleapis.com/CloudFunction' : a.assetType
		const labels: Record<string, string> = { ...a.labels }
		const r = b.add({ id: a.name, type, name, region: region === 'global' ? undefined : region, tags: labels, props })
		for (const v of this.variants(pathOf(a.name))) b.alias(v, r.id)
		if (type === 'compute.googleapis.com/Network') b.alias(`network:${a.project}/${short}`, r.id)
		if (type === 'storage.googleapis.com/Bucket') {
			b.alias(short, r.id)
			b.alias(`projects/_/buckets/${short}`, r.id)
			b.alias(`gs://${short}`, r.id)
		}
		if (type === 'pubsub.googleapis.com/Topic') b.alias(short, r.id)
		if (type === 'sqladmin.googleapis.com/Instance') {
			const conn = asStr(d.connectionName) ?? (a.project && region ? `${a.project}:${region}:${short}` : undefined)
			b.alias(conn, r.id)
			for (const ip of asArr(d.ipAddresses)) b.alias(asStr(asObj(ip).ipAddress), r.id)
		}
		if (type === 'redis.googleapis.com/Instance') b.alias(asStr(d.host), r.id)
		const url = asStr(asObj(d.status).url) ?? asStr(d.uri) ?? asStr(asObj(d.httpsTrigger).url) ?? asStr(asObj(d.serviceConfig).uri)
		if (url) b.alias(hostOf(url), r.id)
		for (const u of asArr(d.urls)) if (typeof u === 'string') b.alias(hostOf(u), r.id)
		if (type === 'compute.googleapis.com/Instance') {
			const it = asStr(d.machineType)?.split('/').pop()
			if (it) r.props.machineType = it
		}
	}

	rel(from: string, ref: string | undefined, kind: RelationKind, label?: string, alt?: string[]) {
		if (ref) this.pending.push({ from, ref, kind, label, alt })
	}

	envVars(from: string, vars: [string, string][]) {
		const keys: string[] = []
		for (const [k, v] of vars) {
			if (!k) continue
			keys.push(k)
			const refs = gcpRefCandidates(v)
			if (refs.length) this.env.push({ from, key: k, refs })
		}
		if (keys.length) {
			const r = this.b.get(from)
			if (r) r.props.envKeys = keys.sort().join(',')
		}
	}

	relations(a: Asset) {
		const d = a.data
		const id = a.name
		const at = a.assetType
		const net = (n: string | undefined) => {
			if (!n) return undefined
			if (n.includes('/')) return refKey(n.startsWith('projects/') || n.startsWith('https://') || n.startsWith('//') ? n : `projects/${a.project}/${n}`)
			return `network:${a.project}/${n}`
		}
		const toCompute = (p: string | undefined) => (p && p.startsWith('projects/') ? `//compute.googleapis.com/${p}` : refKey(p))
		switch (at) {
			case 'compute.googleapis.com/Subnetwork':
				this.parents.push({ id, ref: net(asStr(d.network)) })
				break
			case 'compute.googleapis.com/Instance': {
				const nics = asArr(d.networkInterfaces).map(asObj)
				const subnets = nics.map((n) => asStr(n.subnetwork)).filter(Boolean) as string[]
				if (subnets.length === 1) this.parents.push({ id, ref: refKey(subnets[0]) })
				else if (nics[0]) this.parents.push({ id, ref: net(asStr(nics[0].network)) })
				// managed instance group members: the group manages them and sits where they are
				const createdBy = asArr(asObj(d.metadata).items).map(asObj).find((i) => i.key === 'created-by')
				const mig = asStr(createdBy?.value)
				if (mig) {
					const migRef = `//compute.googleapis.com/${mig}`
					this.rel(migRef, id, 'attached', 'member')
					this.migMembers.push({ mig: migRef, subnet: subnets.length === 1 ? refKey(subnets[0]) : undefined })
				}
				break
			}
			case 'compute.googleapis.com/InstanceGroupManager':
			case 'compute.googleapis.com/RegionInstanceGroupManager':
				this.b.alias(refKey(asStr(d.instanceGroup)), id)
				break
			case 'compute.googleapis.com/ForwardingRule':
			case 'compute.googleapis.com/GlobalForwardingRule': {
				this.rel(id, refKey(asStr(d.target)), 'routes')
				this.rel(id, refKey(asStr(d.backendService)), 'routes')
				const port = asStr(d.portRange)
				if (port) this.b.get(id)!.props.port = port
				const sub = asStr(d.subnetwork)
				if (sub) this.parents.push({ id, ref: refKey(sub) })
				const ip = asStr(d.IPAddress)
				if (ip) this.b.alias(ip, id)
				break
			}
			case 'compute.googleapis.com/TargetHttpsProxy':
			case 'compute.googleapis.com/TargetHttpProxy':
				this.rel(id, refKey(asStr(d.urlMap)), 'routes')
				break
			case 'compute.googleapis.com/TargetTcpProxy':
			case 'compute.googleapis.com/TargetSslProxy':
				this.rel(id, refKey(asStr(d.service)), 'routes')
				break
			case 'compute.googleapis.com/UrlMap': {
				const services = new Set<string>()
				const add = (s: unknown) => typeof s === 'string' && services.add(s)
				add(d.defaultService)
				for (const pm of asArr(d.pathMatchers).map(asObj)) {
					add(pm.defaultService)
					for (const pr of asArr(pm.pathRules).map(asObj)) add(pr.service)
					for (const rr of asArr(pm.routeRules).map(asObj)) add(rr.service)
				}
				for (const s of services) this.rel(id, refKey(s), 'routes')
				break
			}
			case 'compute.googleapis.com/BackendService':
			case 'compute.googleapis.com/RegionBackendService':
				for (const be of asArr(d.backends).map(asObj)) this.rel(id, refKey(asStr(be.group)), 'routes')
				break
			case 'compute.googleapis.com/BackendBucket':
				this.rel(id, asStr(d.bucketName), 'routes')
				break
			case 'compute.googleapis.com/NetworkEndpointGroup': {
				const run = asStr(asObj(d.cloudRun).service)
				const fn = asStr(asObj(d.cloudFunction).function)
				const region = regionOf(asStr(d.region)?.split('/').pop() ?? a.location)
				if (run) this.rel(id, `projects/${a.project}/locations/${region}/services/${run}`, 'routes')
				if (fn) this.rel(id, `projects/${a.project}/locations/${region}/functions/${fn}`, 'routes')
				if (asStr(asObj(d.appEngine).service) !== undefined || isObj(d.appEngine)) this.rel(id, `apps/${a.project}`, 'routes')
				break
			}
			case 'run.googleapis.com/Service':
			case 'run.googleapis.com/Job': {
				const tmpl = asObj(asObj(d.spec).template)
				const ann = { ...asObj(asObj(tmpl.metadata).annotations) }
				const v2 = asObj(d.template)
				const connector = asStr(ann['run.googleapis.com/vpc-access-connector']) ?? asStr(asObj(v2.vpcAccess).connector)
				if (connector) this.rel(id, connector.includes('/') ? connector : `projects/${a.project}/locations/${a.location}/connectors/${connector}`, 'uses', 'VPC access')
				const sql = (asStr(ann['run.googleapis.com/cloudsql-instances']) ?? '').split(',').filter(Boolean)
				for (const v of asArr(v2.volumes)) for (const i of asArr(asObj(asObj(v).cloudSqlInstance).instances)) if (typeof i === 'string') sql.push(i)
				for (const s of sql) this.rel(id, s.trim(), 'connects', 'Cloud SQL')
				const containers = [...asArr(asObj(tmpl.spec).containers), ...asArr(v2.containers), ...asArr(asObj(asObj(asObj(d.spec).template).spec).containers)].map(asObj)
				const vars: [string, string][] = []
				for (const c of containers) {
					for (const e of asArr(c.env).map(asObj)) {
						const key = asStr(e.name) ?? ''
						const secret = asStr(asObj(asObj(e.valueFrom).secretKeyRef).name) ?? asStr(asObj(asObj(e.valueSource).secretKeyRef).secret)
						if (secret) this.rel(id, secret.includes('/') ? secret : `projects/${a.project}/secrets/${secret}`, 'env', `env ${key}`)
						else vars.push([key, asStr(e.value) ?? ''])
					}
				}
				this.envVars(id, vars)
				break
			}
			case 'cloudfunctions.googleapis.com/CloudFunction':
			case 'cloudfunctions.googleapis.com/Function': {
				const et = asObj(d.eventTrigger)
				const res = asStr(et.resource)
				const topic = asStr(et.pubsubTopic)
				if (topic) this.relFrom(topic, id, 'triggers')
				if (res) {
					if (res.includes('/topics/')) this.relFrom(res, id, 'triggers')
					else if (res.includes('/buckets/')) this.relFrom(res, id, 'triggers')
					else if (res.includes('/databases/')) this.relFrom(res.replace(/\/documents\/.*$/, ''), id, 'triggers')
				}
				for (const ef of asArr(et.eventFilters).map(asObj)) if (asStr(ef.attribute) === 'bucket') this.relFrom(asStr(ef.value), id, 'triggers')
				const sc = asObj(d.serviceConfig)
				const conn = asStr(d.vpcConnector) ?? asStr(sc.vpcConnector)
				if (conn) this.rel(id, conn.includes('/') ? conn : `projects/${a.project}/locations/${a.location}/connectors/${conn}`, 'uses', 'VPC access')
				const envObj = { ...asObj(d.environmentVariables), ...asObj(sc.environmentVariables) }
				this.envVars(id, Object.entries(envObj).map(([k, v]) => [k, asStr(v) ?? '']))
				for (const s of [...asArr(d.secretEnvironmentVariables), ...asArr(sc.secretEnvironmentVariables)].map(asObj)) {
					const secret = asStr(s.secret)
					const project = asStr(s.projectId) ?? a.project
					if (secret) this.rel(id, `projects/${project}/secrets/${secret}`, 'env', `env ${asStr(s.key) ?? ''}`.trim(), [`projects/${a.project}/secrets/${secret}`])
				}
				// the backing Cloud Run service of a 2nd-gen function resolves to the function
				const backing = asStr(sc.service)
				if (backing) this.backing.set(backing.startsWith('//') ? backing : `//run.googleapis.com/${backing}`, id)
				break
			}
			case 'pubsub.googleapis.com/Subscription': {
				const topic = asStr(d.topic) ?? asStr(a.attrs.topic)
				const push = asStr(asObj(d.pushConfig).pushEndpoint)
				if (topic) this.relFrom(topic, id, 'subscribes')
				if (push) this.rel(id, hostOf(push), 'subscribes', 'push')
				const table = asStr(asObj(d.bigqueryConfig).table)
				if (table) {
					const [proj, rest] = table.split(':')
					const dataset = (rest ?? table).split('.')[0]
					this.rel(id, `projects/${proj}/datasets/${dataset}`, 'writes')
				}
				const bucket = asStr(asObj(d.cloudStorageConfig).bucket)
				if (bucket) this.rel(id, bucket, 'writes')
				break
			}
			case 'eventarc.googleapis.com/Trigger': {
				const dest = asObj(d.destination)
				const run = asObj(dest.cloudRun)
				const svc = asStr(run.service)
				const region = asStr(run.region) ?? a.location
				const target = svc ? `projects/${a.project}/locations/${region}/services/${svc}` : (asStr(dest.cloudFunction) ?? asStr(dest.workflow))
				const topic = asStr(asObj(asObj(d.transport).pubsub).topic)
				for (const ef of asArr(d.eventFilters).map(asObj)) {
					if (asStr(ef.attribute) === 'bucket') this.relFrom(asStr(ef.value), id, 'triggers')
				}
				if (topic) this.relFrom(topic, id, 'triggers')
				if (target) this.rel(id, target, 'triggers')
				break
			}
			case 'cloudscheduler.googleapis.com/Job': {
				const topic = asStr(asObj(d.pubsubTarget).topicName)
				const uri = asStr(asObj(d.httpTarget).uri)
				if (topic) this.rel(id, topic, 'publishes')
				if (uri) this.rel(id, hostOf(uri), 'invokes')
				break
			}
			case 'container.googleapis.com/Cluster': {
				const nc = asObj(d.networkConfig)
				const sub = asStr(nc.subnetwork) ?? (asStr(d.subnetwork) && `projects/${a.project}/regions/${regionOf(a.location)}/subnetworks/${asStr(d.subnetwork)}`)
				if (sub) this.parents.push({ id, ref: toCompute(sub) })
				else this.parents.push({ id, ref: net(asStr(nc.network) ?? asStr(d.network)) })
				const nodeCount = asStr(d.currentNodeCount)
				if (nodeCount) this.b.get(id)!.props.nodes = nodeCount
				break
			}
			case 'sqladmin.googleapis.com/Instance': {
				const pn = asStr(asObj(asObj(d.settings).ipConfiguration).privateNetwork)
				if (pn) this.parents.push({ id, ref: toCompute(pn) })
				const ver = asStr(d.databaseVersion)
				if (ver) this.b.get(id)!.props.engine = ver
				break
			}
			case 'redis.googleapis.com/Instance':
			case 'memcache.googleapis.com/Instance':
				this.parents.push({ id, ref: toCompute(asStr(d.authorizedNetwork)) })
				break
			case 'vpcaccess.googleapis.com/Connector': {
				const sub = asStr(asObj(d.subnet).name)
				if (sub) this.parents.push({ id, ref: toCompute(`projects/${asStr(asObj(d.subnet).projectId) ?? a.project}/regions/${regionOf(a.location)}/subnetworks/${sub}`) })
				else this.parents.push({ id, ref: net(asStr(d.network)) })
				break
			}
			case 'alloydb.googleapis.com/Cluster':
				this.parents.push({ id, ref: toCompute(asStr(asObj(d.networkConfig).network) ?? asStr(d.network)) })
				break
			case 'compute.googleapis.com/Router':
				this.parents.push({ id, ref: refKey(asStr(d.network)) })
				break
		}
	}

	/** Relation whose source is a reference (topic, bucket) and target is this asset. */
	relFrom(ref: string | undefined, to: string, kind: RelationKind) {
		if (!ref) return
		this.pendingRev.push({ ref, to, kind })
	}
	pendingRev: { ref: string; to: string; kind: RelationKind }[] = []

	resolveRev() {
		for (const p of this.pendingRev) {
			const from = this.b.resolve(refKey(p.ref)) ?? this.b.resolve(p.ref.replace(/^projects\/_\/buckets\//, ''))
			if (from) this.b.relate(from, p.to, p.kind)
		}
	}
}

/** Reference candidates inside an env value (topic paths, bucket names, URLs); only used for lookups. */
function gcpRefCandidates(v: string): string[] {
	const value = v.trim()
	if (value.length < 3 || value.length > 2048) return []
	const out = new Set<string>()
	if (/^[A-Za-z0-9._:/@-]+$/.test(value) && !/^(true|false|null|none|prod|production|dev|development|staging|test|info|debug|warn|error)$/i.test(value)) out.add(value)
	for (const m of value.matchAll(/projects\/[a-z0-9-]+\/(?:topics|subscriptions|secrets|locations\/[a-z0-9-]+\/[a-z]+)\/[A-Za-z0-9._-]+/g)) out.add(m[0])
	const gs = /^gs:\/\/([^/]+)/.exec(value)
	if (gs) out.add(gs[1])
	const host = hostOf(value)
	if (host) out.add(host)
	return [...out]
}

export function looksLikeGcp(input: unknown): boolean {
	const probe = (o: unknown): boolean => {
		if (Array.isArray(o)) return o.slice(0, 20).some(probe)
		if (!isObj(o)) return false
		if (o.kind === GCP_INVENTORY_KIND) return true
		if (Array.isArray(o.results)) return probe(o.results)
		if (Array.isArray(o.assets)) return probe(o.assets)
		return typeof o.name === 'string' && o.name.startsWith('//') && typeof o.assetType === 'string'
	}
	if (typeof input === 'string') return /"assetType"\s*:/.test(input) && /"name"\s*:\s*"\/\//.test(input)
	return probe(input)
}

export function normalizeGcp(input: unknown, opts: GcpNormalizeOptions = {}): CloudGraph {
	const n = new GcpNormalizer(opts)
	n.walk(input)
	return n.finish()
}
