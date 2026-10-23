/**
 * Mock cloud clients for tests, serving the hand-written fixtures in the shape
 * the real APIs return. Nothing here touches the network.
 */

import type { AwsApi, AwsService } from './aws/collect'
import type { GcpHttp } from './gcp/collect'
import type { AzureHttp } from './azure/collect'
import { fixture } from './fixtures'

type Rec = Record<string, unknown>

export interface Recorded {
	service: string
	region: string
	op: string
	input: Rec
}

/** AWS API mock backed by fixtures/cloud/aws/describe-bundle.json. Lambda and Tagging responses are split into pages. */
export function mockAwsApi(opts: { failExplorer?: boolean; failAuth?: boolean } = {}): AwsApi & { calls: Recorded[] } {
	const bundle = fixture('aws/describe-bundle.json') as { responses: Rec[] }
	const find = (key: string, pred: (r: Rec) => boolean = () => true) => bundle.responses.find((r) => key in r && pred(r)) ?? {}
	const calls: Recorded[] = []
	const fns = (find('Functions').Functions as Rec[]).map((f) => structuredClone(f))
	const tagged = find('ResourceTagMappingList').ResourceTagMappingList as Rec[]
	const services = find('services').services as Rec[]
	const handlers: Record<string, (input: Rec, region: string) => Rec> = {
		'sts:GetCallerIdentity': () => {
			if (opts.failAuth) throw Object.assign(new Error('The security token included in the request is invalid.'), { name: 'InvalidClientTokenId' })
			return { $metadata: { requestId: 'r-1' }, Account: '111122223333', Arn: 'arn:aws:iam::111122223333:user/octo-readonly', UserId: 'AIDAEXAMPLE' }
		},
		'resource-explorer-2:Search': () => {
			if (opts.failExplorer !== false) throw Object.assign(new Error('no default view'), { name: 'UnauthorizedException' })
			return { Resources: tagged.map((t) => ({ Arn: t.ResourceARN, Region: 'us-east-1', Properties: [{ Name: 'tags', Data: t.Tags }] })) }
		},
		'tagging:GetResources': (i) => (i.PaginationToken ? { ResourceTagMappingList: tagged.slice(8), PaginationToken: '' } : { ResourceTagMappingList: tagged.slice(0, 8), PaginationToken: 'page-2' }),
		'ec2:DescribeVpcs': () => find('Vpcs'),
		'ec2:DescribeSubnets': () => find('Subnets'),
		'ec2:DescribeSecurityGroups': () => find('SecurityGroups'),
		'ec2:DescribeInstances': () => find('Reservations'),
		'ec2:DescribeNatGateways': () => find('NatGateways'),
		'ec2:DescribeInternetGateways': () => find('InternetGateways'),
		'ec2:DescribeVpcEndpoints': () => ({ VpcEndpoints: [] }),
		'lambda:ListFunctions': (i) => (i.Marker === 'm2' ? { Functions: fns.slice(2) } : { Functions: fns.slice(0, 2), NextMarker: 'm2' }),
		'lambda:ListEventSourceMappings': () => find('EventSourceMappings'),
		'elbv2:DescribeLoadBalancers': () => find('LoadBalancers'),
		'elbv2:DescribeTargetGroups': () => find('TargetGroups'),
		'elbv2:DescribeTargetHealth': () => ({ TargetHealthDescriptions: [{ Target: { Id: '10.0.10.5', Port: 8080 }, TargetHealth: { State: 'healthy' } }] }),
		'ecs:ListClusters': () => ({ clusterArns: ['arn:aws:ecs:us-east-1:111122223333:cluster/shop-cluster'] }),
		'ecs:DescribeClusters': () => find('clusters'),
		'ecs:ListServices': () => ({ serviceArns: services.map((s) => s.serviceArn) }),
		'ecs:DescribeServices': () => ({ services, failures: [] }),
		'ecs:DescribeTaskDefinition': (i) => structuredClone(find('taskDefinition', (r) => (r.taskDefinition as Rec).taskDefinitionArn === i.taskDefinition)),
		'rds:DescribeDBInstances': () => find('DBInstances'),
		'rds:DescribeDBClusters': () => find('DBClusters'),
		'elasticache:DescribeCacheClusters': () => find('CacheClusters'),
		'apigatewayv2:GetApis': () => find('Items', (r) => !('ApiId' in r)),
		'apigatewayv2:GetIntegrations': () => {
			const r = find('Items', (x) => 'ApiId' in x)
			return { Items: r.Items }
		},
		'apigateway:GetRestApis': () => ({ items: [] }),
		'cloudfront:ListDistributions': () => find('DistributionList'),
		'route53:ListHostedZones': () => ({ ...find('HostedZones'), IsTruncated: false }),
		'route53:ListResourceRecordSets': () => ({ ResourceRecordSets: find('ResourceRecordSets').ResourceRecordSets, IsTruncated: false }),
		'sns:ListSubscriptions': () => find('Subscriptions'),
		'eventbridge:ListRules': () => find('Rules'),
		'eventbridge:ListTargetsByRule': (i) => ({ Targets: (find('Targets', (r) => r.Rule === i.Rule || String(r.RuleArn ?? '').endsWith(`/${i.Rule}`)).Targets as Rec[]) ?? [] }),
	}
	return {
		calls,
		async call(service: AwsService, region: string, op: string, input: Rec) {
			calls.push({ service, region, op, input })
			const h = handlers[`${service}:${op}`]
			if (!h) throw Object.assign(new Error(`not mocked: ${service}:${op}`), { name: 'NotMocked' })
			// only us-east-1 has resources in the fixture
			if (region !== 'us-east-1' && !['sts', 'cloudfront', 'route53', 'resource-explorer-2'].includes(service)) return {}
			return h(input, region)
		},
	}
}

/** Cloud Asset API mock: search results in two pages, assets in one, relationships unavailable (400). */
export function mockGcpHttp(): GcpHttp & { urls: string[] } {
	const search = fixture('gcp/search-all-resources.json') as unknown[]
	const assets = fixture('gcp/assets-resource.json') as unknown[]
	const urls: string[] = []
	return {
		urls,
		async get(url: string) {
			urls.push(url)
			const u = new URL(url)
			if (u.pathname.endsWith(':searchAllResources')) {
				return u.searchParams.get('pageToken') ? { results: search.slice(20) } : { results: search.slice(0, 20), nextPageToken: 'p2' }
			}
			if (u.searchParams.get('contentType') === 'RESOURCE') return { assets, readTime: '2026-10-23T00:00:00Z' }
			if (u.searchParams.get('contentType') === 'RELATIONSHIP') throw Object.assign(new Error('Request contains an invalid argument.'), { status: 400 })
			throw new Error(`unexpected url ${url}`)
		},
	}
}

/** Resource Graph mock: rows in two pages via $skipToken; one subscription. */
export function mockAzureHttp(): AzureHttp & { bodies: Rec[]; gets: string[] } {
	const rows = (fixture('azure/resource-graph.json') as { data: unknown[] }).data
	const bodies: Rec[] = []
	const gets: string[] = []
	return {
		bodies,
		gets,
		async query(body) {
			bodies.push(body)
			const skip = (body.options as Rec | undefined)?.$skipToken
			return skip ? { totalRecords: rows.length, count: rows.length - 15, data: rows.slice(15), resultTruncated: 'false' } : { totalRecords: rows.length, count: 15, data: rows.slice(0, 15), $skipToken: 'ew0KICAiJGlkIjogIjEiDQp9', resultTruncated: 'false' }
		},
		async get(url) {
			gets.push(url)
			return { value: [{ subscriptionId: '00000000-1111-2222-3333-444444444444', displayName: 'contoso-prod', state: 'Enabled' }, { subscriptionId: '99999999-1111-2222-3333-444444444444', state: 'Disabled' }] }
		},
	}
}
