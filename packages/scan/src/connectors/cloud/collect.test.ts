import { describe, expect, it } from 'vitest'
import { assertReadOnlyAws, AWS_READ_OPERATIONS, collectAws, scrubEnvValue } from './aws/collect'
import { collectGcp, GCP_API, RELATION_ASSET_TYPES } from './gcp/collect'
import { collectAzure, resourceGraphQuery } from './azure/collect'
import { cloudExportToOcto } from './pipeline'
import { mockAwsApi, mockAzureHttp, mockGcpHttp } from './mocks'

describe('AWS collector (mocked SDK)', () => {
	it('only calls allowlisted read operations, pages through tokens, and feeds the normalizer', async () => {
		const api = mockAwsApi()
		const inv = await collectAws(api, { regions: ['us-east-1', 'us-west-2'] })
		expect(api.calls.length).toBeGreaterThan(30)
		for (const c of api.calls) {
			expect(c.op).toMatch(/^(Describe|List|Get|Search)/)
			expect(AWS_READ_OPERATIONS[c.service as keyof typeof AWS_READ_OPERATIONS]).toContain(c.op)
		}
		// paging: tagging and lambda were each called twice in us-east-1 with the next token
		expect(api.calls.filter((c) => c.op === 'ListFunctions' && c.region === 'us-east-1').map((c) => c.input.Marker)).toEqual([undefined, 'm2'])
		expect(api.calls.filter((c) => c.op === 'GetResources' && c.service === 'tagging' && c.region === 'us-east-1').map((c) => c.input.PaginationToken)).toEqual([undefined, 'page-2'])
		// per-parent calls carry their parent in the response context
		expect(inv.responses.some((r) => r.op === 'elbv2:DescribeTargetHealth' && r.context?.TargetGroupArn)).toBe(true)
		expect(inv.responses.some((r) => r.op === 'eventbridge:ListTargetsByRule' && (r.context?.RuleArn || r.context?.Rule))).toBe(true)
		expect(inv.account).toBe('111122223333')
		// Resource Explorer without a view is not an error: the Tagging API covers it
		expect(inv.warnings).toEqual([])

		const out = cloudExportToOcto(inv, { defaultRegion: 'us-east-1' })!
		expect(out.provider).toBe('aws')
		expect(out.code).toContain('orders-queue > order-processor: triggers')
		expect(out.code).toContain('shop-api > order-api: invokes')
		expect(out.code).toContain('example.com > shop-web-alb: api.example.com')
	})

	it('scrubs secrets from the raw inventory it keeps in memory', async () => {
		const inv = await collectAws(mockAwsApi(), { regions: ['us-east-1'] })
		const text = JSON.stringify(inv)
		for (const s of ['tok_live', 'hunter2', 's3cr3t-pass', 'very-secret-session-value', 'never-read-this', 'AIDAEXAMPLE', 'requestId']) expect(text).not.toContain(s)
		// references survive
		expect(text).toContain('shop-db.cluster-c1a2b3c4d5e6.us-east-1.rds.amazonaws.com')
		expect(text).toContain('arn:aws:secretsmanager:us-east-1:111122223333:secret:prod/stripe-AbCdEf')
		expect(scrubEnvValue('DB_PASSWORD', 'x')).toBe('[redacted]')
		expect(scrubEnvValue('SECRET_ARN', 'arn:aws:secretsmanager:us-east-1:1:secret:a')).toBe('arn:aws:secretsmanager:us-east-1:1:secret:a')
		expect(scrubEnvValue('DATABASE_URL', 'postgres://u:p@db.local:5432/x')).toBe('postgres://db.local:5432/x')
	})

	it('uses Resource Explorer for breadth when a view exists', async () => {
		const api = mockAwsApi({ failExplorer: false })
		const inv = await collectAws(api, { regions: ['us-east-1'] })
		expect(inv.responses.some((r) => r.op === 'resource-explorer-2:Search' && Array.isArray((r.data as { ResourceTagMappingList?: unknown[] }).ResourceTagMappingList))).toBe(true)
	})

	it('caps pages and says so', async () => {
		const inv = await collectAws(mockAwsApi(), { regions: ['us-east-1'], maxPages: 1 })
		expect(inv.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/lambda:ListFunctions in us-east-1: stopped after 1 pages/)]))
	})

	it('fails fast without credentials and never echoes request inputs', async () => {
		await expect(collectAws(mockAwsApi({ failAuth: true }), { regions: ['us-east-1'] })).rejects.toThrow(/could not authenticate to AWS: sts:GetCallerIdentity in us-east-1 failed: InvalidClientTokenId/)
	})

	it('refuses anything outside the read-only allowlist', () => {
		expect(() => assertReadOnlyAws('lambda', 'InvokeFunction')).toThrow(/refusing/)
		expect(() => assertReadOnlyAws('ec2', 'TerminateInstances')).toThrow(/refusing/)
		expect(() => assertReadOnlyAws('ec2', 'DescribeImages')).toThrow(/refusing/) // read, but not needed
		expect(() => assertReadOnlyAws('ec2', 'DescribeVpcs')).not.toThrow()
		for (const [svc, ops] of Object.entries(AWS_READ_OPERATIONS)) for (const op of ops) expect(op, `${svc}:${op}`).toMatch(/^(Describe|List|Get|Search)/)
	})
})

describe('GCP collector (mocked HTTP)', () => {
	it('pages searchAllResources, lists relation-bearing assets, and tolerates missing relationship access', async () => {
		const http = mockGcpHttp()
		const inv = await collectGcp(http, { scope: 'projects/acme-shop-prod' })
		expect(http.urls[0]).toBe(`${GCP_API}/projects/acme-shop-prod:searchAllResources?pageSize=500`)
		expect(http.urls[1]).toContain('pageToken=p2')
		const assetsUrl = new URL(http.urls[2])
		expect(assetsUrl.pathname).toBe('/v1/projects/acme-shop-prod/assets')
		expect(assetsUrl.searchParams.getAll('assetTypes')).toEqual(RELATION_ASSET_TYPES)
		expect(inv.resources.length).toBe(37)
		expect(inv.assets.length).toBeGreaterThan(20)
		expect(inv.warnings).toEqual([expect.stringMatching(/RELATIONSHIP unavailable \(400\)/)])
		const out = cloudExportToOcto(inv)!
		expect(out.provider).toBe('gcp')
		expect(out.code).toContain('shop-https-fr > checkout-api: routes')
	})

	it('rejects malformed scopes before any request', async () => {
		const http = mockGcpHttp()
		await expect(collectGcp(http, { scope: 'projects/../../x' })).rejects.toThrow(/invalid Google Cloud scope/)
		await expect(collectGcp(http, { scope: 'buckets/x' })).rejects.toThrow()
		expect(http.urls).toEqual([])
	})
})

describe('Azure collector (mocked HTTP)', () => {
	it('lists enabled subscriptions, pages Resource Graph with $skipToken and applies the KQL filter', async () => {
		const http = mockAzureHttp()
		const inv = await collectAzure(http, { kql: "resourceGroup =~ 'rg-shop-prod'" })
		expect(http.gets).toHaveLength(1)
		expect(inv.subscriptions).toEqual(['00000000-1111-2222-3333-444444444444'])
		expect(http.bodies).toHaveLength(2)
		expect(http.bodies[0].query).toBe(resourceGraphQuery("resourceGroup =~ 'rg-shop-prod'"))
		expect(String(http.bodies[0].query)).toMatch(/^Resources \| where resourceGroup =~ 'rg-shop-prod' \| project id, name, type/)
		expect((http.bodies[1].options as Record<string, unknown>).$skipToken).toBe('ew0KICAiJGlkIjogIjEiDQp9')
		const out = cloudExportToOcto(inv)!
		expect(out.provider).toBe('azure')
		expect(out.code).toContain('agw-shop > app-shop-web: routes')
	})

	it('validates subscription ids', async () => {
		await expect(collectAzure(mockAzureHttp(), { subscriptions: ['not-a-guid'] })).rejects.toThrow(/invalid Azure subscription/)
	})
})
