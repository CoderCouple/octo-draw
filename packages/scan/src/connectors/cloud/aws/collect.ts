/**
 * Live AWS collector: read-only Describe / List / Get / Search calls that
 * produce an `AwsInventory` (raw responses), which `normalizeAws` reads.
 *
 * The SDK is behind the `AwsApi` interface so tests inject a mock and nothing
 * loads the AWS SDK unless a live scan runs (`defaultAwsApi` imports the
 * clients lazily). Every call goes through `assertReadOnlyAws`, which only lets
 * through the operations listed in `AWS_READ_OPERATIONS`.
 */

import { isSecretKey } from '../model'
import { importModule } from '../lazy'
import { AWS_INVENTORY_KIND, type AwsInventory, type AwsInventoryResponse } from './normalize'

export type AwsService =
	| 'sts'
	| 'resource-explorer-2'
	| 'tagging'
	| 'ec2'
	| 'lambda'
	| 'elbv2'
	| 'ecs'
	| 'rds'
	| 'elasticache'
	| 'apigatewayv2'
	| 'apigateway'
	| 'cloudfront'
	| 'sns'
	| 'eventbridge'
	| 'route53'

/** The only operations the collector may call. All are read-only. */
export const AWS_READ_OPERATIONS: Record<AwsService, readonly string[]> = {
	sts: ['GetCallerIdentity'],
	'resource-explorer-2': ['Search', 'GetDefaultView'],
	tagging: ['GetResources'],
	ec2: ['DescribeVpcs', 'DescribeSubnets', 'DescribeSecurityGroups', 'DescribeInstances', 'DescribeNatGateways', 'DescribeInternetGateways', 'DescribeVpcEndpoints'],
	lambda: ['ListFunctions', 'ListEventSourceMappings'],
	elbv2: ['DescribeLoadBalancers', 'DescribeTargetGroups', 'DescribeTargetHealth'],
	ecs: ['ListClusters', 'DescribeClusters', 'ListServices', 'DescribeServices', 'DescribeTaskDefinition'],
	rds: ['DescribeDBInstances', 'DescribeDBClusters'],
	elasticache: ['DescribeCacheClusters'],
	apigatewayv2: ['GetApis', 'GetIntegrations'],
	apigateway: ['GetRestApis', 'GetResources'],
	cloudfront: ['ListDistributions'],
	sns: ['ListSubscriptions'],
	eventbridge: ['ListRules', 'ListTargetsByRule'],
	route53: ['ListHostedZones', 'ListResourceRecordSets'],
}

const READ_PREFIX = /^(Describe|List|Get|Search)/

export function assertReadOnlyAws(service: AwsService, op: string) {
	if (!READ_PREFIX.test(op) || !AWS_READ_OPERATIONS[service]?.includes(op)) throw new Error(`refusing non-allowlisted AWS operation ${service}:${op}`)
}

export interface AwsApi {
	call(service: AwsService, region: string, op: string, input: Record<string, unknown>): Promise<Record<string, unknown>>
}

export interface AwsCollectOptions {
	/** Regions to scan (default: the profile / env region, else us-east-1). */
	regions?: string[]
	/** Max pages per paginated call (default 20). */
	maxPages?: number
	/** Stop adding describe calls for per-parent lookups beyond this many parents (default 50). */
	maxParents?: number
	log?: (msg: string) => void
	signal?: AbortSignal
}

type Rec = Record<string, unknown>
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** Env values are only needed to find references: secret-looking keys keep a value only when it is an ARN. */
export function scrubEnvValue(key: string, value: string): string {
	if (isSecretKey(key) && !value.startsWith('arn:')) return '[redacted]'
	// connection strings: keep the host, drop the credentials
	return value.replace(/(:\/\/)[^@/\s]*@/g, '$1')
}

function scrubLambda(resp: Rec): Rec {
	for (const fn of arr(resp.Functions)) {
		const env = (fn.Environment as Rec | undefined)?.Variables as Record<string, string> | undefined
		if (env) for (const k of Object.keys(env)) env[k] = scrubEnvValue(k, String(env[k]))
	}
	return resp
}

function scrubTaskDef(resp: Rec): Rec {
	const td = resp.taskDefinition as Rec | undefined
	for (const c of arr(td?.containerDefinitions)) for (const e of arr(c.environment)) e.value = scrubEnvValue(String(e.name ?? ''), String(e.value ?? ''))
	return resp
}

export async function collectAws(api: AwsApi, opts: AwsCollectOptions = {}): Promise<AwsInventory> {
	const regions = opts.regions?.length ? opts.regions : ['us-east-1']
	const maxPages = opts.maxPages ?? 20
	const maxParents = opts.maxParents ?? 50
	const responses: AwsInventoryResponse[] = []
	const warnings: string[] = []
	const log = opts.log ?? (() => {})

	const call = async (service: AwsService, region: string, op: string, input: Rec = {}): Promise<Rec | null> => {
		assertReadOnlyAws(service, op)
		if (opts.signal?.aborted) throw new Error('scan aborted')
		try {
			return await api.call(service, region, op, input)
		} catch (err) {
			const e = err as { name?: string; message?: string }
			// never echo request inputs; the SDK error name and message carry no credentials
			warnings.push(`${service}:${op} in ${region} failed: ${e.name ?? 'Error'}${e.message ? ` (${e.message.slice(0, 160)})` : ''}`)
			return null
		}
	}

	/** Pages through a call; `tokenIn` is the request field, `tokenOut` reads the next token from a response. */
	const paged = async (service: AwsService, region: string, op: string, input: Rec, tokenIn: string, tokenOut: (r: Rec) => unknown, ctx?: Record<string, string>, scrub?: (r: Rec) => Rec): Promise<Rec[]> => {
		const pages: Rec[] = []
		let token: unknown
		for (let i = 0; i < maxPages; i++) {
			const r = await call(service, region, op, token ? { ...input, [tokenIn]: token } : input)
			if (!r) break
			const clean = scrub ? scrub(r) : r
			pages.push(clean)
			responses.push({ region: region === 'global' ? undefined : region, op: `${service}:${op}`, context: ctx, data: stripMeta(clean) })
			token = tokenOut(r)
			if (!token) break
			if (i === maxPages - 1) warnings.push(`${service}:${op} in ${region}: stopped after ${maxPages} pages (raise maxPages for more)`)
		}
		return pages
	}

	const home = regions[0]
	const ident = await call('sts', home, 'GetCallerIdentity')
	if (!ident) throw new Error(`could not authenticate to AWS: ${warnings[warnings.length - 1] ?? 'no credentials'}`)
	const account = str(ident.Account)
	if (ident) responses.push({ op: 'sts:GetCallerIdentity', data: { Account: account, UserId: 'redacted' } })

	// breadth: Resource Explorer when an index/view exists, else the Tagging API per region
	const viaExplorer = await paged('resource-explorer-2', home, 'Search', { QueryString: '', MaxResults: 1000 }, 'NextToken', (r) => r.NextToken)
	const explorerArns = viaExplorer.flatMap((p) => arr(p.Resources)).map((r) => ({
		ResourceARN: r.Arn,
		Tags: arr(arr(r.Properties).find((x) => x.Name === 'tags')?.Data),
	}))
	if (explorerArns.length) {
		responses.splice(responses.length - viaExplorer.length, viaExplorer.length, { op: 'resource-explorer-2:Search', data: { ResourceTagMappingList: explorerArns } })
		log(`resource explorer: ${explorerArns.length} resources`)
	} else if (viaExplorer.length === 0) {
		// remove the Resource Explorer failure: the Tagging API fallback covers it
		const i = warnings.findIndex((w) => w.startsWith('resource-explorer-2:Search'))
		if (i >= 0) warnings.splice(i, 1)
	}

	// global services
	await paged('cloudfront', 'us-east-1', 'ListDistributions', {}, 'Marker', (r) => {
		const dl = r.DistributionList as Rec | undefined
		return dl?.IsTruncated ? dl.NextMarker : undefined
	}, undefined)
	const zones = (await paged('route53', 'us-east-1', 'ListHostedZones', {}, 'Marker', (r) => (r.IsTruncated ? r.NextMarker : undefined))).flatMap((p) => arr(p.HostedZones))
	for (const z of zones.slice(0, maxParents)) {
		const id = str(z.Id)
		if (!id) continue
		const r = await call('route53', 'us-east-1', 'ListResourceRecordSets', { HostedZoneId: id, MaxItems: 300 })
		if (r) {
			responses.push({ op: 'route53:ListResourceRecordSets', context: { HostedZoneId: id }, data: stripMeta(r) })
			if (r.IsTruncated) warnings.push(`hosted zone ${str(z.Name) ?? id}: only the first 300 records were read`)
		}
	}

	for (const region of regions) {
		log(`scanning ${region}`)
		await paged('tagging', region, 'GetResources', { ResourcesPerPage: 100 }, 'PaginationToken', (r) => r.PaginationToken)
		for (const op of ['DescribeVpcs', 'DescribeSubnets', 'DescribeSecurityGroups', 'DescribeInstances', 'DescribeNatGateways', 'DescribeInternetGateways', 'DescribeVpcEndpoints']) {
			await paged('ec2', region, op, {}, 'NextToken', (r) => r.NextToken)
		}
		await paged('lambda', region, 'ListFunctions', {}, 'Marker', (r) => r.NextMarker, undefined, scrubLambda)
		await paged('lambda', region, 'ListEventSourceMappings', {}, 'Marker', (r) => r.NextMarker)
		await paged('elbv2', region, 'DescribeLoadBalancers', {}, 'Marker', (r) => r.NextMarker)
		const tgs = (await paged('elbv2', region, 'DescribeTargetGroups', {}, 'Marker', (r) => r.NextMarker)).flatMap((p) => arr(p.TargetGroups))
		for (const tg of tgs.slice(0, maxParents)) {
			const arn = str(tg.TargetGroupArn)
			if (!arn || !arr(tg.LoadBalancerArns).length) continue
			const r = await call('elbv2', region, 'DescribeTargetHealth', { TargetGroupArn: arn })
			if (r) responses.push({ region, op: 'elbv2:DescribeTargetHealth', context: { TargetGroupArn: arn }, data: stripMeta(r) })
		}
		if (tgs.length > maxParents) warnings.push(`${region}: target health read for the first ${maxParents} of ${tgs.length} target groups`)

		const clusterArns = (await paged('ecs', region, 'ListClusters', {}, 'nextToken', (r) => r.nextToken)).flatMap((p) => arr(p.clusterArns) as unknown as string[])
		for (let i = 0; i < clusterArns.length; i += 100) {
			const r = await call('ecs', region, 'DescribeClusters', { clusters: clusterArns.slice(i, i + 100), include: ['TAGS'] })
			if (r) responses.push({ region, op: 'ecs:DescribeClusters', data: stripMeta(r) })
		}
		const taskDefs = new Set<string>()
		for (const cluster of clusterArns.slice(0, maxParents)) {
			const serviceArns = (await paged('ecs', region, 'ListServices', { cluster }, 'nextToken', (r) => r.nextToken)).flatMap((p) => arr(p.serviceArns) as unknown as string[])
			for (let i = 0; i < serviceArns.length; i += 10) {
				const r = await call('ecs', region, 'DescribeServices', { cluster, services: serviceArns.slice(i, i + 10), include: ['TAGS'] })
				if (!r) continue
				responses.push({ region, op: 'ecs:DescribeServices', data: stripMeta(r) })
				for (const s of arr(r.services)) if (str(s.taskDefinition)) taskDefs.add(str(s.taskDefinition)!)
			}
		}
		for (const td of [...taskDefs].slice(0, maxParents)) {
			const r = await call('ecs', region, 'DescribeTaskDefinition', { taskDefinition: td })
			if (r) responses.push({ region, op: 'ecs:DescribeTaskDefinition', data: stripMeta(scrubTaskDef(r)) })
		}

		await paged('rds', region, 'DescribeDBInstances', {}, 'Marker', (r) => r.Marker)
		await paged('rds', region, 'DescribeDBClusters', {}, 'Marker', (r) => r.Marker)
		await paged('elasticache', region, 'DescribeCacheClusters', { ShowCacheNodeInfo: true }, 'Marker', (r) => r.Marker)

		const apis = (await paged('apigatewayv2', region, 'GetApis', {}, 'NextToken', (r) => r.NextToken)).flatMap((p) => arr(p.Items))
		for (const a of apis.slice(0, maxParents)) {
			const id = str(a.ApiId)
			if (id) await paged('apigatewayv2', region, 'GetIntegrations', { ApiId: id }, 'NextToken', (r) => r.NextToken, { ApiId: id })
		}
		const rest = (await paged('apigateway', region, 'GetRestApis', { limit: 500 }, 'position', (r) => r.position)).flatMap((p) => arr(p.items))
		for (const a of rest.slice(0, maxParents)) {
			const id = str(a.id)
			if (id) await paged('apigateway', region, 'GetResources', { restApiId: id, embed: ['methods'], limit: 500 }, 'position', (r) => r.position, { RestApiId: id })
		}

		await paged('sns', region, 'ListSubscriptions', {}, 'NextToken', (r) => r.NextToken)
		const rules = (await paged('eventbridge', region, 'ListRules', {}, 'NextToken', (r) => r.NextToken)).flatMap((p) => arr(p.Rules))
		for (const rule of rules.slice(0, maxParents)) {
			const name = str(rule.Name)
			const arn = str(rule.Arn)
			if (!name) continue
			const r = await call('eventbridge', region, 'ListTargetsByRule', { Rule: name, EventBusName: str(rule.EventBusName) })
			// target Input / InputTransformer can hold anything: keep ids and ARNs only
			if (r) responses.push({ region, op: 'eventbridge:ListTargetsByRule', context: arn ? { RuleArn: arn } : { Rule: name }, data: { Targets: arr(r.Targets).map((t) => ({ Id: t.Id, Arn: t.Arn })) } })
		}
	}

	return { kind: AWS_INVENTORY_KIND, version: 1, account, regions, responses, warnings }
}

/** Drops the SDK's `$metadata` (request ids) from a response. */
function stripMeta(r: Rec): Rec {
	if (!('$metadata' in r)) return r
	const { $metadata: _m, ...rest } = r
	return rest
}

// ------------------------------------------------------------------ default (real SDK)

export interface AwsCredentialOptions {
	profile?: string
	/** Role to assume (read-only role in the target account). */
	roleArn?: string
	externalId?: string
	signal?: AbortSignal
}

type Ctor = new (...args: unknown[]) => { send(cmd: unknown, opts?: unknown): Promise<unknown> }

export const AWS_SDK_CLIENTS: Record<AwsService, { load: () => Promise<Record<string, unknown>>; client: string }> = {
	sts: { load: () => importModule('@aws-sdk/client-sts'), client: 'STSClient' },
	'resource-explorer-2': { load: () => importModule('@aws-sdk/client-resource-explorer-2'), client: 'ResourceExplorer2Client' },
	tagging: { load: () => importModule('@aws-sdk/client-resource-groups-tagging-api'), client: 'ResourceGroupsTaggingAPIClient' },
	ec2: { load: () => importModule('@aws-sdk/client-ec2'), client: 'EC2Client' },
	lambda: { load: () => importModule('@aws-sdk/client-lambda'), client: 'LambdaClient' },
	elbv2: { load: () => importModule('@aws-sdk/client-elastic-load-balancing-v2'), client: 'ElasticLoadBalancingV2Client' },
	ecs: { load: () => importModule('@aws-sdk/client-ecs'), client: 'ECSClient' },
	rds: { load: () => importModule('@aws-sdk/client-rds'), client: 'RDSClient' },
	elasticache: { load: () => importModule('@aws-sdk/client-elasticache'), client: 'ElastiCacheClient' },
	apigatewayv2: { load: () => importModule('@aws-sdk/client-apigatewayv2'), client: 'ApiGatewayV2Client' },
	apigateway: { load: () => importModule('@aws-sdk/client-api-gateway'), client: 'APIGatewayClient' },
	cloudfront: { load: () => importModule('@aws-sdk/client-cloudfront'), client: 'CloudFrontClient' },
	sns: { load: () => importModule('@aws-sdk/client-sns'), client: 'SNSClient' },
	eventbridge: { load: () => importModule('@aws-sdk/client-eventbridge'), client: 'EventBridgeClient' },
	route53: { load: () => importModule('@aws-sdk/client-route-53'), client: 'Route53Client' },
}

/**
 * Real SDK-backed API using the standard credential chain (env vars, shared
 * config / credentials files and profiles, SSO, process credentials, container
 * and instance roles), optionally assuming `roleArn`. Credentials never leave
 * the SDK: nothing here logs or returns them.
 */
export async function defaultAwsApi(opts: AwsCredentialOptions = {}): Promise<AwsApi> {
	type Provider = (o: Record<string, unknown>) => unknown
	const cp = (await importModule('@aws-sdk/credential-providers')) as { fromNodeProviderChain: Provider; fromTemporaryCredentials: Provider }
	const base = cp.fromNodeProviderChain(opts.profile ? { profile: opts.profile } : {})
	const credentials = opts.roleArn
		? cp.fromTemporaryCredentials({
				masterCredentials: base,
				params: { RoleArn: opts.roleArn, RoleSessionName: 'octo-draw-scan', DurationSeconds: 900, ...(opts.externalId ? { ExternalId: opts.externalId } : {}) },
			})
		: base
	const clients = new Map<string, { send(cmd: unknown, o?: unknown): Promise<unknown> }>()
	return {
		async call(service, region, op, input) {
			assertReadOnlyAws(service, op)
			const spec = AWS_SDK_CLIENTS[service]
			const mod = await spec.load()
			const key = `${service}/${region}`
			let client = clients.get(key)
			if (!client) {
				const C = mod[spec.client] as Ctor
				client = new C({ region, credentials, maxAttempts: 4 })
				clients.set(key, client)
			}
			const Cmd = mod[`${op}Command`] as (new (input: unknown) => unknown) | undefined
			if (!Cmd) throw new Error(`unknown AWS operation ${service}:${op}`)
			return (await client.send(new Cmd(input), { abortSignal: opts.signal })) as Record<string, unknown>
		},
	}
}

/** Region from the environment (`AWS_REGION` / `AWS_DEFAULT_REGION`). */
export function envRegion(env: Record<string, string | undefined>): string | undefined {
	return env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined
}
