import { resolveIcon } from '@octo-draw/core'
import { describe, expect, it } from 'vitest'
import { fixture, files } from '../test/helpers'
import { attributes, scanBlocks, stringValue, stripComments } from './hcl'
import { analyzeTerraform, iconForTerraformType, TERRAFORM_TYPE_ICONS } from './terraform'

describe('HCL block scanner', () => {
	it('finds top-level blocks, skipping comments, strings and heredocs', () => {
		const src = `# resource "x" "y" {\nresource "aws_s3_bucket" "a" {\n  bucket = "has } brace"\n  policy = <<EOT\n{ "a": { } }\nEOT\n  tags = { a = "b" }\n}\n/* module "m" { } */\nmodule "vpc" {\n  source = "./vpc"\n}\n`
		const blocks = scanBlocks(src)
		expect(blocks.map((b) => [b.type, ...b.labels])).toEqual([['resource', 'aws_s3_bucket', 'a'], ['module', 'vpc']])
		expect(attributes(blocks[0].body)).toMatchObject({ bucket: '"has } brace"' })
		expect(stringValue(attributes(blocks[1].body).source)).toBe('./vpc')
		expect(stripComments('a = 1 // c\nb = "//not"')).toBe('a = 1 \nb = "//not"')
	})
})

describe('terraform analyzer', () => {
	it('maps types to icons, references to edges and groups by VPC, subnet, module and resource group', async () => {
		const r = analyzeTerraform(await fixture('terraform'))
		const byKey = Object.fromEntries(r.root.nodes.map((n) => [n.key, n]))
		expect(byKey['aws_lambda_function.api']).toMatchObject({ icon: 'aws-lambda', parent: 'aws_subnet.private' })
		expect(byKey['aws_subnet.private']).toMatchObject({ parent: 'aws_vpc.main', isContainer: true })
		expect(byKey['aws_dynamodb_table.orders']).toMatchObject({ icon: 'aws-dynamodb', shape: 'cylinder' })
		expect(byKey['aws_lb.public'].parent).toBe('module.network')
		expect(byKey['module.eks'].icon).toBe('aws-eks')
		expect(byKey['azurerm_linux_function_app.fn']).toMatchObject({ icon: 'azure-functions', parent: 'azurerm_resource_group.rg' })
		expect(byKey['google_cloud_run_v2_service.web'].icon).toBe('gcp-cloud-run')
		expect(byKey['aws_instance.commented_out']).toBeUndefined()
		expect(byKey['aws_lambda_permission.apigw']).toBeUndefined()
		const edges = r.root.edges.map((e) => `${e.from}>${e.to}${e.dotted ? ' (dotted)' : ''}`)
		expect(edges).toEqual(expect.arrayContaining([
			'aws_lambda_function.api>aws_dynamodb_table.orders',
			'aws_lambda_function.api>aws_sqs_queue.jobs',
			'aws_lambda_function.api>aws_s3_bucket.uploads',
			'aws_lambda_function.api>aws_iam_role.lambda (dotted)',
			'aws_cloudfront_distribution.cdn>aws_s3_bucket.uploads',
			// folded from aws_lambda_permission
			'aws_apigatewayv2_api.http>aws_lambda_function.api (dotted)',
		]))
		// nesting implies the subnet / VPC link: no edge to a container
		expect(edges.some((e) => e.includes('>aws_subnet.private'))).toBe(false)
	})

	it('every icon in the type table resolves', () => {
		for (const [, icon] of TERRAFORM_TYPE_ICONS) expect(resolveIcon(icon), icon).not.toBeNull()
		expect(iconForTerraformType('aws_kinesis_firehose_delivery_stream')).toBe('aws-kinesis')
		expect(iconForTerraformType('aws_totally_new_service')).toBe('aws')
		expect(iconForTerraformType('random_password')).toBe('terraform')
	})

	it('returns nothing without .tf files', () => {
		expect(analyzeTerraform(files({ 'a.ts': '' })).confidence).toBe(0)
	})
})
