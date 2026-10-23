/**
 * Azure Resource Graph rows → CloudGraph. Accepts `az graph query -q ... -o json`
 * (`{ count, data: [...] }` or a bare array), the REST response
 * (`{ data: [...] }` objectArray, or `{ columns, rows }` table format) and the
 * collector's inventory.
 *
 * Relations come from ids inside `properties`: NIC → subnet / VM, VNet
 * subnets, App Service plan, VNet integration, private endpoints, AKS node
 * subnets, load balancer / application gateway backends, Container Apps
 * environments, Event Grid system topic sources. ARM ids are compared
 * lowercased (they are case-insensitive).
 */

import { asArr, asObj, asStr, isObj, type Obj } from '../../../util'
import { GraphBuilder, ACCOUNT_TYPE, regionContainer, type CloudGraph } from '../model'

export const AZURE_INVENTORY_KIND = 'octo-draw/azure-inventory'

export interface AzureInventory {
	kind: typeof AZURE_INVENTORY_KIND
	version: 1
	subscriptions: string[]
	rows: unknown[]
	warnings?: string[]
}

export interface AzureNormalizeOptions {
	scopeName?: string
}

interface Row {
	id: string
	name: string
	type: string
	kind?: string
	location?: string
	resourceGroup?: string
	subscriptionId?: string
	tags: Record<string, string>
	properties: Obj
}

const lc = (s: string | undefined) => s?.toLowerCase()

/** `/subscriptions/x/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/nic/ipConfigurations/c` → the NIC id. */
function parentId(id: string, depth = 2): string {
	return id.split('/').slice(0, -depth).join('/')
}

function hostOf(s: string | undefined): string | undefined {
	if (!s) return undefined
	const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/?#\s]+)/i.exec(s)
	return (m?.[1] ?? (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s) ? s : undefined))?.toLowerCase()
}

class AzureNormalizer {
	b = new GraphBuilder('azure')
	rows = new Map<string, Row>()
	nicSubnet = new Map<string, string>()
	parents: { id: string; ref: string | undefined }[] = []
	subs = new Map<string, number>()

	constructor(private opts: AzureNormalizeOptions) {}

	walk(input: unknown): void {
		if (Array.isArray(input)) {
			for (const x of input) this.walk(x)
			return
		}
		if (!isObj(input)) return
		if (input.kind === AZURE_INVENTORY_KIND) {
			this.walk(input.rows)
			for (const w of asArr(input.warnings)) if (typeof w === 'string') this.b.warnings.push(w)
			return
		}
		if (Array.isArray(input.data)) return this.walk(input.data)
		if (isObj(input.data) && Array.isArray(input.data.columns)) return this.table(input.data)
		if (Array.isArray(input.columns) && Array.isArray(input.rows)) return this.table(input)
		if (Array.isArray(input.value)) return this.walk(input.value)
		const id = asStr(input.id)
		const type = asStr(input.type)
		if (id && type && id.startsWith('/subscriptions/')) this.row(input)
	}

	table(t: Obj) {
		const cols = asArr(t.columns).map((c) => asStr(asObj(c).name) ?? '')
		for (const r of asArr(t.rows)) {
			const o: Obj = {}
			asArr(r).forEach((v, i) => (o[cols[i]] = v))
			this.walk(o)
		}
	}

	row(o: Obj) {
		const id = lc(asStr(o.id))!
		let type = lc(asStr(o.type))!
		const kind = lc(asStr(o.kind))
		if (type === 'microsoft.web/sites' && kind?.includes('functionapp')) type = 'microsoft.web/sites/functionapp'
		const tags: Record<string, string> = {}
		for (const [k, v] of Object.entries(asObj(o.tags))) tags[k] = asStr(v) ?? ''
		const sub = asStr(o.subscriptionId) ?? /^\/subscriptions\/([^/]+)/.exec(id)?.[1]
		const row: Row = { id, name: asStr(o.name) ?? id.split('/').pop()!, type, kind, location: lc(asStr(o.location)), resourceGroup: asStr(o.resourceGroup), subscriptionId: sub, tags, properties: asObj(o.properties) }
		this.rows.set(id, row)
	}

	finish(): CloudGraph {
		const b = this.b
		for (const r of this.rows.values()) if (r.subscriptionId) this.subs.set(r.subscriptionId, (this.subs.get(r.subscriptionId) ?? 0) + 1)
		const subs = [...this.subs.keys()]
		const multi = subs.length > 1
		const scope = multi ? 'tenant' : (subs[0] ?? 'unknown')
		b.scope = scope
		b.scopeName = this.opts.scopeName ?? (multi ? 'Azure tenant' : `Azure subscription ${scope}`)
		b.add({ id: scope, type: ACCOUNT_TYPE, name: b.scopeName })
		if (multi) for (const s of subs) b.add({ id: `subscription:${s}`, type: ACCOUNT_TYPE, name: `subscription ${s}`, parent: scope })
		const subContainer = (s: string | undefined) => (multi && s ? `subscription:${s}` : scope)

		for (const r of this.rows.values()) this.add(r)
		for (const r of this.rows.values()) this.relations(r)

		for (const p of this.parents) b.setParent(p.id, lc(p.ref))
		for (const r of b.build().resources) {
			if (r.type === ACCOUNT_TYPE || r.parent) continue
			const row = this.rows.get(r.id)
			r.parent = regionContainer(b, subContainer(row?.subscriptionId), r.region)
		}
		const g = b.build()
		if (!this.rows.size) g.warnings.push('no Azure Resource Graph rows recognised in the input')
		return g
	}

	add(r: Row) {
		const b = this.b
		const p = r.properties
		const props: Record<string, string> = {}
		if (r.resourceGroup) props.resourceGroup = r.resourceGroup
		const region = r.location && r.location !== 'global' ? r.location : undefined
		if (r.type === 'microsoft.sql/servers/databases') {
			// databases are drawn as their server
			b.alias(r.id, parentId(r.id))
			return
		}
		if (r.type === 'microsoft.network/virtualnetworks') {
			const cidr = asArr(asObj(p.addressSpace).addressPrefixes).map(asStr).filter(Boolean).join(', ')
			if (cidr) props.cidr = cidr
		}
		b.add({ id: r.id, type: r.type, name: r.name, region, tags: r.tags, props })
		b.alias(r.id, r.id)
		if (r.type === 'microsoft.network/virtualnetworks') {
			for (const s of asArr(p.subnets).map(asObj)) {
				const sid = lc(asStr(s.id))
				if (!sid) continue
				const sp = asObj(s.properties)
				const cidr = asStr(sp.addressPrefix) ?? asArr(sp.addressPrefixes).map(asStr).filter(Boolean).join(', ')
				b.add({ id: sid, type: 'microsoft.network/virtualnetworks/subnets', name: asStr(s.name) ?? sid.split('/').pop()!, region, parent: r.id, props: cidr ? { cidr } : {} })
			}
		}
		for (const h of [asStr(p.defaultHostName), ...asArr(p.hostNames).map(asStr), asStr(p.fullyQualifiedDomainName), hostOf(asStr(p.documentEndpoint)), hostOf(asStr(p.vaultUri)), asStr(p.hostName), hostOf(asStr(p.gatewayUrl)), asStr(asObj(p.configuration).ingress && asObj(asObj(p.configuration).ingress).fqdn), asStr(p.latestRevisionFqdn)]) {
			if (h) b.alias(h.toLowerCase(), r.id)
		}
		const endpoints = asObj(p.primaryEndpoints)
		for (const v of Object.values(endpoints)) {
			const h = hostOf(asStr(v))
			if (h) b.alias(h, r.id)
		}
	}

	relations(r: Row) {
		const b = this.b
		const p = r.properties
		const id = r.id
		const ref = (x: unknown) => lc(asStr(x))
		switch (r.type) {
			case 'microsoft.network/networkinterfaces': {
				const cfgs = asArr(p.ipConfigurations).map((c) => asObj(asObj(c).properties))
				const subnet = ref(asObj(cfgs[0]?.subnet).id)
				if (subnet) {
					this.nicSubnet.set(id, subnet)
					this.parents.push({ id, ref: subnet })
				}
				for (const c of cfgs) {
					const ip = asStr(c.privateIPAddress)
					if (ip) b.alias(ip, ref(asObj(p.virtualMachine).id) ?? id)
				}
				const vm = ref(asObj(p.virtualMachine).id)
				if (vm && subnet) this.parents.push({ id: vm, ref: subnet })
				if (vm) b.relate(id, vm, 'attached')
				break
			}
			case 'microsoft.compute/virtualmachines': {
				const nics = asArr(asObj(p.networkProfile).networkInterfaces).map((n) => ref(asObj(n).id)).filter(Boolean) as string[]
				for (const n of nics) {
					const row = this.rows.get(n)
					const sub = ref(asObj(asObj(asObj(asArr(row?.properties.ipConfigurations)[0]).properties).subnet).id)
					if (sub) {
						this.parents.push({ id, ref: sub })
						break
					}
				}
				const size = asStr(asObj(p.hardwareProfile).vmSize)
				if (size) b.get(id)!.props.size = size
				break
			}
			case 'microsoft.compute/virtualmachinescalesets': {
				const cfg = asArr(asObj(asObj(p.virtualMachineProfile).networkProfile).networkInterfaceConfigurations).map(asObj)[0]
				const sub = ref(asObj(asObj(asObj(asArr(asObj(cfg?.properties).ipConfigurations)[0]).properties).subnet).id)
				if (sub) this.parents.push({ id, ref: sub })
				break
			}
			case 'microsoft.web/sites':
			case 'microsoft.web/sites/functionapp': {
				const plan = ref(p.serverFarmId)
				if (plan) b.relate(id, plan, 'runs-on')
				const sub = ref(p.virtualNetworkSubnetId)
				if (sub) this.parents.push({ id, ref: sub })
				break
			}
			case 'microsoft.network/privateendpoints': {
				const sub = ref(asObj(p.subnet).id)
				if (sub) this.parents.push({ id, ref: sub })
				for (const c of [...asArr(p.privateLinkServiceConnections), ...asArr(p.manualPrivateLinkServiceConnections)]) {
					const target = ref(asObj(asObj(c).properties).privateLinkServiceId)
					const groups = asArr(asObj(asObj(c).properties).groupIds).map(asStr).filter(Boolean).join(', ')
					if (target) b.relate(id, target, 'private-link', groups || undefined)
				}
				break
			}
			case 'microsoft.containerservice/managedclusters': {
				const subs = [...new Set(asArr(p.agentPoolProfiles).map((a) => ref(asObj(a).vnetSubnetID)).filter(Boolean))] as string[]
				if (subs.length === 1) this.parents.push({ id, ref: subs[0] })
				else if (subs.length > 1) this.parents.push({ id, ref: parentId(subs[0]) })
				const nodes = asArr(p.agentPoolProfiles).reduce<number>((n, a) => n + (Number(asObj(a).count) || 0), 0)
				if (nodes) b.get(id)!.props.nodes = String(nodes)
				break
			}
			case 'microsoft.network/applicationgateways': {
				const sub = ref(asObj(asObj(asArr(p.gatewayIPConfigurations)[0]).properties).subnet && asObj(asObj(asObj(asArr(p.gatewayIPConfigurations)[0]).properties).subnet).id)
				if (sub) this.parents.push({ id, ref: sub })
				for (const pool of asArr(p.backendAddressPools).map((x) => asObj(asObj(x).properties))) {
					for (const a of asArr(pool.backendAddresses).map(asObj)) {
						const t = lc(asStr(a.fqdn) ?? asStr(a.ipAddress))
						if (t) b.relate(id, t, 'routes')
					}
					for (const c of asArr(pool.backendIPConfigurations)) {
						const nic = ref(asObj(c).id)
						if (nic) b.relate(id, parentId(nic), 'routes')
					}
				}
				break
			}
			case 'microsoft.network/loadbalancers': {
				for (const fe of asArr(p.frontendIPConfigurations).map((x) => asObj(asObj(x).properties))) {
					const sub = ref(asObj(fe.subnet).id)
					if (sub) {
						this.parents.push({ id, ref: sub })
						break
					}
				}
				for (const pool of asArr(p.backendAddressPools).map((x) => asObj(asObj(x).properties))) {
					for (const c of asArr(pool.backendIPConfigurations)) {
						const nic = ref(asObj(c).id)
						if (nic) b.relate(id, parentId(nic), 'routes')
					}
				}
				break
			}
			case 'microsoft.network/frontdoors':
				for (const pool of asArr(p.backendPools).map((x) => asObj(asObj(x).properties))) {
					for (const be of asArr(pool.backends).map(asObj)) {
						const t = lc(asStr(be.address))
						if (t) b.relate(id, t, 'origin')
					}
				}
				break
			case 'microsoft.app/containerapps': {
				const env = ref(p.managedEnvironmentId ?? p.environmentId)
				if (env) b.relate(id, env, 'runs-on')
				break
			}
			case 'microsoft.app/managedenvironments': {
				const sub = ref(asObj(p.vnetConfiguration).infrastructureSubnetId)
				if (sub) this.parents.push({ id, ref: sub })
				break
			}
			case 'microsoft.apimanagement/service': {
				const sub = ref(asObj(p.virtualNetworkConfiguration).subnetResourceId)
				if (sub) this.parents.push({ id, ref: sub })
				break
			}
			case 'microsoft.cache/redis': {
				const sub = ref(p.subnetId)
				if (sub) this.parents.push({ id, ref: sub })
				break
			}
			case 'microsoft.dbforpostgresql/flexibleservers':
			case 'microsoft.dbformysql/flexibleservers': {
				const sub = ref(asObj(p.network).delegatedSubnetResourceId)
				if (sub) this.parents.push({ id, ref: sub })
				break
			}
			case 'microsoft.eventgrid/systemtopics': {
				const src = ref(p.source)
				if (src) b.relate(src, id, 'publishes')
				break
			}
			case 'microsoft.network/bastionhosts':
			case 'microsoft.network/azurefirewalls':
			case 'microsoft.network/virtualnetworkgateways': {
				const sub = ref(asObj(asObj(asObj(asArr(p.ipConfigurations)[0]).properties).subnet).id)
				if (sub) this.parents.push({ id, ref: sub })
				break
			}
		}
	}
}

export function looksLikeAzure(input: unknown): boolean {
	const probe = (o: unknown): boolean => {
		if (Array.isArray(o)) return o.slice(0, 20).some(probe)
		if (!isObj(o)) return false
		if (o.kind === AZURE_INVENTORY_KIND) return true
		if (Array.isArray(o.data)) return probe(o.data)
		if (isObj(o.data) && Array.isArray(o.data.columns)) return true
		if (Array.isArray(o.value)) return probe(o.value)
		return typeof o.id === 'string' && o.id.toLowerCase().startsWith('/subscriptions/') && typeof o.type === 'string'
	}
	return probe(input)
}

export function normalizeAzure(input: unknown, opts: AzureNormalizeOptions = {}): CloudGraph {
	const n = new AzureNormalizer(opts)
	n.walk(input)
	return n.finish()
}
