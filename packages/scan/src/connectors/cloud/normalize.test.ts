import { describe, expect, it } from 'vitest'
import { normalizeAws } from './aws/normalize'
import { arnInfo, listenerToLb, queueUrlToArn } from './aws/arn'
import { normalizeGcp } from './gcp/normalize'
import { normalizeAzure } from './azure/normalize'
import { detectCloudExport, normalizeCloud, parseExportText } from './pipeline'
import { fixture, fixtureText } from './fixtures'
import type { CloudGraph } from './model'

const byName = (g: CloudGraph, name: string) => {
	const r = g.resources.find((x) => x.name === name)
	if (!r) throw new Error(`no resource named ${name}: ${g.resources.map((x) => x.name).join(', ')}`)
	return r
}
const parentName = (g: CloudGraph, name: string) => g.resources.find((x) => x.id === byName(g, name).parent)?.name
/** `from -kind-> to` by resource names. */
const rels = (g: CloudGraph) => {
	const n = new Map(g.resources.map((r) => [r.id, r.name]))
	return g.relations.map((r) => `${n.get(r.from)} -${r.kind}-> ${n.get(r.to)}`)
}

describe('ARN parsing', () => {
	it('maps ARNs to CloudFormation types and canonical ids', () => {
		expect(arnInfo('arn:aws:lambda:us-east-1:111122223333:function:fn:live')).toMatchObject({ id: 'arn:aws:lambda:us-east-1:111122223333:function:fn', type: 'AWS::Lambda::Function', name: 'fn' })
		expect(arnInfo('arn:aws:ec2:us-east-1:111122223333:vpc/vpc-1')).toMatchObject({ id: 'vpc-1', type: 'AWS::EC2::VPC' })
		expect(arnInfo('arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/web/abc')).toMatchObject({ type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', name: 'web' })
		expect(arnInfo('arn:aws:secretsmanager:us-east-1:1:secret:prod/db-AbCdEf')).toMatchObject({ name: 'prod/db' })
		expect(arnInfo('arn:aws:cloudfront::1:distribution/E1')).toMatchObject({ global: true })
		expect(arnInfo('arn:aws:iam::1:role/x')).toBeNull()
		expect(arnInfo('arn:aws:dynamodb:us-east-1:1:table/t/stream/2026')).toBeNull()
		expect(queueUrlToArn('https://sqs.us-east-1.amazonaws.com/111122223333/orders')).toBe('arn:aws:sqs:us-east-1:111122223333:orders')
		expect(listenerToLb('arn:aws:elasticloadbalancing:us-east-1:1:listener/app/web/abc/def')).toBe('arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/web/abc')
	})
})

describe('AWS normalizer', () => {
	const g = normalizeCloud('aws', fixture('aws/describe-bundle.json'))

	it('builds account → region → VPC → subnet containment', () => {
		expect(g.scope).toBe('111122223333')
		expect(parentName(g, 'shop-prod')).toBe('us-east-1')
		expect(parentName(g, 'us-east-1')).toBe('AWS account 111122223333')
		expect(parentName(g, 'public-a')).toBe('shop-prod')
		expect(byName(g, 'public-a').props).toMatchObject({ cidr: '10.0.0.0/24', public: 'true' })
		// single subnet → subnet; several subnets → the VPC
		expect(parentName(g, 'bastion')).toBe('public-a')
		expect(parentName(g, 'worker')).toBe('private-b')
		expect(parentName(g, 'web')).toBe('shop-prod')
		expect(parentName(g, 'order-processor')).toBe('shop-prod')
		expect(parentName(g, 'shop-db')).toBe('shop-prod')
		// no VPC: region; global services: the account
		expect(parentName(g, 'order-api')).toBe('us-east-1')
		expect(parentName(g, 'shop.example.com')).toBe('AWS account 111122223333')
		expect(parentName(g, 'example.com')).toBe('AWS account 111122223333')
	})

	it('infers relations from event sources, integrations, LBs, SGs, DNS, CloudFront, SNS, EventBridge, ECS and env refs', () => {
		const r = rels(g)
		expect(r).toEqual(
			expect.arrayContaining([
				'orders-queue -triggers-> order-processor',
				'email-queue -triggers-> notifier',
				'order-events -subscribes-> email-queue',
				'nightly-report -triggers-> report-generator',
				'order-placed -triggers-> order-events',
				'shop-bus -routes-> order-placed',
				'shop-api -invokes-> order-api',
				'shop-api -routes-> shop-web-alb',
				'shop-web-alb -routes-> web',
				'shop.example.com -origin-> shop-static-111122223333',
				'shop.example.com -origin-> shop-web-alb',
				'example.com -alias-> shop.example.com',
				'example.com -alias-> shop-web-alb',
				'web -runs-on-> shop-cluster',
				'web -connects-> shop-db',
				'bastion -connects-> shop-db',
				'order-processor -env-> orders',
				'order-processor -env-> order-events',
				'order-api -env-> orders-queue',
				'web -env-> shop-db',
				'web -env-> prod/stripe',
				'worker -env-> shop-cache',
			]),
		)
		// the email subscription endpoint is never a resource, and no relation targets it
		expect(g.resources.some((x) => x.name.includes('@'))).toBe(false)
	})

	it('folds Aurora members into their cluster and drops IAM / logs noise', () => {
		expect(g.resources.some((x) => x.name === 'shop-db-1')).toBe(false)
		expect(g.resources.some((x) => x.type.startsWith('AWS::IAM') || x.type.startsWith('AWS::Logs'))).toBe(false)
		expect(rels(g)).not.toContain('web -env-> shop-db-1')
	})

	it('keeps env var names, never values', () => {
		const fn = byName(g, 'order-processor')
		expect(fn.props.envKeys).toBe('API_TOKEN,EVENTS_TOPIC_ARN,LOG_LEVEL,TABLE_NAME')
		expect(JSON.stringify(g)).not.toMatch(/tok_live|hunter2|s3cr3t|very-secret-session/)
	})

	it('reads an AWS Config snapshot (relationships, configuration, deleted items skipped)', () => {
		const c = normalizeAws(fixture('aws/config-snapshot.json'))
		expect(c.scope).toBe('444455556666')
		expect(parentName(c, 'billing-private-a')).toBe('billing-vpc')
		expect(parentName(c, 'billing-api-1')).toBe('billing-private-a')
		expect(parentName(c, 'invoice-mailer')).toBe('billing-private-a')
		expect(c.resources.some((x) => x.name === 'old-ledger')).toBe(false)
		expect(rels(c)).toEqual(expect.arrayContaining(['billing-api-1 -connects-> billing-mysql', 'invoice-mailer -env-> invoices']))
		expect(JSON.stringify(c)).not.toContain('config-snapshot-secret')
	})

	it('reads select-resource-config rows (JSON strings)', () => {
		const snap = fixture('aws/config-snapshot.json') as { configurationItems: unknown[] }
		const c = normalizeAws({ Results: snap.configurationItems.map((x) => JSON.stringify(x)), QueryInfo: { SelectFields: [] } })
		expect(c.resources.map((x) => x.name)).toEqual(expect.arrayContaining(['billing-vpc', 'billing-mysql', 'invoices']))
	})

	it('reads Tagging API output: types from ARNs, sub-resources and noise skipped, tags redacted', () => {
		const t = normalizeAws(fixture('aws/tagging-get-resources.json'))
		const names = t.resources.map((x) => x.name)
		expect(names).toEqual(expect.arrayContaining(['catalog-sync', 'catalog-search', 'catalog-items', 'catalog-ingest', 'catalog-changes', 'catalog-import', 'catalog-clicks']))
		expect(names.filter((n) => n === 'catalog-search')).toHaveLength(1) // alias ARN merged
		expect(t.resources.some((x) => x.type === 'AWS::KMS::Key' || x.type.startsWith('AWS::CloudFormation'))).toBe(false)
		expect(byName(t, 'catalog-images-777788889999').tags['github-token']).toBe('[redacted]')
		expect(byName(t, 'catalog-images-777788889999').region).toBe('eu-west-1')
		expect(byName(t, 'sales').type).toBe('AWS::Quicksight::Dashboard') // unknown service kept
	})
})

describe('GCP normalizer', () => {
	const g = normalizeCloud('gcp', [fixture('gcp/search-all-resources.json'), fixture('gcp/assets-resource.json')])

	it('builds project → VPC → subnet and region groups, mapping project numbers to ids', () => {
		expect(g.scope).toBe('acme-shop-prod')
		expect(parentName(g, 'shop-vpc')).toBe('GCP project acme-shop-prod')
		expect(parentName(g, 'shop-us-central1')).toBe('shop-vpc')
		expect(parentName(g, 'legacy-vm-1')).toBe('shop-us-central1')
		expect(parentName(g, 'legacy-mig')).toBe('shop-us-central1')
		expect(parentName(g, 'shop-gke')).toBe('shop-europe-west1')
		expect(parentName(g, 'shop-pg')).toBe('shop-vpc')
		expect(parentName(g, 'checkout-api')).toBe('us-central1')
		expect(parentName(g, 'stripe-key')).toBe('GCP project acme-shop-prod')
	})

	it('infers LB backends through proxies / URL maps / NEGs, Pub/Sub, Eventarc, functions and env refs', () => {
		const r = rels(g)
		expect(r).toEqual(
			expect.arrayContaining([
				'shop-https-fr -routes-> checkout-api',
				'shop-https-fr -routes-> acme-shop-static',
				'shop-https-fr -routes-> legacy-mig',
				'legacy-mig -attached-> legacy-vm-1',
				'orders -subscribes-> fulfillment',
				'orders -subscribes-> analytics',
				'orders -triggers-> send-receipt',
				'exports -triggers-> export-orders',
				'acme-shop-uploads -triggers-> image-resizer',
				'nightly-export -publishes-> exports',
				'checkout-api -connects-> shop-pg',
				'checkout-api -uses-> shop-connector',
				'checkout-api -env-> stripe-key',
				'checkout-api -env-> orders',
				'checkout-api -env-> shop-cache',
			]),
		)
	})

	it('draws a 2nd-gen function once (its backing Cloud Run service folds into it)', () => {
		expect(g.resources.filter((x) => x.name === 'send-receipt')).toHaveLength(1)
		expect(byName(g, 'send-receipt').type).toBe('cloudfunctions.googleapis.com/CloudFunction')
	})

	it('works from search-all-resources alone (breadth, labels; no relations)', () => {
		const s = normalizeGcp(fixture('gcp/search-all-resources.json'))
		expect(s.resources.length).toBeGreaterThan(30)
		expect(byName(s, 'checkout-api').tags.app).toBe('checkout')
	})

	it('reads newline-delimited exportAssets output', () => {
		const lines = (fixture('gcp/assets-resource.json') as unknown[]).map((a) => JSON.stringify(a)).join('\n')
		const parsed = parseExportText(lines)
		expect(detectCloudExport(parsed)).toBe('gcp')
		expect(normalizeGcp(parsed).resources.length).toBeGreaterThan(20)
	})
})

describe('Azure normalizer', () => {
	const g = normalizeCloud('azure', fixture('azure/resource-graph.json'))

	it('builds subscription → region → VNet → subnet from VNet subnets and NIC / integration / PE links', () => {
		expect(g.scope).toBe('00000000-1111-2222-3333-444444444444')
		expect(parentName(g, 'vnet-shop')).toBe('eastus')
		expect(parentName(g, 'snet-app')).toBe('vnet-shop')
		expect(parentName(g, 'app-shop-web')).toBe('snet-app')
		expect(parentName(g, 'vm-jumpbox')).toBe('snet-vm')
		expect(parentName(g, 'pe-sql')).toBe('snet-pe')
		expect(parentName(g, 'aks-shop')).toBe('snet-aks')
		expect(parentName(g, 'agw-shop')).toBe('snet-agw')
		expect(parentName(g, 'fd-shop')).toBe('Azure subscription 00000000-1111-2222-3333-444444444444')
	})

	it('infers plans, private endpoints, gateways, LB → NIC → VM, Front Door, Event Grid and Container Apps', () => {
		expect(rels(g)).toEqual(
			expect.arrayContaining([
				'app-shop-web -runs-on-> asp-shop',
				'func-shop-orders -runs-on-> asp-shop',
				'pe-sql -private-link-> sql-shop',
				'pe-kv -private-link-> kv-shop',
				'agw-shop -routes-> app-shop-web',
				'fd-shop -origin-> app-shop-web',
				'lb-internal -routes-> vm-jumpbox',
				'stshopdata -publishes-> evgt-stshopdata',
				'ca-catalog-api -runs-on-> cae-catalog',
			]),
		)
		expect(byName(g, 'func-shop-orders').type).toBe('microsoft.web/sites/functionapp')
		// databases are drawn as their server
		expect(g.resources.some((x) => x.name === 'sqldb-orders')).toBe(false)
	})

	it('accepts a bare array, the REST table format and redacts secret tags', () => {
		const rows = (fixture('azure/resource-graph.json') as { data: Record<string, unknown>[] }).data
		expect(normalizeAzure(rows).resources.length).toBe(g.resources.length)
		const cols = ['id', 'name', 'type', 'location', 'subscriptionId', 'tags', 'properties']
		const table = { totalRecords: rows.length, count: rows.length, data: { columns: cols.map((name) => ({ name, type: 'string' })), rows: rows.map((r) => cols.map((c) => r[c])) } }
		expect(detectCloudExport(table)).toBe('azure')
		expect(normalizeAzure(table).resources.length).toBe(g.resources.length)
		expect(byName(g, 'ca-catalog-api').tags['db-password']).toBe('[redacted]')
		expect(byName(g, 'ca-catalog-api').tags.app).toBe('catalog')
	})
})

describe('format detection', () => {
	it('tells the three providers apart and rejects other JSON', () => {
		expect(detectCloudExport(fixture('aws/describe-bundle.json'))).toBe('aws')
		expect(detectCloudExport(fixture('aws/config-snapshot.json'))).toBe('aws')
		expect(detectCloudExport(fixture('aws/tagging-get-resources.json'))).toBe('aws')
		expect(detectCloudExport(fixture('gcp/search-all-resources.json'))).toBe('gcp')
		expect(detectCloudExport(fixture('gcp/assets-resource.json'))).toBe('gcp')
		expect(detectCloudExport(fixture('azure/resource-graph.json'))).toBe('azure')
		expect(detectCloudExport({ name: 'pkg', version: '1.0.0' })).toBeNull()
		expect(detectCloudExport([1, 2, 3])).toBeNull()
		expect(parseExportText(fixtureText('aws/describe-bundle.json'))).toBeTruthy()
	})
})
