/**
 * Live Azure collector: Azure Resource Graph queries over REST (read-only by
 * design: Resource Graph cannot change resources) plus the subscriptions list
 * when no subscription is given.
 *
 * HTTP is behind `AzureHttp` so tests inject a mock; `defaultAzureHttp`
 * lazily loads `@azure/identity` (`DefaultAzureCredential`: environment,
 * workload identity, managed identity, Azure CLI, Azure Developer CLI,
 * PowerShell) and only ever calls the two endpoints below.
 */

import { AZURE_INVENTORY_KIND, type AzureInventory } from './normalize'
import { importModule } from '../lazy'

export const ARM = 'https://management.azure.com'
export const RESOURCE_GRAPH_URL = `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01`
export const SUBSCRIPTIONS_URL = `${ARM}/subscriptions?api-version=2022-12-01`

export interface AzureHttp {
	/** Only RESOURCE_GRAPH_URL. */
	query(body: Record<string, unknown>): Promise<unknown>
	/** Only SUBSCRIPTIONS_URL (and its nextLink pages). */
	get(url: string): Promise<unknown>
}

export interface AzureCollectOptions {
	subscriptions?: string[]
	/** KQL predicate appended as `| where <kql>` (e.g. `resourceGroup =~ 'rg-shop-prod'`). */
	kql?: string
	maxPages?: number
	log?: (msg: string) => void
	signal?: AbortSignal
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validSubscription(id: string): boolean {
	return GUID.test(id)
}

export function resourceGraphQuery(kql?: string): string {
	const where = kql?.trim() ? `| where ${kql.trim().replace(/[\r\n]+/g, ' ')} ` : ''
	return `Resources ${where}| project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties, sku | order by id asc`
}

type Rec = Record<string, unknown>

export async function collectAzure(http: AzureHttp, opts: AzureCollectOptions = {}): Promise<AzureInventory> {
	const maxPages = opts.maxPages ?? 20
	const warnings: string[] = []
	const log = opts.log ?? (() => {})
	let subscriptions = opts.subscriptions ?? []
	for (const s of subscriptions) if (!validSubscription(s)) throw new Error(`invalid Azure subscription id "${s}"`)
	if (!subscriptions.length) {
		let url: string | undefined = SUBSCRIPTIONS_URL
		for (let i = 0; url && i < maxPages; i++) {
			const r = ((await http.get(url)) ?? {}) as Rec
			for (const s of Array.isArray(r.value) ? (r.value as Rec[]) : []) if (typeof s.subscriptionId === 'string' && s.state !== 'Disabled') subscriptions.push(s.subscriptionId)
			url = typeof r.nextLink === 'string' && r.nextLink.startsWith(`${ARM}/subscriptions?`) ? r.nextLink : undefined
		}
		if (!subscriptions.length) throw new Error('no Azure subscriptions visible to these credentials')
	}
	subscriptions = [...new Set(subscriptions)]
	log(`querying Resource Graph across ${subscriptions.length} subscription(s)`)
	const query = resourceGraphQuery(opts.kql)
	const rows: unknown[] = []
	let skipToken: string | undefined
	for (let i = 0; i < maxPages; i++) {
		if (opts.signal?.aborted) throw new Error('scan aborted')
		const options: Rec = { $top: 1000, resultFormat: 'objectArray' }
		if (skipToken) options.$skipToken = skipToken
		const r = ((await http.query({ subscriptions, query, options })) ?? {}) as Rec
		if (Array.isArray(r.data)) rows.push(...r.data)
		skipToken = typeof r.$skipToken === 'string' ? r.$skipToken : undefined
		if (!skipToken) break
		if (i === maxPages - 1) warnings.push(`Resource Graph: stopped after ${maxPages} pages of 1000 rows (raise maxPages or narrow with a KQL filter)`)
	}
	return { kind: AZURE_INVENTORY_KIND, version: 1, subscriptions, rows, warnings }
}

/** Token from DefaultAzureCredential; requests go through `fetchImpl` (the connector context's fetch). */
export async function defaultAzureHttp(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<AzureHttp> {
	type Credential = { getToken(scope: string, o?: { abortSignal?: AbortSignal }): Promise<{ token: string } | null> }
	const { DefaultAzureCredential } = (await importModule('@azure/identity')) as { DefaultAzureCredential: new () => Credential }
	const cred = new DefaultAzureCredential()
	const token = async () => {
		const t = await cred.getToken(`${ARM}/.default`, { abortSignal: signal })
		if (!t?.token) throw new Error('could not get an Azure token (az login, or set AZURE_* environment variables)')
		return t.token
	}
	const send = async (url: string, init: RequestInit) => {
		const res = await fetchImpl(url, { ...init, signal, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await token()}` } })
		if (!res.ok) {
			let msg = `${res.status}`
			try {
				const j = (await res.json()) as { error?: { code?: string; message?: string } }
				if (j.error) msg = `${res.status} ${j.error.code ?? ''} ${(j.error.message ?? '').slice(0, 160)}`.trim()
			} catch {
				// ignore
			}
			throw new Error(`Azure request failed: ${msg}`)
		}
		return res.json()
	}
	return {
		query: (body) => send(RESOURCE_GRAPH_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
		get: (url) => {
			if (!url.startsWith(`${ARM}/subscriptions?`)) throw new Error('refusing request outside the subscriptions list')
			return send(url, { method: 'GET' })
		},
	}
}
