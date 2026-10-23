/**
 * AWS inventory JSON → CloudGraph. Accepts, in any mix:
 *
 * - Resource Groups Tagging API `get-resources` output (`ResourceTagMappingList`): breadth.
 * - An AWS Config snapshot (`configurationItems`) or `select-resource-config` output (`Results`).
 * - Raw `describe-*` / `list-*` responses (one object, an array of them, a
 *   `{ region, responses: [...] }` bundle or the collector's inventory). A few
 *   per-parent calls need their parent added next to the response
 *   (`TargetGroupArn`, `Rule`, `ApiId`, `RestApiId`, `HostedZoneId`).
 *
 * Environment variables are read only to find references to other resources;
 * values are never stored, only variable names.
 */

import { asArr, asObj, asStr, isObj, type Obj } from '../../../util'
import { GraphBuilder, ACCOUNT_TYPE, isSecretKey, regionContainer, type CloudGraph } from '../model'
import { arnInfo, listenerToLb, queueUrlToArn, type ArnInfo } from './arn'

export const AWS_INVENTORY_KIND = 'octo-draw/aws-inventory'

export interface AwsInventoryResponse {
	region?: string
	/** `service:Operation`, informational. */
	op?: string
	/** Parent ids the response itself lacks (`TargetGroupArn`, `Rule`, `ApiId`, `RestApiId`, `HostedZoneId`). */
	context?: Record<string, string>
	data: unknown
}

/** What the live collector produces and `normalizeAws` reads back. */
export interface AwsInventory {
	kind: typeof AWS_INVENTORY_KIND
	version: 1
	account?: string
	regions: string[]
	responses: AwsInventoryResponse[]
	warnings?: string[]
}

export interface AwsNormalizeOptions {
	/** Region for responses that carry none (VPC describe calls). */
	defaultRegion?: string
	accountName?: string
}

const REGION_RE = /^[a-z]{2}(-gov|-iso[a-z]*)?-[a-z]+-\d$/

/** Field lookup tolerant of describe-API PascalCase and AWS Config camelCase. */
function f(o: unknown, key: string): unknown {
	if (!isObj(o)) return undefined
	if (key in o) return o[key]
	const camel = key[0].toLowerCase() + key.slice(1)
	return o[camel]
}
const fs = (o: unknown, key: string) => asStr(f(o, key))
const fa = (o: unknown, key: string) => asArr(f(o, key))

function tagsOf(o: unknown): Record<string, string> {
	const t = f(o, 'Tags') ?? f(o, 'TagList') ?? f(o, 'tags')
	const out: Record<string, string> = {}
	if (Array.isArray(t)) for (const x of t) {
		const k = fs(x, 'Key')
		if (k !== undefined) out[k] = fs(x, 'Value') ?? ''
	}
	else if (isObj(t)) for (const [k, v] of Object.entries(t)) out[k] = asStr(v) ?? ''
	return out
}

const azRegion = (az: string | undefined) => (az && /\d[a-z]$/.test(az) ? az.slice(0, -1) : undefined)

class AwsNormalizer {
	b = new GraphBuilder('aws')
	accounts = new Map<string, number>()
	region: string | undefined
	sgMembers = new Map<string, Set<string>>()
	sgRules: { target: string; source: string; port?: string }[] = []
	tgLb = new Map<string, string[]>()
	tgTargets: { tg: string; target: string }[] = []
	lbDns = new Map<string, string>()
	pendingParents: { id: string; ref: string; region?: string }[] = []
	pendingEnv: { from: string; key: string; refs: string[] }[] = []
	regions = new Set<string>()

	constructor(private opts: AwsNormalizeOptions) {
		this.region = opts.defaultRegion
	}

	noteAccount(a: string | undefined) {
		if (a && /^\d{12}$/.test(a)) this.accounts.set(a, (this.accounts.get(a) ?? 0) + 1)
	}

	/** Adds a resource from an ARN (or explicit info) and registers its aliases. */
	addArn(arn: string | undefined, extra: { name?: string; tags?: Record<string, string>; props?: Record<string, string>; region?: string } = {}): string | undefined {
		if (!arn) return undefined
		const info = arnInfo(arn)
		if (!info) return undefined
		return this.addInfo(info, arn, extra)
	}

	addInfo(info: ArnInfo, arn: string | undefined, extra: { name?: string; tags?: Record<string, string>; props?: Record<string, string>; region?: string } = {}): string {
		this.noteAccount(info.account)
		const region = info.global ? undefined : (info.region ?? extra.region ?? (info.type === 'AWS::S3::Bucket' ? this.region : undefined))
		const r = this.b.add({ id: info.id, type: info.type, name: extra.name ?? info.name, region, tags: extra.tags, props: extra.props })
		if (region) this.regions.add(region)
		if (arn) this.b.alias(arn, r.id)
		this.b.alias(info.id, r.id)
		if (info.type === 'AWS::Lambda::Function' || info.type === 'AWS::SQS::Queue' || info.type === 'AWS::SNS::Topic' || info.type === 'AWS::DynamoDB::Table' || info.type === 'AWS::S3::Bucket' || info.type === 'AWS::Kinesis::Stream' || info.type === 'AWS::SecretsManager::Secret' || info.type === 'AWS::StepFunctions::StateMachine' || info.type === 'AWS::ECS::Cluster') this.b.alias(info.name, r.id)
		return r.id
	}

	/** EC2-style resources keyed by short id. */
	addShort(type: string, id: string | undefined, extra: { name?: string; tags?: Record<string, string>; props?: Record<string, string>; region?: string; account?: string } = {}): string | undefined {
		if (!id) return undefined
		this.noteAccount(extra.account)
		const tags = extra.tags ?? {}
		const region = extra.region === 'global' ? undefined : (extra.region ?? this.region)
		if (region) this.regions.add(region)
		const r = this.b.add({ id, type, name: tags.Name || extra.name || id, region, tags, props: extra.props })
		this.b.alias(id, r.id)
		return r.id
	}

	attachSgs(resource: string | undefined, sgs: unknown[]) {
		if (!resource) return
		for (const sg of sgs) {
			const id = typeof sg === 'string' ? sg : (fs(sg, 'GroupId') ?? fs(sg, 'VpcSecurityGroupId') ?? fs(sg, 'SecurityGroupId'))
			if (!id) continue
			const set = this.sgMembers.get(id) ?? new Set<string>()
			set.add(resource)
			this.sgMembers.set(id, set)
		}
	}

	/** Places a resource in a single subnet, or in the VPC when it spans several. */
	place(id: string | undefined, subnets: (string | undefined)[], vpc: string | undefined) {
		if (!id) return
		const s = [...new Set(subnets.filter((x): x is string => !!x))]
		if (s.length === 1) this.pendingParents.push({ id, ref: s[0] })
		else if (vpc) this.pendingParents.push({ id, ref: vpc })
		else if (s.length > 1) this.pendingParents.push({ id, ref: `vpc-of:${s[0]}` })
	}

	envRefs(from: string | undefined, vars: [string, string][]) {
		if (!from) return
		const keys: string[] = []
		for (const [k, v] of vars) {
			keys.push(k)
			// secret-looking variables are only followed when they hold an ARN (a reference, not a secret)
			if (isSecretKey(k) && !v.startsWith('arn:')) continue
			const refs = refCandidates(v)
			if (refs.length) this.pendingEnv.push({ from, key: k, refs })
		}
		if (keys.length) {
			const r = this.b.get(from)
			if (r) r.props.envKeys = keys.sort().join(',')
		}
	}

	// ------------------------------------------------------------------ inputs

	walk(input: unknown, region?: string, context: Record<string, string> = {}) {
		const prev = this.region
		if (region) this.region = region
		try {
			if (Array.isArray(input)) {
				for (const x of input) this.walk(x, undefined, context)
				return
			}
			if (!isObj(input)) return
			if (input.kind === AWS_INVENTORY_KIND) {
				for (const r of asArr(input.responses)) {
					const o = asObj(r)
					this.walk(o.data, asStr(o.region), { ...context, ...asObj(o.context) } as Record<string, string>)
				}
				if (typeof input.account === 'string') this.noteAccount(input.account)
				for (const w of asArr(input.warnings)) if (typeof w === 'string') this.b.warnings.push(w)
				return
			}
			if (Array.isArray(input.responses)) {
				for (const x of input.responses) this.walk(x, asStr(input.region), context)
				return
			}
			const regionKeys = Object.keys(input).filter((k) => REGION_RE.test(k) || k === 'global')
			if (regionKeys.length && regionKeys.length === Object.keys(input).length) {
				for (const k of regionKeys) this.walk(input[k], k === 'global' ? undefined : k, context)
				return
			}
			const ctx = { ...context }
			for (const k of ['TargetGroupArn', 'Rule', 'RuleArn', 'ApiId', 'RestApiId', 'HostedZoneId', 'region', 'Region']) {
				const v = asStr(input[k])
				if (v) ctx[k] = v
			}
			if (ctx.region || ctx.Region) this.region = ctx.region ?? ctx.Region
			this.response(input, ctx)
		} finally {
			this.region = prev
		}
	}

	response(o: Obj, ctx: Record<string, string>) {
		if (Array.isArray(o.ResourceTagMappingList)) for (const m of o.ResourceTagMappingList) this.addArn(fs(m, 'ResourceARN'), { tags: tagsOf(m) })
		if (Array.isArray(o.configurationItems)) for (const ci of o.configurationItems) this.configItem(asObj(ci))
		if (Array.isArray(o.ConfigurationItems)) for (const ci of o.ConfigurationItems) this.configItem(asObj(ci))
		if (Array.isArray(o.Results)) {
			for (const s of o.Results) {
				try {
					const ci = typeof s === 'string' ? JSON.parse(s) : s
					if (isObj(ci)) this.configItem(ci)
				} catch {
					// skip unreadable rows
				}
			}
		}
		if (typeof o.Account === 'string' && typeof o.UserId === 'string') this.noteAccount(o.Account)
		if (Array.isArray(o.Vpcs)) for (const v of o.Vpcs) this.vpc(v)
		if (Array.isArray(o.Subnets)) for (const s of o.Subnets) this.subnet(s)
		if (Array.isArray(o.SecurityGroups) && o.SecurityGroups.some((g) => fs(g, 'GroupId'))) for (const g of o.SecurityGroups) this.securityGroup(g)
		if (Array.isArray(o.Reservations)) for (const r of o.Reservations) for (const i of fa(r, 'Instances')) this.instance(i)
		if (Array.isArray(o.Instances) && o.Instances.some((i) => fs(i, 'InstanceId'))) for (const i of o.Instances) this.instance(i)
		if (Array.isArray(o.NatGateways)) for (const n of o.NatGateways) this.natGateway(n)
		if (Array.isArray(o.InternetGateways)) for (const n of o.InternetGateways) this.igw(n)
		if (Array.isArray(o.VpcEndpoints)) for (const n of o.VpcEndpoints) this.vpcEndpoint(n)
		if (Array.isArray(o.Functions)) for (const fn of o.Functions) this.lambda(fn)
		if (Array.isArray(o.EventSourceMappings)) for (const m of o.EventSourceMappings) this.esm(m)
		if (Array.isArray(o.LoadBalancers)) for (const lb of o.LoadBalancers) this.loadBalancer(lb)
		if (Array.isArray(o.LoadBalancerDescriptions)) for (const lb of o.LoadBalancerDescriptions) this.classicLb(lb)
		if (Array.isArray(o.TargetGroups)) for (const tg of o.TargetGroups) this.targetGroup(tg)
		if (Array.isArray(o.TargetHealthDescriptions) && ctx.TargetGroupArn) for (const t of o.TargetHealthDescriptions) this.tgTargets.push({ tg: ctx.TargetGroupArn, target: fs(f(t, 'Target'), 'Id') ?? '' })
		if (Array.isArray(o.clusters) || Array.isArray(o.Clusters)) for (const c of fa(o, 'Clusters')) this.ecsOrOtherCluster(c)
		if (Array.isArray(o.clusterArns)) for (const a of o.clusterArns) this.addArn(asStr(a))
		if (Array.isArray(o.services)) for (const s of o.services) this.ecsService(s)
		if (isObj(o.taskDefinition)) this.taskDefinition(o.taskDefinition)
		if (Array.isArray(o.taskDefinitions)) for (const t of o.taskDefinitions) if (isObj(t)) this.taskDefinition(t)
		if (Array.isArray(o.DBInstances)) for (const d of o.DBInstances) this.dbInstance(d)
		if (Array.isArray(o.DBClusters)) for (const d of o.DBClusters) this.dbCluster(d)
		if (Array.isArray(o.CacheClusters)) for (const c of o.CacheClusters) this.cacheCluster(c)
		if (isObj(o.DistributionList)) for (const d of fa(o.DistributionList, 'Items')) this.distribution(d)
		if (Array.isArray(o.Topics)) for (const t of o.Topics) this.addArn(fs(t, 'TopicArn'))
		if (Array.isArray(o.Subscriptions)) for (const s of o.Subscriptions) this.subscription(s)
		if (Array.isArray(o.QueueUrls)) for (const u of o.QueueUrls) this.addArn(queueUrlToArn(asStr(u) ?? '') ?? undefined)
		if (Array.isArray(o.Rules)) for (const r of o.Rules) this.eventRule(r)
		if (Array.isArray(o.Targets) && (ctx.Rule || ctx.RuleArn)) for (const t of o.Targets) this.ruleTarget(ctx.RuleArn ?? ctx.Rule, t)
		if (Array.isArray(o.HostedZones)) for (const z of o.HostedZones) this.hostedZone(z)
		if (Array.isArray(o.ResourceRecordSets) && ctx.HostedZoneId) for (const r of o.ResourceRecordSets) this.record(ctx.HostedZoneId, r)
		if (Array.isArray(o.items)) {
			if (ctx.RestApiId && o.items.some((i) => isObj(i) && 'path' in i)) for (const r of o.items) this.restResource(ctx.RestApiId, r)
			else if (o.items.some((i) => isObj(i) && 'id' in i && ('apiKeySource' in i || 'endpointConfiguration' in i || 'createdDate' in i))) for (const a of o.items) this.restApi(a)
		}
		if (Array.isArray(o.Items)) {
			if (ctx.ApiId && o.Items.some((i) => isObj(i) && 'IntegrationType' in i)) for (const i of o.Items) this.v2Integration(ctx.ApiId, i)
			else if (o.Items.some((i) => isObj(i) && 'ApiId' in i && 'ProtocolType' in i)) for (const a of o.Items) this.v2Api(a)
		}
		if (Array.isArray(o.StateMachines)) for (const s of o.StateMachines) this.addArn(fs(s, 'StateMachineArn'), { name: fs(s, 'Name') })
		if (Array.isArray(o.Buckets)) for (const bk of o.Buckets) {
			const n = fs(bk, 'Name')
			if (n) this.addArn(`arn:aws:s3:::${n}`, { region: fs(bk, 'BucketRegion') })
		}
	}

	// ------------------------------------------------------------------ config

	configItem(ci: Obj) {
		const type = asStr(ci.resourceType)
		const rid = asStr(ci.resourceId)
		if (!type || !rid) return
		if (asStr(ci.configurationItemStatus) === 'ResourceDeleted' || asStr(ci.configurationItemStatus) === 'ResourceDeletedNotRecorded') return
		const region = asStr(ci.awsRegion)
		const account = asStr(ci.awsAccountId) ?? asStr(ci.accountId)
		this.noteAccount(account)
		const conf = typeof ci.configuration === 'string' ? safeJson(ci.configuration) : asObj(ci.configuration)
		const tags = tagsOf(ci)
		const name = asStr(ci.resourceName)
		const arn = asStr(ci.ARN) ?? asStr(ci.arn)
		const prevRegion = this.region
		if (region) this.region = region
		try {
			// reuse the describe extractors: Config configuration mirrors the describe shapes (camelCase)
			switch (type) {
				case 'AWS::EC2::VPC':
					return this.vpc({ ...conf, VpcId: rid, Tags: tags, OwnerId: account })
				case 'AWS::EC2::Subnet':
					return this.subnet({ ...conf, SubnetId: rid, Tags: tags, OwnerId: account })
				case 'AWS::EC2::SecurityGroup':
					return this.securityGroup({ ...conf, GroupId: rid, Tags: tags })
				case 'AWS::EC2::Instance':
					return this.instance({ ...conf, InstanceId: rid, Tags: tags })
				case 'AWS::EC2::NatGateway':
					return this.natGateway({ ...conf, NatGatewayId: rid, Tags: tags })
				case 'AWS::EC2::InternetGateway':
					return this.igw({ ...conf, InternetGatewayId: rid, Tags: tags })
				case 'AWS::Lambda::Function':
					return this.lambda({ ...conf, FunctionArn: arn, FunctionName: name ?? rid, Tags: tags })
				case 'AWS::ElasticLoadBalancingV2::LoadBalancer':
					return this.loadBalancer({ ...conf, LoadBalancerArn: arn ?? rid, Tags: tags })
				case 'AWS::RDS::DBInstance':
					return this.dbInstance({ ...conf, DBInstanceArn: arn, DBInstanceIdentifier: name ?? rid, Tags: tags })
				case 'AWS::RDS::DBCluster':
					return this.dbCluster({ ...conf, DBClusterArn: arn, DBClusterIdentifier: name ?? rid, Tags: tags })
				case 'AWS::ECS::Service':
					return this.ecsService({ ...conf, serviceArn: arn ?? rid, Tags: tags })
			}
			let id: string | undefined
			if (arn) id = this.addArn(arn, { tags, name })
			if (!id) {
				// types we know but whose ARN we could not parse: keep by resource id
				if (/^AWS::(IAM|KMS|Logs|CloudWatch|SSM|Config|CloudFormation|Backup|CertificateManager)::/.test(type)) return
				id = this.b.add({ id: arn ?? `${type}/${rid}`, type, name: name ?? rid, region, tags }).id
				this.b.alias(rid, id)
			}
			for (const rel of asArr(ci.relationships)) {
				const rn = asStr(asObj(rel).relationshipName) ?? asStr(asObj(rel).name) ?? ''
				const target = asStr(asObj(rel).resourceId)
				if (!target) continue
				if (/is contained in (vpc|subnet)/i.test(rn)) this.pendingParents.push({ id, ref: target })
				else if (/is associated with securitygroup/i.test(rn)) this.attachSgs(id, [target])
			}
		} finally {
			this.region = prevRegion
		}
	}

	// ------------------------------------------------------------------ EC2

	vpc(v: unknown) {
		const id = fs(v, 'VpcId')
		const tags = tagsOf(v)
		const props: Record<string, string> = {}
		const cidr = fs(v, 'CidrBlock')
		if (cidr) props.cidr = cidr
		if (f(v, 'IsDefault') === true) props.default = 'true'
		this.addShort('AWS::EC2::VPC', id, { tags, props, account: fs(v, 'OwnerId'), name: f(v, 'IsDefault') === true ? 'default VPC' : undefined })
	}

	subnet(s: unknown) {
		const id = fs(s, 'SubnetId')
		const az = fs(s, 'AvailabilityZone')
		const props: Record<string, string> = {}
		const cidr = fs(s, 'CidrBlock')
		if (cidr) props.cidr = cidr
		if (az) props.az = az
		const tags = tagsOf(s)
		const pub = f(s, 'MapPublicIpOnLaunch') === true || /public/i.test(tags.Name ?? '')
		props.public = pub ? 'true' : 'false'
		const region = azRegion(az) ?? this.region
		const r = this.addShort('AWS::EC2::Subnet', id, { tags, props, region, account: fs(s, 'OwnerId') })
		const vpc = fs(s, 'VpcId')
		if (r && vpc) {
			this.pendingParents.push({ id: r, ref: vpc })
			this.b.alias(`vpc-of:${r}`, vpc)
			// a VPC seen without a region learns it from its subnets
			const v = this.b.get(vpc)
			if (v && !v.region && region) v.region = region
		}
	}

	securityGroup(g: unknown) {
		const id = fs(g, 'GroupId')
		if (!id) return
		this.addShort('AWS::EC2::SecurityGroup', id, { name: fs(g, 'GroupName'), tags: tagsOf(g) })
		for (const perm of fa(g, 'IpPermissions')) {
			const from = f(perm, 'FromPort')
			const to = f(perm, 'ToPort')
			const port = typeof from === 'number' && from === to && from > 0 ? String(from) : undefined
			for (const pair of fa(perm, 'UserIdGroupPairs')) {
				const src = fs(pair, 'GroupId')
				if (src && src !== id) this.sgRules.push({ target: id, source: src, port })
			}
		}
	}

	instance(i: unknown) {
		const id = fs(i, 'InstanceId')
		const state = fs(f(i, 'State'), 'Name')
		if (state === 'terminated') return
		const az = fs(f(i, 'Placement'), 'AvailabilityZone')
		const props: Record<string, string> = {}
		const it = fs(i, 'InstanceType')
		if (it) props.instanceType = it
		if (state) props.state = state
		const r = this.addShort('AWS::EC2::Instance', id, { tags: tagsOf(i), props, region: azRegion(az) ?? this.region })
		this.place(r, [fs(i, 'SubnetId')], fs(i, 'VpcId'))
		this.attachSgs(r, fa(i, 'SecurityGroups'))
	}

	natGateway(n: unknown) {
		const id = fs(n, 'NatGatewayId')
		if (fs(n, 'State') === 'deleted') return
		const r = this.addShort('AWS::EC2::NatGateway', id, { tags: tagsOf(n) })
		this.place(r, [fs(n, 'SubnetId')], fs(n, 'VpcId'))
	}

	igw(n: unknown) {
		const id = fs(n, 'InternetGatewayId')
		const r = this.addShort('AWS::EC2::InternetGateway', id, { tags: tagsOf(n) })
		const vpc = fs(fa(n, 'Attachments')[0], 'VpcId')
		if (r && vpc) this.pendingParents.push({ id: r, ref: vpc })
	}

	vpcEndpoint(n: unknown) {
		const id = fs(n, 'VpcEndpointId')
		const svc = fs(n, 'ServiceName')
		const r = this.addShort('AWS::EC2::VPCEndpoint', id, { tags: tagsOf(n), name: svc ? `endpoint ${svc.split('.').pop()}` : undefined })
		this.place(r, fa(n, 'SubnetIds').map(asStr), fs(n, 'VpcId'))
	}

	// ------------------------------------------------------------------ compute

	lambda(fn: unknown) {
		const arn = fs(fn, 'FunctionArn')
		const name = fs(fn, 'FunctionName')
		const props: Record<string, string> = {}
		const rt = fs(fn, 'Runtime')
		if (rt) props.runtime = rt
		const handler = fs(fn, 'Handler')
		if (handler) props.handler = handler
		const mem = asStr(f(fn, 'MemorySize'))
		if (mem) props.memory = `${mem} MB`
		const role = fs(fn, 'Role')
		// the role NAME (an ARN is a reference, not a secret; the name is enough to find it)
		if (role) props.role = role.split('/').pop()!
		const id = arn ? this.addArn(arn, { name, tags: tagsOf(fn), props }) : undefined
		if (!id) return
		const vpcConf = f(fn, 'VpcConfig')
		this.place(id, fa(vpcConf, 'SubnetIds').map(asStr), fs(vpcConf, 'VpcId') || undefined)
		this.attachSgs(id, fa(vpcConf, 'SecurityGroupIds'))
		const vars = asObj(f(f(fn, 'Environment'), 'Variables'))
		this.envRefs(
			id,
			Object.entries(vars).map(([k, v]) => [k, asStr(v) ?? '']),
		)
	}

	esm(m: unknown) {
		const src = fs(m, 'EventSourceArn')
		const fn = fs(m, 'FunctionArn')
		if (fs(m, 'State') === 'Disabled') return
		if (src && fn) {
			this.addArn(src)
			this.addArn(normalizeFnArn(fn))
			this.b.relate(src, normalizeFnArn(fn), 'triggers')
		}
	}

	ecsOrOtherCluster(c: unknown) {
		const arn = fs(c, 'clusterArn')
		if (arn) this.addArn(arn, { name: fs(c, 'clusterName'), tags: tagsOf(c) })
	}

	ecsService(s: unknown) {
		const arn = fs(s, 'serviceArn')
		const props: Record<string, string> = {}
		const launch = fs(s, 'launchType')
		if (launch) props.launchType = launch
		const desired = asStr(f(s, 'desiredCount'))
		if (desired) props.desiredCount = desired
		const tdArn = fs(s, 'taskDefinition')
		if (tdArn) props.taskDefinition = tdArn.split('/').pop()!
		const id = this.addArn(arn, { name: fs(s, 'serviceName'), tags: tagsOf(s), props })
		if (!id) return
		const cluster = fs(s, 'clusterArn')
		if (cluster) {
			this.addArn(cluster)
			this.b.relate(id, cluster, 'runs-on')
		}
		const td = fs(s, 'taskDefinition')
		if (td) this.b.alias(`td-user:${td}`, id)
		for (const lb of fa(s, 'loadBalancers')) {
			const tg = fs(lb, 'targetGroupArn')
			if (tg) this.tgTargets.push({ tg, target: id })
		}
		const net = f(f(s, 'networkConfiguration'), 'awsvpcConfiguration')
		const subnets = fa(net, 'subnets').map(asStr)
		this.place(id, subnets, undefined)
		this.attachSgs(id, fa(net, 'securityGroups'))
	}

	taskDefinition(t: Obj) {
		const arn = asStr(t.taskDefinitionArn)
		if (!arn) return
		const user = this.b.resolve(`td-user:${arn}`)
		const target = user ?? this.addArn(arn)
		const vars: [string, string][] = []
		// container facts (name, image repository, ports, size) on the service; never env values
		const containers: Record<string, string> = {}
		for (const c of asArr(t.containerDefinitions)) {
			const co = asObj(c)
			const name = asStr(co.name)
			if (!name) continue
			const image = (asStr(co.image) ?? '').split('/').pop()!.replace(/[:@].*$/, '')
			const ports = asArr(co.portMappings).map((p) => asStr(asObj(p).containerPort)).filter(Boolean)
			const size = [asStr(co.cpu) ? `${asStr(co.cpu)} cpu` : '', asStr(co.memory) ? `${asStr(co.memory)} MB` : ''].filter(Boolean).join(' / ')
			containers[`container.${name}`] = [image, ports.length ? `:${ports.join(', :')}` : '', size].filter(Boolean).join(' ')
		}
		if (user) {
			const r = this.b.get(user)
			if (r) for (const [k, v] of Object.entries(containers)) r.props[k] ??= v
		}
		for (const c of asArr(t.containerDefinitions)) {
			for (const e of asArr(asObj(c).environment)) vars.push([asStr(asObj(e).name) ?? '', asStr(asObj(e).value) ?? ''])
			for (const s of asArr(asObj(c).secrets)) vars.push([asStr(asObj(s).name) ?? '', asStr(asObj(s).valueFrom) ?? ''])
		}
		if (user) this.envRefs(user, vars)
		else if (target) this.pendingTd.push({ arn, vars, containers })
	}
	pendingTd: { arn: string; vars: [string, string][]; containers: Record<string, string> }[] = []

	// ------------------------------------------------------------------ load balancing

	loadBalancer(lb: unknown) {
		const arn = fs(lb, 'LoadBalancerArn')
		const props: Record<string, string> = {}
		const type = fs(lb, 'Type')
		if (type) props.lbType = type
		const scheme = fs(lb, 'Scheme')
		if (scheme) props.scheme = scheme
		const id = this.addArn(arn, { name: fs(lb, 'LoadBalancerName'), tags: tagsOf(lb), props })
		if (!id) return
		const dns = fs(lb, 'DNSName')
		if (dns) {
			this.b.alias(dns, id)
			this.b.alias(`dualstack.${dns}`, id)
		}
		const subnets = fa(lb, 'AvailabilityZones').map((z) => fs(z, 'SubnetId'))
		this.place(id, subnets, fs(lb, 'VpcId'))
		this.attachSgs(id, fa(lb, 'SecurityGroups'))
	}

	classicLb(lb: unknown) {
		const name = fs(lb, 'LoadBalancerName')
		if (!name) return
		const id = this.addShort('AWS::ElasticLoadBalancing::LoadBalancer', `elb:${name}`, { name })
		const dns = fs(lb, 'DNSName')
		if (id && dns) this.b.alias(dns, id)
		this.place(id, fa(lb, 'Subnets').map(asStr), fs(lb, 'VPCId'))
		this.attachSgs(id, fa(lb, 'SecurityGroups'))
		for (const i of fa(lb, 'Instances')) this.b.relate(id, fs(i, 'InstanceId'), 'routes')
	}

	targetGroup(tg: unknown) {
		const arn = fs(tg, 'TargetGroupArn')
		if (!arn) return
		this.addArn(arn, { name: fs(tg, 'TargetGroupName') })
		this.tgLb.set(arn, fa(tg, 'LoadBalancerArns').map((x) => asStr(x)).filter((x): x is string => !!x))
	}

	// ------------------------------------------------------------------ data

	dbInstance(d: unknown) {
		const arn = fs(d, 'DBInstanceArn')
		const name = fs(d, 'DBInstanceIdentifier')
		const props: Record<string, string> = {}
		const engine = fs(d, 'Engine')
		if (engine) props.engine = engine
		let id = arn ? this.addArn(arn, { name, tags: tagsOf(d), props }) : undefined
		const cluster = fs(d, 'DBClusterIdentifier')
		if (!id) return
		const host = fs(f(d, 'Endpoint'), 'Address')
		if (host) this.b.alias(host, id)
		if (cluster) {
			// members of an Aurora cluster are drawn as the cluster
			this.b.alias(`cluster-member:${id}`, cluster)
			const r = this.b.get(id)
			if (r) r.props.clusterMember = cluster
			id = undefined
		}
		const sg = f(d, 'DBSubnetGroup')
		const subnets = fa(sg, 'Subnets').map((s) => fs(s, 'SubnetIdentifier'))
		if (id) {
			this.place(id, subnets, fs(sg, 'VpcId'))
			this.attachSgs(id, fa(d, 'VpcSecurityGroups'))
		} else if (arn) {
			this.place(arn, subnets, fs(sg, 'VpcId'))
		}
	}

	dbCluster(d: unknown) {
		const arn = fs(d, 'DBClusterArn')
		const name = fs(d, 'DBClusterIdentifier')
		const props: Record<string, string> = {}
		const engine = fs(d, 'Engine')
		if (engine) props.engine = engine
		const id = arn ? this.addArn(arn, { name, tags: tagsOf(d), props }) : undefined
		if (!id) return
		if (name) this.b.alias(name, id)
		for (const k of ['Endpoint', 'ReaderEndpoint']) {
			const host = fs(d, k)
			if (host) this.b.alias(host, id)
		}
		this.attachSgs(id, fa(d, 'VpcSecurityGroups'))
		this.clusterSubnetGroups.push({ id, group: fs(d, 'DBSubnetGroup') })
	}
	clusterSubnetGroups: { id: string; group?: string }[] = []

	cacheCluster(c: unknown) {
		const arn = fs(c, 'ARN')
		const rg = fs(c, 'ReplicationGroupId')
		const id = this.addArn(rg && arn ? arn.replace(/cluster:[^:]+$/, `replicationgroup:${rg}`) : arn, { name: rg ?? fs(c, 'CacheClusterId'), props: { engine: fs(c, 'Engine') ?? '' } })
		if (!id) return
		const host = fs(f(c, 'ConfigurationEndpoint'), 'Address')
		if (host) this.b.alias(host, id)
		for (const n of fa(c, 'CacheNodes')) {
			const h = fs(f(n, 'Endpoint'), 'Address')
			if (h) this.b.alias(h, id)
		}
		this.attachSgs(id, fa(c, 'SecurityGroups'))
	}

	// ------------------------------------------------------------------ edge, messaging

	distribution(d: unknown) {
		const arn = fs(d, 'ARN')
		const aliases = fa(f(d, 'Aliases'), 'Items').map(asStr).filter(Boolean) as string[]
		const id = this.addArn(arn, { name: aliases[0] ?? fs(d, 'DomainName') ?? fs(d, 'Id') })
		if (!id) return
		const dom = fs(d, 'DomainName')
		if (dom) this.b.alias(dom, id)
		for (const o of fa(f(d, 'Origins'), 'Items')) {
			const host = fs(o, 'DomainName')
			if (!host) continue
			const bucket = /^(.+?)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.exec(host)?.[1] ?? /^(.+?)\.s3-website[.-][a-z0-9-]+\.amazonaws\.com$/.exec(host)?.[1]
			this.b.relate(id, bucket ? `arn:aws:s3:::${bucket}` : host, 'origin')
		}
	}

	subscription(s: unknown) {
		const topic = fs(s, 'TopicArn')
		const endpoint = fs(s, 'Endpoint')
		const proto = fs(s, 'Protocol')
		if (!topic || !endpoint) return
		this.addArn(topic)
		// only ARN endpoints (sqs, lambda, firehose); emails / URLs are never kept
		if (endpoint.startsWith('arn:')) {
			this.addArn(normalizeFnArn(endpoint))
			this.b.relate(topic, normalizeFnArn(endpoint), 'subscribes', proto === 'lambda' ? 'invokes' : undefined)
		}
	}

	eventRule(r: unknown) {
		const arn = fs(r, 'Arn')
		const props: Record<string, string> = {}
		const sched = fs(r, 'ScheduleExpression')
		if (sched) props.schedule = sched
		const id = this.addArn(arn, { name: fs(r, 'Name'), props })
		if (id && fs(r, 'Name')) this.b.alias(`rule:${fs(r, 'Name')}`, id)
		const bus = fs(r, 'EventBusName')
		if (id && bus && bus !== 'default' && arn) this.b.relate(arn.replace(/:rule\/.*$/, `:event-bus/${bus}`), id, 'routes')
	}

	ruleTarget(rule: string, t: unknown) {
		const target = fs(t, 'Arn')
		if (!target) return
		const from = rule.startsWith('arn:') ? rule : `rule:${rule}`
		if (rule.startsWith('arn:')) this.addArn(rule)
		this.addArn(normalizeFnArn(target))
		this.b.relate(from, normalizeFnArn(target), 'triggers')
	}

	hostedZone(z: unknown) {
		const rawId = fs(z, 'Id')?.replace(/^\/hostedzone\//, '')
		const name = fs(z, 'Name')?.replace(/\.$/, '')
		if (!rawId) return
		const id = this.addShort('AWS::Route53::HostedZone', `route53:${rawId}`, { name, region: 'global' })
		if (id) {
			this.b.alias(rawId, id)
			this.b.alias(`/hostedzone/${rawId}`, id)
		}
	}

	record(zone: string, r: unknown) {
		const zid = `route53:${zone.replace(/^\/hostedzone\//, '')}`
		const name = fs(r, 'Name')?.replace(/\.$/, '')
		const alias = fs(f(r, 'AliasTarget'), 'DNSName')?.replace(/\.$/, '')
		const targets = alias ? [alias] : fa(r, 'ResourceRecords').map((x) => fs(x, 'Value')?.replace(/\.$/, ''))
		const type = fs(r, 'Type')
		if (type !== 'A' && type !== 'AAAA' && type !== 'CNAME') return
		for (const t of targets) if (t) this.b.relate(zid, t.toLowerCase(), 'alias', name)
	}

	restApi(a: unknown) {
		const id = fs(a, 'id')
		if (!id) return
		this.addShort('AWS::ApiGateway::RestApi', `apigw:${id}`, { name: fs(a, 'name'), tags: tagsOf(a) })
		this.b.alias(id, `apigw:${id}`)
	}

	restResource(api: string, res: unknown) {
		const methods = asObj(f(res, 'resourceMethods'))
		for (const m of Object.values(methods)) {
			const integ = asObj(asObj(m).methodIntegration)
			const uri = asStr(integ.uri)
			if (uri) this.integrationTarget(`apigw:${api}`, uri, asStr(integ.connectionId))
		}
	}

	v2Api(a: unknown) {
		const id = fs(a, 'ApiId')
		if (!id) return
		const props: Record<string, string> = {}
		const p = fs(a, 'ProtocolType')
		if (p) props.protocol = p
		this.addShort('AWS::ApiGatewayV2::Api', `apigw:${id}`, { name: fs(a, 'Name'), tags: tagsOf(a), props })
		this.b.alias(id, `apigw:${id}`)
	}

	v2Integration(api: string, i: unknown) {
		const uri = fs(i, 'IntegrationUri')
		if (uri) this.integrationTarget(`apigw:${api}`, uri)
	}

	integrationTarget(api: string, uri: string, _connection?: string) {
		const fn = /functions\/(arn:[^/]+)\/invocations/.exec(uri)?.[1]
		if (fn) {
			this.addArn(normalizeFnArn(fn))
			return this.b.relate(api, normalizeFnArn(fn), 'invokes')
		}
		const lb = uri.startsWith('arn:') ? listenerToLb(uri) : null
		if (lb) return this.b.relate(api, lb, 'routes')
		if (uri.startsWith('arn:')) {
			this.addArn(normalizeFnArn(uri))
			return this.b.relate(api, normalizeFnArn(uri), 'invokes')
		}
		const host = hostOf(uri)
		if (host) this.b.relate(api, host, 'routes')
	}

	// ------------------------------------------------------------------ finish

	finish(): CloudGraph {
		const b = this.b
		const account = [...this.accounts.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] ?? 'unknown'
		b.scope = account
		b.scopeName = this.opts.accountName ? `${this.opts.accountName} (${account})` : `AWS account ${account}`
		b.add({ id: account, type: ACCOUNT_TYPE, name: b.scopeName })
		const all = b.build().resources

		// pending task definitions without a known service: attach env refs to the services using them
		for (const td of this.pendingTd) {
			const user = b.resolve(`td-user:${td.arn}`)
			if (user) this.envRefs(user, td.vars)
			const r = user ? b.get(user) : undefined
			if (r) for (const [k, v] of Object.entries(td.containers)) r.props[k] ??= v
		}
		// DB clusters: place via member instances
		for (const { id } of this.clusterSubnetGroups) {
			const member = all.find((r) => r.props.clusterMember && b.resolve(r.props.clusterMember) === id)
			if (member) {
				const p = this.pendingParents.find((x) => x.id === member.id)
				if (p) this.pendingParents.push({ id, ref: p.ref })
			}
		}
		// Aurora members are hidden behind their cluster
		for (const r of all) if (r.props.clusterMember && b.resolve(r.props.clusterMember)) r.type = 'AWS::RDS::DBInstance#member'

		// parents: subnet / vpc refs
		for (const p of this.pendingParents) {
			let ref = p.ref
			if (ref.startsWith('vpc-of:')) ref = b.resolve(`vpc-of:${ref.slice(7)}`) ?? ''
			b.setParent(p.id, ref)
		}
		// buckets carry no region in their ARN: with a single-region inventory they belong to it
		const only = this.regions.size === 1 ? [...this.regions][0] : undefined
		if (only) for (const r of all) if (r.type === 'AWS::S3::Bucket' && !r.region) r.region = only
		// everything else: region containers under the account
		for (const r of all) {
			if (r.id === account) continue
			if (r.type === 'AWS::EC2::VPC' || !r.parent) {
				if (!r.region && r.type === 'AWS::EC2::VPC') r.region = this.opts.defaultRegion
				r.parent = regionContainer(b, account, r.region)
			}
		}

		// load balancers → targets (through target groups)
		for (const { tg, target } of this.tgTargets) {
			const lbs = this.tgLb.get(tg) ?? []
			const t = target.startsWith('arn:') ? normalizeFnArn(target) : target
			for (const lb of lbs) b.relate(lb, t, 'routes')
		}
		// security groups: source members → target members
		for (const rule of this.sgRules) {
			const targets = this.sgMembers.get(rule.target)
			const sources = this.sgMembers.get(rule.source)
			if (!targets || !sources) continue
			for (const s of sources) for (const t of targets) if (s !== t) b.relate(s, t, 'connects', rule.port ? `:${rule.port}` : undefined)
		}
		// env references
		for (const e of this.pendingEnv) {
			for (const ref of e.refs) {
				const to = b.resolve(ref)
				if (to && to !== e.from) {
					b.relate(e.from, to, 'env', `env ${e.key}`)
					break
				}
			}
		}
		// relations to Aurora members point at the cluster
		const graph = b.build()
		const memberToCluster = new Map<string, string>()
		for (const r of graph.resources) if (r.type === 'AWS::RDS::DBInstance#member') memberToCluster.set(r.id, b.resolve(r.props.clusterMember) ?? r.id)
		graph.resources = graph.resources.filter((r) => r.type !== 'AWS::RDS::DBInstance#member')
		graph.relations = graph.relations
			.map((rel) => ({ ...rel, from: memberToCluster.get(rel.from) ?? rel.from, to: memberToCluster.get(rel.to) ?? rel.to }))
			.filter((rel) => rel.from !== rel.to)
		if (this.regions.size === 0 && graph.resources.length <= 1) graph.warnings.push('no AWS resources recognised in the input')
		return graph
	}
}

function normalizeFnArn(arn: string): string {
	const m = /^(arn:[^:]+:lambda:[^:]+:\d+:function:[^:]+)(:.+)?$/.exec(arn)
	return m ? m[1] : arn
}

function safeJson(s: string): Obj {
	try {
		return asObj(JSON.parse(s))
	} catch {
		return {}
	}
}

function hostOf(s: string): string | undefined {
	const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/?#\s]+)/i.exec(s)
	return m?.[1]?.toLowerCase()
}

/**
 * Possible resource references inside an env value: the value itself (names,
 * ARNs), ARNs embedded in it, URL / connection-string hosts, SQS URLs.
 * Returned strings are only used as lookup keys and never stored on the graph.
 */
export function refCandidates(v: string): string[] {
	const value = v.trim()
	if (value.length < 3 || value.length > 2048) return []
	const out = new Set<string>()
	if (/^[A-Za-z0-9._:/@-]+$/.test(value) && !/^(true|false|null|none|prod|production|dev|development|staging|test|info|debug|warn|error)$/i.test(value)) out.add(value)
	for (const m of value.matchAll(/arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[A-Za-z0-9_./:@+=,-]+/g)) out.add(m[0].replace(/:\*$/, ''))
	const q = queueUrlToArn(value)
	if (q) out.add(q)
	const host = hostOf(value)
	if (host) out.add(host)
	const hostPort = /^([a-z0-9.-]+\.amazonaws\.com)(?::\d+)?$/i.exec(value)
	if (hostPort) out.add(hostPort[1].toLowerCase())
	return [...out]
}

/** Is this parsed JSON an AWS export we can read? */
export function looksLikeAws(input: unknown): boolean {
	const probe = (o: unknown, depth = 0): boolean => {
		if (depth > 3) return false
		if (Array.isArray(o)) return o.slice(0, 20).some((x) => probe(x, depth + 1))
		if (!isObj(o)) return false
		if (o.kind === AWS_INVENTORY_KIND) return true
		const keys = ['ResourceTagMappingList', 'configurationItems', 'ConfigurationItems', 'Vpcs', 'Subnets', 'Reservations', 'Functions', 'EventSourceMappings', 'LoadBalancers', 'TargetGroups', 'DBInstances', 'DBClusters', 'DistributionList', 'Subscriptions', 'Topics', 'QueueUrls', 'HostedZones', 'SecurityGroups', 'Rules']
		if (keys.some((k) => k in o)) return true
		if (Array.isArray(o.Results) && o.Results.some((r) => typeof r === 'string' && r.includes('resourceType'))) return true
		if (Array.isArray(o.responses)) return probe(o.responses, depth + 1)
		const rk = Object.keys(o).filter((k) => REGION_RE.test(k))
		return rk.length > 0 && rk.some((k) => probe(o[k], depth + 1))
	}
	return probe(input)
}

export function normalizeAws(input: unknown, opts: AwsNormalizeOptions = {}): CloudGraph {
	const n = new AwsNormalizer(opts)
	n.walk(input)
	return n.finish()
}
