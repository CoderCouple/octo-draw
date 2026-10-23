import { describe, expect, it } from 'vitest'
import { parseOctoPages } from '@octo-draw/core'
import { ConnectorError, type ConnectorContext } from '../types'
import { createAwsConnector, createAzureConnector, createGcpConnector, parseAwsInput, parseAzureInput, parseGcpInput } from './connectors'
import { fixturePath, fixtureText, PLANTED_SECRETS } from './fixtures'
import { mockAwsApi, mockAzureHttp, mockGcpHttp } from './mocks'
import { redactTags } from './model'

const ctx: ConnectorContext = {
	fetch: (() => {
		throw new Error('network is not allowed in tests')
	}) as unknown as typeof fetch,
	env: {},
}

/** Reads fixtures by bare name (`describe-bundle.json`) or path. */
const readFile = async (p: string) => {
	const rel = p.includes('/') ? p.split('fixtures/cloud/').pop()! : ({ 'describe-bundle.json': 'aws/describe-bundle.json', 'resource-graph.json': 'azure/resource-graph.json', 'search.json': 'gcp/search-all-resources.json', 'assets.json': 'gcp/assets-resource.json', 'config.json': 'aws/config-snapshot.json' } as Record<string, string>)[p]
	if (!rel) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
	return fixtureText(rel)
}

const noLive = {
	aws: async () => {
		throw new Error('live AWS must not be used here')
	},
	gcp: async () => {
		throw new Error('live GCP must not be used here')
	},
	azure: async () => {
		throw new Error('live Azure must not be used here')
	},
}

describe('parse', () => {
	it('reads aws: inputs (profile, regions, files)', () => {
		expect(parseAwsInput('aws:')).toEqual({ kind: 'aws', id: 'default', options: {} })
		expect(parseAwsInput('aws:prod@us-east-1,us-west-2')).toEqual({ kind: 'aws', id: 'prod', ref: 'us-east-1,us-west-2', options: { profile: 'prod', regions: ['us-east-1', 'us-west-2'] } })
		expect(parseAwsInput('aws:us-east-1')).toMatchObject({ options: { regions: ['us-east-1'] } })
		expect(parseAwsInput('aws:@eu-west-1')).toMatchObject({ id: 'default', options: { regions: ['eu-west-1'] } })
		expect(parseAwsInput('aws:staging')).toMatchObject({ id: 'staging', options: { profile: 'staging' } })
		expect(parseAwsInput('aws:./exports/aws.json')).toEqual({ kind: 'aws', id: './exports/aws.json', options: { file: './exports/aws.json' } })
		expect(parseAwsInput('aws:prod@mars-1')).toBeNull()
		expect(parseAwsInput('aws:bad profile!')).toBeNull()
		expect(parseAwsInput('github.com/o/r')).toBeNull()
		expect(parseAwsInput('./some/folder')).toBeNull()
	})

	it('claims bare export paths and guesses the provider from the name', () => {
		expect(parseAwsInput('inventory.json')).toMatchObject({ kind: 'aws', options: { file: 'inventory.json', detect: true } })
		expect(parseAwsInput('~/Downloads/gcp-assets.json')).toMatchObject({ kind: 'gcp', options: { detect: true } })
		expect(parseAwsInput('/tmp/azure-graph.json')).toMatchObject({ kind: 'azure' })
		expect(parseAwsInput('https://example.com/x.json')).toBeNull()
		expect(parseAwsInput('gcp:/data/a.json')).toBeNull()
		expect(parseAwsInput('hf:org/model.json')).toBeNull()
		expect(parseAwsInput('C:\\exports\\aws.json')).toMatchObject({ options: { detect: true } })
	})

	it('reads gcp: and azure: inputs', () => {
		expect(parseGcpInput('gcp:acme-shop-prod')).toEqual({ kind: 'gcp', id: 'acme-shop-prod', options: { scope: 'projects/acme-shop-prod' } })
		expect(parseGcpInput('gcp:folders/123')).toMatchObject({ options: { scope: 'folders/123' } })
		expect(parseGcpInput('gcp:organizations/456')).toMatchObject({ options: { scope: 'organizations/456' } })
		expect(parseGcpInput('gcp:assets.json')).toMatchObject({ options: { file: 'assets.json' } })
		expect(parseGcpInput('gcp:Bad_Project')).toBeNull()
		expect(parseAzureInput('azure:00000000-1111-2222-3333-444444444444')).toEqual({ kind: 'azure', id: '00000000-1111-2222-3333-444444444444', options: { subscriptions: ['00000000-1111-2222-3333-444444444444'] } })
		expect(parseAzureInput('azure:')).toEqual({ kind: 'azure', id: 'all', options: {} })
		expect(parseAzureInput('azure:nope')).toBeNull()
		expect(parseAzureInput('azure:graph.json')).toMatchObject({ options: { file: 'graph.json' } })
	})
})

describe('offline import', () => {
	const aws = createAwsConnector({ ...noLive, readFile })
	const gcp = createGcpConnector({ ...noLive, readFile })
	const azure = createAzureConnector({ ...noLive, readFile })

	it('scans an AWS export file into multi-page octo with findings', async () => {
		const r = await aws.scan(parseAwsInput('aws:describe-bundle.json')!, ctx)
		expect(r.source).toEqual({ kind: 'aws', id: 'describe-bundle.json', options: { file: 'describe-bundle.json' } })
		expect(r.findings[0]).toMatchObject({ analyzer: 'aws', confidence: 0.85 })
		expect(r.findings[0].notes?.[0]).toMatch(/^describe-bundle\.json: \d+ resources \(\d+ drawn\) in 1 region$/)
		expect(parseOctoPages(r.code).diagnostics).toEqual([])
		expect(r.code).toContain('title AWS account 111122223333')
	})

	it('detects the provider of a bare path and combines several files', async () => {
		const r = await aws.scan(parseAwsInput('resource-graph.json')!, ctx)
		expect(r.source.kind).toBe('azure')
		expect(r.code).toContain('vnet-shop')
		const g = await gcp.scan(parseGcpInput('gcp:search.json,assets.json')!, ctx)
		expect(g.code).toContain('shop-https-fr > checkout-api: routes')
	})

	it('accepts the export inline (server uploads) and never echoes it back', async () => {
		const r = await azure.scan({ kind: 'azure', id: 'upload', options: { export: fixtureText('azure/resource-graph.json'), title: 'Contoso prod' } }, ctx)
		expect(r.code).toContain('title Contoso prod')
		expect(JSON.stringify(r.source)).not.toContain('properties')
		expect(r.source.options).toEqual({})
	})

	it('explains wrong-provider files, unreadable files and non-exports without echoing content', async () => {
		await expect(gcp.scan(parseGcpInput('gcp:describe-bundle.json')!, ctx)).rejects.toThrow(/looks like an AWS export, not Google Cloud/)
		await expect(aws.scan(parseAwsInput('aws:missing.json')!, ctx)).rejects.toThrow(/cannot read missing\.json: ENOENT/)
		const notCloud = createAwsConnector({ readFile: async () => '{"name":"pkg","version":"1.0.0","secret":"zzz-top"}' })
		const err = await notCloud.scan(parseAwsInput('aws:package.json')!, ctx).catch((e) => e)
		expect(err).toBeInstanceOf(ConnectorError)
		expect(err.message).toMatch(/not a recognised AWS, Google Cloud or Azure export/)
		expect(err.message).not.toContain('zzz-top')
		const notJson = createAwsConnector({ readFile: async () => 'password=hunter2' })
		const err2 = await notJson.scan(parseAwsInput('aws:x.json')!, ctx).catch((e) => e)
		expect(err2.message).toBe('x.json is not JSON (expected a cloud inventory export)')
	})

	it('refuses file paths when the caller disallows them (servers)', async () => {
		const ref = parseAwsInput('aws:/etc/passwd.json')!
		await expect(aws.scan({ ...ref, options: { ...ref.options, allowFiles: false } }, ctx)).rejects.toMatchObject({ status: 403 })
	})

	it('reads real files from disk by default', async () => {
		const real = createAwsConnector(noLive)
		const r = await real.scan(parseAwsInput(`aws:${fixturePath('aws/config-snapshot.json')}`)!, ctx)
		expect(r.code).toContain('billing-mysql')
		expect(r.source.options).toEqual({ file: 'config-snapshot.json' })
	})
})

describe('live scans (mocked clients)', () => {
	it('AWS: credential chain options reach the client factory, and the diagram is built', async () => {
		let got: unknown
		const api = mockAwsApi()
		const c = createAwsConnector({
			aws: async (o) => {
				got = o
				return api
			},
		})
		const r = await c.scan(parseAwsInput('aws:prod@us-east-1')!, ctx)
		expect(got).toMatchObject({ profile: 'prod' })
		expect(r.source).toMatchObject({ kind: 'aws', id: 'prod', options: { profile: 'prod', regions: ['us-east-1'] } })
		expect(r.findings[0].notes?.[0]).toMatch(/^account 111122223333: /)
		expect(r.code).toContain('order-processor')
		expect(api.calls.every((x) => /^(Describe|List|Get|Search)/.test(x.op))).toBe(true)
	})

	it('AWS: env region default, role ARN validation, auth failures as 401', async () => {
		const api = mockAwsApi()
		const c = createAwsConnector({ aws: async () => api })
		await c.scan(parseAwsInput('aws:')!, { ...ctx, env: { AWS_REGION: 'eu-central-1' } })
		expect(new Set(api.calls.filter((x) => x.service === 'ec2').map((x) => x.region))).toEqual(new Set(['eu-central-1']))
		await expect(c.scan({ kind: 'aws', id: 'x', options: { roleArn: 'arn:aws:iam::bad' } }, ctx)).rejects.toThrow(/roleArn must be an IAM role ARN/)
		const bad = createAwsConnector({ aws: async () => mockAwsApi({ failAuth: true }) })
		await expect(bad.scan(parseAwsInput('aws:')!, ctx)).rejects.toMatchObject({ status: 401 })
	})

	it('GCP and Azure', async () => {
		const g = await createGcpConnector({ gcp: async () => mockGcpHttp() }).scan(parseGcpInput('gcp:acme-shop-prod')!, ctx)
		expect(g.code).toContain('title GCP project acme-shop-prod')
		expect(g.warnings).toEqual([expect.stringMatching(/RELATIONSHIP unavailable/)])
		const http = mockAzureHttp()
		const a = await createAzureConnector({ azure: async () => http }).scan({ kind: 'azure', id: 'x', options: { subscriptions: ['00000000-1111-2222-3333-444444444444'], kql: "type !~ 'microsoft.network/networkwatchers'" } }, ctx)
		expect(http.gets).toEqual([])
		expect(a.code).toContain('pe-sql')
	})
})

describe('redaction', () => {
	it('redacts secret-looking tag values and keeps the rest', () => {
		expect(redactTags({ Name: 'web', 'db-password': 'x', API_KEY: 'y', github_token: 'z', 'client-secret': 'w', app: 'shop' })).toEqual({ Name: 'web', 'db-password': '[redacted]', API_KEY: '[redacted]', github_token: '[redacted]', 'client-secret': '[redacted]', app: 'shop' })
	})

	it('no planted secret reaches any result (code, findings, warnings, source), offline or live', async () => {
		const results = [
			await createAwsConnector({ readFile }).scan(parseAwsInput('aws:describe-bundle.json')!, ctx),
			await createAwsConnector({ readFile }).scan(parseAwsInput('aws:config.json')!, ctx),
			await createAwsConnector({ readFile: async () => fixtureText('aws/tagging-get-resources.json') }).scan(parseAwsInput('aws:t.json')!, ctx),
			await createGcpConnector({ readFile }).scan(parseGcpInput('gcp:search.json,assets.json')!, ctx),
			await createAzureConnector({ readFile }).scan(parseAzureInput('azure:resource-graph.json')!, ctx),
			await createAwsConnector({ aws: async () => mockAwsApi() }).scan(parseAwsInput('aws:us-east-1')!, ctx),
			await createGcpConnector({ gcp: async () => mockGcpHttp() }).scan(parseGcpInput('gcp:acme-shop-prod')!, ctx),
			await createAzureConnector({ azure: async () => mockAzureHttp() }).scan(parseAzureInput('azure:')!, ctx),
		]
		for (const r of results) {
			const text = JSON.stringify(r)
			for (const s of PLANTED_SECRETS) expect(text, s).not.toContain(s)
		}
		// env vars appear only as reference edges named by the variable
		expect(results[0].code).toContain('env TABLE_NAME')
		expect(results[0].code).not.toMatch(/API_TOKEN|DB_PASSWORD|SESSION_SECRET/)
	})
})
