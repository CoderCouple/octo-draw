import { describe, expect, it } from 'vitest'
import { parseOcto, parseOctoPages } from '@octo-draw/core'
import { normalizeCloud } from '../connectors/cloud/pipeline'
import { fixture, fixtureText, PLANTED_SECRETS } from '../connectors/cloud/fixtures'
import { parseAwsInput } from '../connectors/cloud/connectors'
import { ConnectorError, type ConnectorContext } from '../connectors/types'
import { createCloudExpander, expandCloudResource } from './cloud'
import { parseSrc } from './src'
import type { ExpandContext, ExpanderRequest } from './types'

const aws = normalizeCloud('aws', fixture('aws/describe-bundle.json'))
const gcp = normalizeCloud('gcp', [fixture('gcp/search-all-resources.json'), fixture('gcp/assets-resource.json')])
const azure = normalizeCloud('azure', fixture('azure/resource-graph.json'))

const ARN = {
	lambda: 'arn:aws:lambda:us-east-1:111122223333:function:order-processor',
	web: 'arn:aws:ecs:us-east-1:111122223333:service/shop-cluster/web',
	alb: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/shop-web-alb/50dc6c495c0c9188',
	table: 'arn:aws:dynamodb:us-east-1:111122223333:table/orders',
}
const AZ = '/subscriptions/00000000-1111-2222-3333-444444444444/resourcegroups/rg-shop-prod/providers'

function page(body: string) {
	const r = parseOcto(body)
	expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	const byKey = new Map(r.ir.nodes.map((n) => [n.key, n]))
	const edge = (from: string, to: string) => r.ir.edges.find((e) => e.from === from && e.to === to)
	return { ir: r.ir, byKey, edge, src: (k: string) => byKey.get(k)?.ext?.src }
}

describe('expandCloudResource', () => {
	it('VPC: subnets as groups with their resources, relations as edges, children', () => {
		const e = expandCloudResource(aws, 'vpc-0a1b2c3d4e5f60001')!
		const p = page(e.body)
		expect(p.ir.title).toBeUndefined()
		expect(p.ir.direction).toBe('right')
		const sub = p.byKey.get('private-b 10.0.11.0/24')!
		expect(sub.isContainer).toBe(true)
		expect(sub.ext?.src).toBe('aws:subnet-0bb0000000000b002')
		expect(p.byKey.get('worker')!.parent).toBe('private-b 10.0.11.0/24')
		expect(p.byKey.get('order-processor')!.parent).toBeUndefined()
		expect(p.edge('web', 'shop-db')).toBeDefined()
		expect(p.edge('shop-web-alb', 'web')).toBeDefined()
		expect(e.children).toEqual(expect.arrayContaining(['private-b 10.0.11.0/24', 'worker', 'web', 'shop-db', 'order-processor']))
		// empty subnets are drawn but not recursed into
		expect(p.byKey.has('data-a 10.0.20.0/24')).toBe(true)
		expect(e.children).not.toContain('data-a 10.0.20.0/24')
		for (const n of p.ir.nodes) expect(n.ext?.src, n.key).toMatch(/^aws:/)
		expect(e.findings?.[0]).toMatchObject({ analyzer: 'aws', notes: ['VPC shop-prod: 14 resources inside'] })
	})

	it('subnet: its resources plus outside neighbours as ghosts that are not children', () => {
		const e = expandCloudResource(aws, 'subnet-0bb0000000000b002')!
		const p = page(e.body)
		expect(e.children).toEqual(['worker'])
		const db = p.byKey.get('shop-db')!
		expect(db.style?.color).toBe('gray')
		expect(db.ext?.src).toBe('aws:arn:aws:rds:us-east-1:111122223333:cluster:shop-db')
		expect(p.edge('worker', 'shop-db')?.label).toBe(':5432')
		expect(p.edge('worker', 'shop-cache')?.label).toBe('env CACHE_HOST')
	})

	it('an empty container still gives a page (the container and a note)', () => {
		const p = page(expandCloudResource(aws, 'subnet-0cc0000000000c001')!.body)
		expect(p.byKey.get('details')!.label).toBe('no drawable resources inside')
	})

	it('Lambda: triggers, destinations, env references by name, IAM role, network, key props', () => {
		const e = expandCloudResource(aws, ARN.lambda)!
		const p = page(e.body)
		expect(p.edge('orders-queue', 'order-processor')?.label).toBe('triggers')
		expect(p.edge('order-processor', 'orders')?.label).toBe('env TABLE_NAME')
		expect(p.edge('order-processor', 'order-events')?.label).toBe('env EVENTS_TOPIC_ARN')
		expect(p.edge('order-processor', 'role order-processor-role')?.label).toBe('assumes')
		expect(p.edge('order-processor', 'shop-prod 10.0.0.0/16')?.label).toBe('in')
		expect(p.byKey.get('details')!.label).toMatch(/^Lambda function · us-east-1 · runtime: nodejs22\.x · handler: index\.handler · memory: 512 MB$/)
		expect(p.byKey.get('details')!.shape).toBe('document')
		// leftover env names (non-secret ones only), never values
		expect(p.byKey.get('env')!.label).toBe('env LOG_LEVEL')
		expect(e.body).not.toContain('API_TOKEN')
		expect(e.children).toEqual([])
		expect(e.findings?.[0].notes?.[0]).toBe('Lambda function order-processor: 4 related resources')
	})

	it('ECS service: containers from the task definition, cluster, load balancer, env references', () => {
		const p = page(expandCloudResource(aws, ARN.web)!.body)
		expect(p.byKey.has('container web (shop-web :8080 256 cpu / 512 MB)')).toBe(true)
		expect(p.edge('web', 'shop-cluster')?.label).toBe('runs on')
		expect(p.edge('shop-web-alb', 'web')).toBeDefined()
		expect(p.edge('web', 'prod/stripe')?.label).toBe('env STRIPE_KEY')
		expect(p.byKey.get('details')!.label).toContain('taskDefinition: web:12')
		expect(p.byKey.has('env')).toBe(false)
	})

	it('load balancer: listeners/routes to its targets and what fronts it', () => {
		const p = page(expandCloudResource(aws, ARN.alb)!.body)
		expect(p.byKey.get('details')!.label).toContain('lbType: application · scheme: internet-facing')
		expect(p.edge('shop-web-alb', 'web')).toBeDefined()
		expect(p.edge('shop-web-alb', 'worker')?.label).toBe(':8080')
		expect(p.edge('shop.example.com', 'shop-web-alb')?.label).toBe('origin')
		expect(p.edge('shop-api', 'shop-web-alb')?.label).toBe('routes')
	})

	it('anything else: a details page with related resources', () => {
		const p = page(expandCloudResource(aws, ARN.table)!.body)
		expect(p.byKey.get('details')!.label).toBe('DynamoDB table · us-east-1')
		expect(p.edge('order-processor', 'orders')?.label).toBe('env TABLE_NAME')
	})

	it('regions and accounts list their networks and resources', () => {
		const region = expandCloudResource(aws, 'region:111122223333/us-east-1')!
		expect(region.children).toEqual(expect.arrayContaining(['shop-prod 10.0.0.0/16', 'order-api', 'orders']))
		const acct = expandCloudResource(aws, '111122223333')!
		expect(page(acct.body).src('us-east-1')).toBe('aws:region:111122223333/us-east-1')
	})

	it('folds same-type resources over the cap', () => {
		const e = expandCloudResource(aws, 'region:111122223333/us-east-1', { maxNodes: 10 })!
		const p = page(e.body)
		expect(p.ir.nodes.length).toBeLessThanOrEqual(10)
		const fold = p.ir.nodes.find((n) => /^\d+ (Lambda functions|SQS queues|S3 buckets|EventBridge rules)$/.test(n.label ?? n.key))
		expect(fold).toBeDefined()
		expect(fold!.ext?.src).toBeUndefined()
		expect(e.children).not.toContain(fold!.key)
	})

	it('GCP and Azure resources', () => {
		const run = page(expandCloudResource(gcp, '//run.googleapis.com/projects/acme-shop-prod/locations/us-central1/services/checkout-api')!.body)
		expect(run.edge('shop-https-fr', 'checkout-api')?.label).toBe('routes')
		expect(run.edge('checkout-api', 'shop-pg')).toBeDefined()
		expect(run.src('checkout-api')).toBe('gcp://run.googleapis.com/projects/acme-shop-prod/locations/us-central1/services/checkout-api')
		const vnet = expandCloudResource(azure, `${AZ}/microsoft.network/virtualnetworks/vnet-shop`)!
		const v = page(vnet.body)
		expect(v.byKey.get('app-shop-web')!.parent).toBe('snet-app 10.1.1.0/24')
		expect(v.edge('agw-shop', 'app-shop-web')?.label).toBe('routes')
		// containment is not drawn as an edge
		expect(v.ir.edges.some((e) => e.from === 'snet-vm 10.1.10.0/24' || e.to === 'snet-vm 10.1.10.0/24')).toBe(false)
		// ARM ids match case-insensitively
		expect(expandCloudResource(azure, `${AZ}/microsoft.network/virtualnetworks/VNET-SHOP`.replace('providers', 'PROVIDERS'))).not.toBeNull()
	})

	it('unknown ids give null; no planted secret appears on any page', () => {
		expect(expandCloudResource(aws, 'arn:aws:lambda:us-east-1:1:function:nope')).toBeNull()
		for (const g of [aws, gcp, azure, normalizeCloud('aws', fixture('aws/config-snapshot.json'))]) {
			for (const r of g.resources) {
				const text = JSON.stringify(expandCloudResource(g, r.id))
				for (const s of PLANTED_SECRETS) expect(text, `${r.id} ${s}`).not.toContain(s)
			}
		}
	})
})

describe('cloudExpander', () => {
	const baseCtx: ConnectorContext = { fetch: (() => { throw new Error('no network in tests') }) as unknown as typeof fetch, env: {} }
	const req = (src: string, sourceInput: string, options: Record<string, unknown> = {}): ExpanderRequest => ({
		source: sourceInput ? parseAwsInput(sourceInput) : null,
		sourceInput,
		src: parseSrc(src),
		node: { key: 'n' },
		options,
		maxNodes: 30,
	})
	const live = { aws: async () => { throw new Error('live AWS must not be used') } }

	it('reads the export named by the source directive once per run (cache)', async () => {
		let reads = 0
		const expand = createCloudExpander({ ...live, readFile: async () => (reads++, fixtureText('aws/describe-bundle.json')) })
		const ctx: ExpandContext = { ...baseCtx, cache: new Map() }
		const a = await expand(req(`aws:${ARN.lambda}`, 'aws:./exports/aws.json'), ctx)
		const b = await expand(req('aws:vpc-0a1b2c3d4e5f60001', 'aws:./exports/aws.json'), ctx)
		expect(a!.body).toContain('order-processor')
		expect(b!.children!.length).toBeGreaterThan(5)
		expect(reads).toBe(1)
	})

	it('takes an inline export when the document has no source', async () => {
		const expand = createCloudExpander(live)
		const r = await expand(req(`aws:${ARN.web}`, '', { export: fixtureText('aws/describe-bundle.json') }), { ...baseCtx })
		expect(r!.body).toContain('shop-cluster')
	})

	it('errors: no source (400), unknown resource (404), files refused (403)', async () => {
		const expand = createCloudExpander({ ...live, readFile: async () => fixtureText('aws/describe-bundle.json') })
		await expect(expand(req(`aws:${ARN.web}`, ''), baseCtx)).rejects.toMatchObject({ status: 400 })
		const missing = await expand(req('aws:arn:aws:sqs:us-east-1:1:nope', 'aws:a.json'), baseCtx).catch((e) => e)
		expect(missing).toBeInstanceOf(ConnectorError)
		expect(missing.status).toBe(404)
		await expect(expand(req(`aws:${ARN.web}`, 'aws:/etc/x.json', { allowFiles: false }), baseCtx)).rejects.toMatchObject({ status: 403 })
	})

	it('pages expand cleanly into a document', async () => {
		const expand = createCloudExpander({ ...live, readFile: async () => fixtureText('aws/describe-bundle.json') })
		const r = await expand(req('aws:vpc-0a1b2c3d4e5f60001', 'aws:a.json'), baseCtx)
		expect(parseOctoPages(`title T\n\npage VPC\n${r!.body}`).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	})
})
