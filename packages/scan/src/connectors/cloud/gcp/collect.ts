/**
 * Live Google Cloud collector over the Cloud Asset Inventory REST API, GET only:
 *
 * - `{scope}:searchAllResources` for breadth (names, labels, locations),
 * - `{scope}/assets?contentType=RESOURCE` for full configuration of the
 *   relation-bearing types,
 * - `{scope}/assets?contentType=RELATIONSHIP` (best effort: needs Security
 *   Command Center Premium / Enterprise; failures become a warning).
 *
 * HTTP is behind `GcpHttp` so tests inject a mock; `defaultGcpHttp` lazily
 * loads `google-auth-library` (Application Default Credentials) with the
 * read-only `cloud-platform.read-only` scope.
 */

import { GCP_INVENTORY_KIND, type GcpInventory } from './normalize'
import { importModule } from '../lazy'

export interface GcpHttp {
	get(url: string): Promise<unknown>
}

export interface GcpCollectOptions {
	/** `projects/<id>`, `folders/<n>` or `organizations/<n>`. */
	scope: string
	maxPages?: number
	/** Asset types fetched with full data (default: RELATION_ASSET_TYPES). */
	assetTypes?: string[]
	relationships?: boolean
	log?: (msg: string) => void
	signal?: AbortSignal
}

export const GCP_API = 'https://cloudasset.googleapis.com/v1'
export const GCP_READ_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only'

/** Types whose configuration carries the references we draw. */
export const RELATION_ASSET_TYPES = [
	'compute.googleapis.com/Network',
	'compute.googleapis.com/Subnetwork',
	'compute.googleapis.com/Instance',
	'compute.googleapis.com/InstanceGroupManager',
	'compute.googleapis.com/RegionInstanceGroupManager',
	'compute.googleapis.com/ForwardingRule',
	'compute.googleapis.com/GlobalForwardingRule',
	'compute.googleapis.com/TargetHttpsProxy',
	'compute.googleapis.com/TargetHttpProxy',
	'compute.googleapis.com/UrlMap',
	'compute.googleapis.com/BackendService',
	'compute.googleapis.com/RegionBackendService',
	'compute.googleapis.com/BackendBucket',
	'compute.googleapis.com/NetworkEndpointGroup',
	'run.googleapis.com/Service',
	'run.googleapis.com/Job',
	'cloudfunctions.googleapis.com/CloudFunction',
	'cloudfunctions.googleapis.com/Function',
	'pubsub.googleapis.com/Subscription',
	'eventarc.googleapis.com/Trigger',
	'cloudscheduler.googleapis.com/Job',
	'container.googleapis.com/Cluster',
	'sqladmin.googleapis.com/Instance',
	'redis.googleapis.com/Instance',
	'vpcaccess.googleapis.com/Connector',
]

const SCOPE_RE = /^(projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]|folders\/\d{1,20}|organizations\/\d{1,20})$/

export function validGcpScope(scope: string): boolean {
	return SCOPE_RE.test(scope)
}

type Rec = Record<string, unknown>

export async function collectGcp(http: GcpHttp, opts: GcpCollectOptions): Promise<GcpInventory> {
	if (!validGcpScope(opts.scope)) throw new Error(`invalid Google Cloud scope "${opts.scope}" (projects/<id>, folders/<n> or organizations/<n>)`)
	const maxPages = opts.maxPages ?? 20
	const warnings: string[] = []
	const log = opts.log ?? (() => {})

	const pages = async (base: string, params: [string, string][], field: string, label: string, optional = false): Promise<unknown[]> => {
		const out: unknown[] = []
		let token = ''
		for (let i = 0; i < maxPages; i++) {
			if (opts.signal?.aborted) throw new Error('scan aborted')
			const q = new URLSearchParams(params)
			if (token) q.set('pageToken', token)
			let r: Rec
			try {
				r = ((await http.get(`${base}?${q}`)) ?? {}) as Rec
			} catch (err) {
				const e = err as { message?: string; status?: number; code?: number }
				if (!optional || out.length) warnings.push(`${label} failed: ${(e.message ?? 'error').slice(0, 160)}`)
				else warnings.push(`${label} unavailable (${e.status ?? e.code ?? 'error'}); relations come from resource configuration only`)
				break
			}
			const items = Array.isArray(r[field]) ? (r[field] as unknown[]) : []
			out.push(...items)
			token = typeof r.nextPageToken === 'string' ? r.nextPageToken : ''
			if (!token) break
			if (i === maxPages - 1) warnings.push(`${label}: stopped after ${maxPages} pages (raise maxPages for more)`)
		}
		return out
	}

	const scope = opts.scope
	log(`searching ${scope}`)
	const resources = await pages(`${GCP_API}/${scope}:searchAllResources`, [['pageSize', '500']], 'results', 'searchAllResources')
	const types = opts.assetTypes ?? RELATION_ASSET_TYPES
	const assets = await pages(`${GCP_API}/${scope}/assets`, [['contentType', 'RESOURCE'], ['pageSize', '1000'], ...types.map((t): [string, string] => ['assetTypes', t])], 'assets', 'assets.list RESOURCE')
	const relationships = opts.relationships === false ? [] : await pages(`${GCP_API}/${scope}/assets`, [['contentType', 'RELATIONSHIP'], ['pageSize', '1000']], 'assets', 'assets.list RELATIONSHIP', true)
	return { kind: GCP_INVENTORY_KIND, version: 1, scope, resources, assets, relationships, warnings }
}

/** Application Default Credentials (gcloud auth application-default login, GOOGLE_APPLICATION_CREDENTIALS, metadata server). */
export async function defaultGcpHttp(signal?: AbortSignal): Promise<GcpHttp> {
	type Client = { request(o: { url: string; method: 'GET'; signal?: AbortSignal }): Promise<{ data: unknown }> }
	const { GoogleAuth } = (await importModule('google-auth-library')) as { GoogleAuth: new (o: { scopes: string[] }) => { getClient(): Promise<Client> } }
	const auth = new GoogleAuth({ scopes: [GCP_READ_SCOPE] })
	const client = await auth.getClient()
	return {
		async get(url: string) {
			if (!url.startsWith(`${GCP_API}/`)) throw new Error('refusing request outside the Cloud Asset API')
			const r = await client.request({ url, method: 'GET', signal })
			return r.data
		},
	}
}
