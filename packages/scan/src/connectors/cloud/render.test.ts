import { describe, expect, it } from 'vitest'
import { drillTargets, layoutDiagram, parseOcto, parseOctoPages, splitPages } from '@octo-draw/core'
import { cloudExportToOcto, normalizeCloud } from './pipeline'
import { renderCloudGraph } from './render'
import { cloudKind, iconForResourceType, knownResourceTypes } from './catalog'
import { fixture } from './fixtures'

/** A large synthetic account: 3 regions, 2 VPCs × 4 subnets, 150 Lambdas, 45 queues, 30 tables, 12 instances. */
function bigAccount() {
	const acct = '123456789012'
	const responses: unknown[] = []
	const tags: { ResourceARN: string; Tags: { Key: string; Value: string }[] }[] = []
	for (const region of ['us-east-1', 'eu-west-1', 'ap-south-1']) {
		const vpcs = region === 'us-east-1' ? ['vpc-a', 'vpc-b'] : ['vpc-c' + region.slice(0, 2)]
		responses.push({ region, responses: [{ Vpcs: vpcs.map((v) => ({ VpcId: v, CidrBlock: '10.0.0.0/16', OwnerId: acct, Tags: [{ Key: 'Name', Value: `${v}-${region}` }] })) }] })
		const subnets = vpcs.flatMap((v) => [1, 2, 3, 4].map((i) => ({ SubnetId: `subnet-${v}-${i}`, VpcId: v, AvailabilityZone: `${region}${'abcd'[i - 1]}`, CidrBlock: `10.0.${i}.0/24`, MapPublicIpOnLaunch: i === 1, OwnerId: acct })))
		responses.push({ region, responses: [{ Subnets: subnets }] })
		const n = region === 'us-east-1' ? 150 : 8
		const fns = Array.from({ length: n }, (_, i) => ({
			FunctionName: `fn-${region}-${i}`,
			FunctionArn: `arn:aws:lambda:${region}:${acct}:function:fn-${region}-${i}`,
			Runtime: 'nodejs22.x',
			VpcConfig: i % 3 === 0 ? { SubnetIds: [subnets[i % subnets.length].SubnetId], SecurityGroupIds: [], VpcId: subnets[i % subnets.length].VpcId } : undefined,
			Environment: { Variables: { TABLE: `table-${region}-${i % 30}`, SECRET_TOKEN: 'abc123-should-not-leak' } },
		}))
		responses.push({ region, responses: [{ Functions: fns }] })
		const queues = region === 'us-east-1' ? 45 : 3
		responses.push({ region, responses: [{ EventSourceMappings: Array.from({ length: queues }, (_, i) => ({ UUID: `u-${i}`, EventSourceArn: `arn:aws:sqs:${region}:${acct}:q-${region}-${i}`, FunctionArn: fns[i % fns.length].FunctionArn, State: 'Enabled' })) }] })
		for (let i = 0; i < (region === 'us-east-1' ? 30 : 2); i++) tags.push({ ResourceARN: `arn:aws:dynamodb:${region}:${acct}:table/table-${region}-${i}`, Tags: [{ Key: 'app', Value: i % 2 ? 'orders' : 'billing' }] })
		for (let i = 0; i < n; i++) if (i < 60) tags.push({ ResourceARN: fns[i].FunctionArn, Tags: [{ Key: 'app', Value: i % 2 ? 'orders' : 'billing' }] })
		responses.push({
			region,
			responses: [{ Reservations: [{ Instances: Array.from({ length: region === 'us-east-1' ? 12 : 2 }, (_, i) => ({ InstanceId: `i-${region}-${i}`, SubnetId: subnets[i % subnets.length].SubnetId, VpcId: subnets[i % subnets.length].VpcId, State: { Name: 'running' }, Placement: { AvailabilityZone: subnets[i % subnets.length].AvailabilityZone }, Tags: [{ Key: 'Name', Value: `host-${region}-${i}` }] })) }] }],
		})
	}
	responses.push({ ResourceTagMappingList: tags })
	return responses
}

function nodeCounts(code: string) {
	return splitPages(code).map((p) => {
		const body = code.slice(p.bodyFrom, p.to)
		return { name: p.name, nodes: parseOcto(body).ir.nodes.length }
	})
}

describe('rendering', () => {
	it('emits multi-page octo that parses without errors and lays out, for every provider fixture', async () => {
		const inputs = [fixture('aws/describe-bundle.json'), fixture('aws/config-snapshot.json'), fixture('aws/tagging-get-resources.json'), [fixture('gcp/search-all-resources.json'), fixture('gcp/assets-resource.json')], fixture('azure/resource-graph.json')]
		for (const input of inputs) {
			const out = cloudExportToOcto(input)!
			const parsed = parseOctoPages(out.code)
			expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
			// every `drill:` names a page that exists (no cross-page warnings)
			expect(parsed.diagnostics).toEqual([])
			expect(parsed.pages.map((p) => p.name)).toEqual(out.pages)
			for (const page of parsed.pages) {
				expect(page.diagnostics).toEqual([])
				const layout = await layoutDiagram(page.ir)
				expect(Object.keys(layout.nodes).length).toBe(page.ir.nodes.length)
			}
		}
	}, 60_000)

	it('draws resources with vendor icons, groups for VPCs / subnets, and labelled edges', () => {
		const out = cloudExportToOcto(fixture('aws/describe-bundle.json'))!
		const root = parseOctoPages(out.code).pages[0].ir
		const node = (k: string) => root.nodes.find((n) => n.key === k)
		expect(node('shop-prod 10.0.0.0/16')).toMatchObject({ isContainer: true, icon: 'aws-vpc' })
		expect(node('public-a 10.0.0.0/24')).toMatchObject({ isContainer: true, icon: 'aws-group-public-subnet', parent: 'shop-prod 10.0.0.0/16' })
		expect(node('order-processor')).toMatchObject({ icon: 'aws-lambda', parent: 'shop-prod 10.0.0.0/16' })
		expect(node('shop-db')).toMatchObject({ icon: 'aws-aurora', shape: 'cylinder' })
		const edge = (a: string, b: string) => root.edges.find((e) => e.from === a && e.to === b)
		expect(edge('orders-queue', 'order-processor')?.label).toBe('triggers')
		expect(edge('order-processor', 'orders')).toMatchObject({ label: 'env TABLE_NAME', line: { dash: 'dotted' } })
		// a load balancer → service edge explained by a target group wins over the SG port label
		expect(edge('shop-web-alb', 'web')?.label).toBe('routes')
		expect(edge('web', 'shop-db')?.label).toBe('env DATABASE_URL')
		expect(edge('web', 'shop-db')?.line.dash).toBe('solid')
		expect(out.code).toContain('title AWS account 111122223333')
	})

	it('caps every page at the node budget and folds big buckets into drillable counts', async () => {
		const g = normalizeCloud('aws', bigAccount())
		const out = renderCloudGraph(g, { maxNodesPerPage: 40 })
		const counts = nodeCounts(out.code)
		for (const c of counts) expect(c.nodes, `page "${c.name}"`).toBeLessThanOrEqual(40)
		expect(counts.length).toBeGreaterThan(5)
		const parsed = parseOctoPages(out.code)
		expect(parsed.diagnostics).toEqual([])
		// folded nodes drill into existing pages
		const names = parsed.pages.map((p) => p.name)
		const root = parsed.pages[0]
		const targets = drillTargets(root.ir, names)
		expect(Object.keys(targets).length).toBeGreaterThan(0)
		expect(root.ir.nodes.some((n) => /^\d+ (Lambda functions|SQS queues|DynamoDB tables|resources)|\(\d+ resources\)/.test(n.key) && n.ext?.drill)).toBe(true)
		// the root still lays out
		const layout = await layoutDiagram(root.ir)
		expect(Object.keys(layout.nodes).length).toBe(root.ir.nodes.length)
	}, 60_000)

	it('every resource is reachable on some page (list pages chain with "N more" continuations)', () => {
		const g = normalizeCloud('aws', bigAccount())
		const out = renderCloudGraph(g, { maxNodesPerPage: 20 })
		for (const c of nodeCounts(out.code)) expect(c.nodes, `page "${c.name}"`).toBeLessThanOrEqual(20)
		const keys = new Set(parseOctoPages(out.code).pages.flatMap((p) => p.ir.nodes.map((n) => n.key)))
		const lambdas = g.resources.filter((r) => r.type === 'AWS::Lambda::Function')
		expect(lambdas.length).toBe(166)
		for (const fn of lambdas) expect(keys.has(fn.name), fn.name).toBe(true)
		expect(out.code).toMatch(/\d+ more resources/)
		expect(out.code).not.toContain('abc123-should-not-leak')
	})

	it('keeps small accounts on one page without folding', () => {
		const out = cloudExportToOcto(fixture('aws/config-snapshot.json'))!
		expect(out.pages).toEqual([''])
		expect(out.code).not.toMatch(/drill:/)
	})

	it('creates application pages from tags when more than one app exists', () => {
		const out = cloudExportToOcto(fixture('aws/tagging-get-resources.json'))!
		expect(out.pages).toEqual(['', 'App · catalog', 'App · analytics'])
	})
})

describe('resource type catalog', () => {
	it('maps CloudFormation, Terraform, asset and ARM spellings to the same kind', () => {
		expect(iconForResourceType('AWS::Lambda::Function')).toBe('aws-lambda')
		expect(iconForResourceType('aws_lambda_function')).toBe('aws-lambda')
		expect(iconForResourceType('google_cloud_run_v2_service')).toBe('gcp-cloud-run')
		expect(iconForResourceType('run.googleapis.com/Service')).toBe('gcp-cloud-run')
		expect(iconForResourceType('Microsoft.Web/serverFarms')).toBe('azure-app-service-plans')
		expect(iconForResourceType('azurerm_linux_function_app')).toBe('azure-functions')
		expect(cloudKind('aws_security_group')?.hidden).toBe(true)
		expect(cloudKind('azurerm_virtual_network')?.container).toBe('vpc')
		expect(knownResourceTypes().length).toBeGreaterThan(300)
		expect(iconForResourceType('nope_nothing')).toBeUndefined()
	})

	it('uses well-formed icon names', () => {
		for (const t of knownResourceTypes()) expect(cloudKind(t)!.icon).toMatch(/^((aws|gcp|azure)-[a-z0-9-]+|kubernetes)$/)
	})
})
