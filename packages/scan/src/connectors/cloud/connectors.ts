/**
 * AWS / Google Cloud / Azure connectors.
 *
 * Inputs:
 *   aws:                         default credential chain, env / profile region
 *   aws:prod@us-east-1,eu-west-1 profile `prod`, two regions (`aws:us-east-1` = region only)
 *   gcp:my-project               also gcp:folders/123, gcp:organizations/456
 *   azure:<subscription-id>      several comma-separated; `azure:` = every visible subscription
 *   aws:./export.json            offline import (also gcp:/azure:, or a bare `*.json` path:
 *                                the provider is detected from the content)
 *
 * Options (`ref.options`, e.g. from `POST /api/scan`): `regions`, `profile`,
 * `roleArn`, `externalId` (AWS); `scope` (GCP); `subscriptions`, `kql` (Azure);
 * `export` (export JSON as text or object, no file needed); `maxNodesPerPage`,
 * `maxPages`, `title`; `allowFiles: false` refuses file paths (servers).
 *
 * Collectors and SDKs load lazily, only for live scans. Credentials stay in the
 * SDKs: results carry the diagram, counts and warnings, never secrets.
 */

import { ConnectorError, type Connector, type ConnectorContext, type ConnectorResult, type SourceKind, type SourceRef } from '../types'
import type { CloudProvider } from './model'
import { cloudExportToOcto, detectCloudExport, parseExportText } from './pipeline'
import { importModule } from './lazy'
import type { AwsApi } from './aws/collect'
import type { GcpHttp } from './gcp/collect'
import type { AzureHttp } from './azure/collect'

const PROVIDER_NAME: Record<CloudProvider, string> = { aws: 'AWS', gcp: 'Google Cloud', azure: 'Azure' }
const PROVIDER_ARTICLE: Record<CloudProvider, string> = { aws: 'an AWS', gcp: 'a Google Cloud', azure: 'an Azure' }
const REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d$/
const PROFILE_RE = /^[A-Za-z0-9_.+=-]{1,64}$/
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Injected clients (tests); the defaults load the real SDKs on first use. */
export interface CloudClientFactories {
	aws?: (o: { profile?: string; roleArn?: string; externalId?: string; signal?: AbortSignal }) => Promise<AwsApi>
	gcp?: (o: { signal?: AbortSignal }) => Promise<GcpHttp>
	azure?: (o: { fetch: typeof fetch; signal?: AbortSignal }) => Promise<AzureHttp>
	/** File reader for offline imports (default: node:fs). */
	readFile?: (path: string) => Promise<string>
}

const isJsonPath = (s: string) => /\.(json|ndjson|jsonl)$/i.test(s) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)
/** No `scheme:` prefix (a Windows drive letter is fine). */
const isBare = (s: string) => !/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[a-z]:[\\/]/i.test(s)

function fileRef(kind: SourceKind, path: string, detect = false): SourceRef {
	return { kind, id: path, options: { file: path, ...(detect ? { detect: true } : {}) } }
}

/** `aws:...` */
export function parseAwsInput(input: string): SourceRef | null {
	const t = input.trim()
	if (!/^aws:/i.test(t)) {
		// a bare export path: the AWS connector claims it and detects the provider on scan
		if (isBare(t) && isJsonPath(t)) return fileRef(hintKind(t), t, true)
		return null
	}
	const rest = t.slice(4).trim()
	if (!rest) return { kind: 'aws', id: 'default', options: {} }
	if (isJsonPath(rest.split(',')[0])) return fileRef('aws', rest)
	const [left, right] = rest.includes('@') ? rest.split('@', 2) : REGION_RE.test(rest.split(',')[0]) ? ['', rest] : [rest, '']
	const regions = right.split(',').map((s) => s.trim()).filter(Boolean)
	if (regions.some((r) => !REGION_RE.test(r))) return null
	if (left && !PROFILE_RE.test(left)) return null
	const options: Record<string, unknown> = {}
	if (left) options.profile = left
	if (regions.length) options.regions = regions
	return { kind: 'aws', id: left || 'default', ref: regions.join(',') || undefined, options }
}

/** `gcp:...` */
export function parseGcpInput(input: string): SourceRef | null {
	const t = input.trim()
	if (!/^(gcp|gcloud):/i.test(t)) return null
	const rest = t.slice(t.indexOf(':') + 1).trim()
	if (!rest) return null
	if (isJsonPath(rest.split(',')[0])) return fileRef('gcp', rest)
	const scope = /^(projects|folders|organizations)\//.test(rest) ? rest : `projects/${rest}`
	if (!/^(projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]|folders\/\d{1,20}|organizations\/\d{1,20})$/.test(scope)) return null
	return { kind: 'gcp', id: scope.replace(/^projects\//, ''), options: { scope } }
}

/** `azure:...` */
export function parseAzureInput(input: string): SourceRef | null {
	const t = input.trim()
	if (!/^(azure|az):/i.test(t)) return null
	const rest = t.slice(t.indexOf(':') + 1).trim()
	if (!rest) return { kind: 'azure', id: 'all', options: {} }
	if (isJsonPath(rest.split(',')[0])) return fileRef('azure', rest)
	const subs = rest.split(',').map((s) => s.trim()).filter(Boolean)
	if (!subs.length || subs.some((s) => !GUID.test(s))) return null
	return { kind: 'azure', id: subs.join(','), options: { subscriptions: subs } }
}

function hintKind(path: string): SourceKind {
	const base = path.split(/[\\/]/).pop()!.toLowerCase()
	if (/gcp|gcloud|google|asset/.test(base)) return 'gcp'
	if (/azure|az-|resource-graph|arg/.test(base)) return 'azure'
	return 'aws'
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined)
const strs = (v: unknown): string[] | undefined => {
	if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean)
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && !!x.trim())
	return undefined
}

async function defaultReadFile(path: string): Promise<string> {
	type Fs = { readFile(p: string, enc: 'utf8'): Promise<string>; stat(p: string): Promise<{ isFile(): boolean; size: number }> }
	const [{ readFile, stat }, { homedir }] = (await Promise.all([importModule('node:fs/promises'), importModule('node:os')])) as [Fs, { homedir(): string }]
	const p = path.startsWith('~/') ? homedir() + path.slice(1) : path
	const s = await stat(p)
	if (!s.isFile()) throw new ConnectorError(`not a file: ${path}`)
	if (s.size > 200 * 1024 * 1024) throw new ConnectorError(`export is too large (${Math.round(s.size / 1048576)} MB; limit 200 MB)`)
	return readFile(p, 'utf8')
}

/** Offline import: options.export, or one or more files (comma-separated). */
async function loadExport(ref: SourceRef, f: CloudClientFactories): Promise<{ data: unknown; label: string } | null> {
	const o = ref.options ?? {}
	if (o.export !== undefined) {
		const data = typeof o.export === 'string' ? parseExportText(o.export) : o.export
		if (data === undefined) throw new ConnectorError('the export is not valid JSON')
		return { data, label: 'uploaded export' }
	}
	const file = str(o.file)
	if (!file) return null
	if (o.allowFiles === false) throw new ConnectorError('file paths are not accepted here; upload the export instead', 403)
	const read = f.readFile ?? defaultReadFile
	const files = file.split(',').map((s) => s.trim()).filter(Boolean)
	const parts: unknown[] = []
	for (const p of files) {
		let text: string
		try {
			text = await read(p)
		} catch (err) {
			if (err instanceof ConnectorError) throw err
			throw new ConnectorError(`cannot read ${p}: ${(err as { code?: string }).code ?? 'error'}`, 404)
		}
		const data = parseExportText(text)
		// never echo file contents in errors
		if (data === undefined) throw new ConnectorError(`${p} is not JSON (expected a cloud inventory export)`)
		parts.push(data)
	}
	return { data: parts.length === 1 ? parts[0] : parts, label: files.map((p) => p.split(/[\\/]/).pop()).join(', ') }
}

function toResult(provider: CloudProvider, ref: SourceRef, out: NonNullable<ReturnType<typeof cloudExportToOcto>>, sourceNote: string, collectorWarnings: string[] = []): ConnectorResult {
	const regions = new Set(out.graph.resources.map((r) => r.region).filter(Boolean))
	const notes = [
		`${sourceNote}: ${out.stats.resources} resources (${out.stats.drawn} drawn) in ${regions.size} region${regions.size === 1 ? '' : 's'}`,
		`${out.stats.relations} relations, ${out.pages.length} page${out.pages.length === 1 ? '' : 's'}${out.stats.apps ? `, ${out.stats.apps} application page${out.stats.apps === 1 ? '' : 's'}` : ''}`,
	]
	const confidence = out.stats.drawn === 0 ? 0.1 : out.stats.relations > 0 ? 0.85 : 0.6
	// the source echoes only safe, small options (never the export body or credentials)
	const o = ref.options ?? {}
	const options: Record<string, unknown> = {}
	for (const k of ['regions', 'profile', 'roleArn', 'scope', 'subscriptions']) if (o[k] !== undefined) options[k] = o[k]
	if (o.file) options.file = String(o.file).split(',').map((p) => p.split(/[\\/]/).pop()).join(',')
	return {
		code: out.code,
		findings: [{ analyzer: provider, confidence, notes }],
		warnings: [...collectorWarnings, ...out.warnings],
		source: { kind: provider, id: ref.id, ref: ref.ref, options },
	}
}

function renderOpts(ref: SourceRef) {
	const o = ref.options ?? {}
	return { maxNodesPerPage: num(o.maxNodesPerPage), title: str(o.title) }
}

async function offline(kind: CloudProvider, ref: SourceRef, f: CloudClientFactories): Promise<ConnectorResult | null> {
	const loaded = await loadExport(ref, f)
	if (!loaded) return null
	const detected = detectCloudExport(loaded.data)
	if (!detected) throw new ConnectorError(`${loaded.label}: not a recognised AWS, Google Cloud or Azure export (see docs/CONNECTORS.md for the export commands)`)
	if (detected !== kind && !ref.options?.detect) throw new ConnectorError(`${loaded.label} looks like ${PROVIDER_ARTICLE[detected]} export, not ${PROVIDER_NAME[kind]} (use ${detected}:${String(ref.options?.file ?? 'file.json')})`)
	const out = cloudExportToOcto(loaded.data, { provider: detected, ...renderOpts(ref) })!
	return toResult(detected, ref, out, loaded.label)
}

export function createAwsConnector(f: CloudClientFactories = {}): Connector {
	return {
		kind: 'aws',
		parse: parseAwsInput,
		async scan(ref, ctx) {
			const off = await offline(ref.kind === 'aws' || ref.options?.detect ? 'aws' : (ref.kind as CloudProvider), ref, f)
			if (off) return off
			const o = ref.options ?? {}
			const { collectAws, defaultAwsApi, envRegion } = await import('./aws/collect')
			const regions = strs(o.regions) ?? [envRegion(ctx.env) ?? 'us-east-1']
			const profile = str(o.profile)
			const roleArn = str(o.roleArn)
			if (roleArn && !/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(roleArn)) throw new ConnectorError('roleArn must be an IAM role ARN')
			let api: AwsApi
			try {
				api = await (f.aws ?? defaultAwsApi)({ profile, roleArn, externalId: str(o.externalId), signal: ctx.signal })
			} catch (err) {
				throw new ConnectorError(`AWS credentials: ${(err as Error).message}`, 401)
			}
			let inv
			try {
				inv = await collectAws(api, { regions, maxPages: num(o.maxPages), log: ctx.log, signal: ctx.signal })
			} catch (err) {
				throw new ConnectorError(`AWS${profile ? ` (profile ${profile})` : ''}: ${(err as Error).message}`, 401)
			}
			const out = cloudExportToOcto(inv, { provider: 'aws', defaultRegion: regions[0], ...renderOpts(ref) })!
			return toResult('aws', ref, out, `account ${inv.account ?? 'unknown'}`, [])
		},
	}
}

export function createGcpConnector(f: CloudClientFactories = {}): Connector {
	return {
		kind: 'gcp',
		parse: parseGcpInput,
		async scan(ref, ctx) {
			const off = await offline('gcp', ref, f)
			if (off) return off
			const o = ref.options ?? {}
			const scope = str(o.scope) ?? (ref.id.includes('/') ? ref.id : `projects/${ref.id}`)
			const { collectGcp, defaultGcpHttp, validGcpScope } = await import('./gcp/collect')
			if (!validGcpScope(scope)) throw new ConnectorError(`invalid Google Cloud scope "${scope}"`)
			let http: GcpHttp
			try {
				http = await (f.gcp ?? ((x) => defaultGcpHttp(x.signal)))({ signal: ctx.signal })
			} catch (err) {
				throw new ConnectorError(`Google Cloud credentials: ${(err as Error).message} (run gcloud auth application-default login)`, 401)
			}
			const inv = await collectGcp(http, { scope, maxPages: num(o.maxPages), log: ctx.log, signal: ctx.signal })
			if (!inv.resources.length && !inv.assets.length) throw new ConnectorError(`Google Cloud: no assets returned for ${scope}: ${(inv.warnings ?? [])[0] ?? 'check permissions (roles/cloudasset.viewer)'}`, 403)
			const out = cloudExportToOcto(inv, { provider: 'gcp', scope: scope.replace(/^projects\//, ''), ...renderOpts(ref) })!
			return toResult('gcp', ref, out, scope)
		},
	}
}

export function createAzureConnector(f: CloudClientFactories = {}): Connector {
	return {
		kind: 'azure',
		parse: parseAzureInput,
		async scan(ref, ctx) {
			const off = await offline('azure', ref, f)
			if (off) return off
			const o = ref.options ?? {}
			const subscriptions = strs(o.subscriptions) ?? []
			const { collectAzure, defaultAzureHttp, validSubscription } = await import('./azure/collect')
			for (const s of subscriptions) if (!validSubscription(s)) throw new ConnectorError(`invalid Azure subscription id "${s}"`)
			let http: AzureHttp
			try {
				http = await (f.azure ?? ((x) => defaultAzureHttp(x.fetch, x.signal)))({ fetch: ctx.fetch, signal: ctx.signal })
			} catch (err) {
				throw new ConnectorError(`Azure credentials: ${(err as Error).message} (run az login)`, 401)
			}
			let inv
			try {
				inv = await collectAzure(http, { subscriptions, kql: str(o.kql), maxPages: num(o.maxPages), log: ctx.log, signal: ctx.signal })
			} catch (err) {
				throw new ConnectorError(`Azure: ${(err as Error).message}`, 502)
			}
			const out = cloudExportToOcto(inv, { provider: 'azure', ...renderOpts(ref) })!
			return toResult('azure', ref, out, `${inv.subscriptions.length} subscription${inv.subscriptions.length === 1 ? '' : 's'}`, [])
		},
	}
}

export const awsConnector = createAwsConnector()
export const gcpConnector = createGcpConnector()
export const azureConnector = createAzureConnector()
/** Register all three (`for (const c of cloudConnectors) registerConnector(c)`). */
export const cloudConnectors: readonly Connector[] = [awsConnector, gcpConnector, azureConnector]

export type { ConnectorContext }
