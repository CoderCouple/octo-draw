/**
 * Terraform analyzer (block scanner, not a full HCL parser): resources and
 * modules become nodes with vendor icons, references between blocks and
 * `depends_on` become edges, and resources are grouped by local module, VPC /
 * VNet / subnet, or Azure resource group when that can be read off attributes.
 */

import { resolveIcon } from '@octo-draw/core'
import { iconForResourceType } from '../connectors/cloud/catalog'
import { emptyResult, type AnalyzerResult, type ArchEdge, type ArchNode, type ScanFiles } from '../types'
import { dirname, join, KeyAllocator, plural } from '../util'
import { attributes, scanBlocks, stringValue } from './hcl'

/** Resource type prefix → icon. First match wins, so specific prefixes come first. */
const TYPE_ICONS: [string, string][] = [
	// AWS
	['aws_instance', 'aws-ec2'],
	['aws_launch_template', 'aws-ec2'],
	['aws_autoscaling_group', 'aws-ec2'],
	['aws_lambda', 'aws-lambda'],
	['aws_s3', 'aws-s3'],
	['aws_rds_cluster', 'aws-aurora'],
	['aws_db_', 'aws-rds'],
	['aws_dynamodb', 'aws-dynamodb'],
	['aws_elasticache', 'aws-elasticache'],
	['aws_redshift', 'aws-redshift'],
	['aws_sqs', 'aws-sqs'],
	['aws_sns', 'aws-sns'],
	['aws_cloudwatch_event', 'aws-eventbridge'],
	['aws_scheduler', 'aws-eventbridge'],
	['aws_kinesis', 'aws-kinesis'],
	['aws_msk', 'aws-msk'],
	['aws_sfn', 'aws-step-functions'],
	['aws_api_gateway', 'aws-api-gateway'],
	['aws_apigatewayv2', 'aws-api-gateway'],
	['aws_cloudfront', 'aws-cloudfront'],
	['aws_route53', 'aws-route-53'],
	['aws_lb', 'aws-elb'],
	['aws_alb', 'aws-elb'],
	['aws_elb', 'aws-elb'],
	['aws_vpc', 'aws-vpc'],
	['aws_subnet', 'network'],
	['aws_nat_gateway', 'router'],
	['aws_internet_gateway', 'globe'],
	['aws_security_group', 'security'],
	['aws_iam', 'aws-iam'],
	['aws_cognito', 'aws-cognito'],
	['aws_kms', 'aws-kms'],
	['aws_secretsmanager', 'aws-secrets-manager'],
	['aws_ssm_parameter', 'settings'],
	['aws_wafv2', 'aws-waf'],
	['aws_waf', 'aws-waf'],
	['aws_ecs', 'aws-ecs'],
	['aws_eks', 'aws-eks'],
	['aws_ecr', 'aws-ecr'],
	['aws_efs', 'aws-efs'],
	['aws_ebs', 'aws-ebs'],
	['aws_cloudwatch', 'aws-cloudwatch'],
	['aws_cloudtrail', 'aws-cloudtrail'],
	['aws_glue', 'aws-glue'],
	['aws_athena', 'aws-athena'],
	['aws_emr', 'aws-emr'],
	['aws_sagemaker', 'aws-sagemaker'],
	['aws_bedrock', 'aws-bedrock'],
	['aws_amplify', 'aws-amplify'],
	['aws_appsync', 'aws-appsync'],
	['aws_batch', 'aws-batch'],
	['aws_ses', 'aws-ses'],
	['aws_sesv2', 'aws-ses'],
	['aws_cloudformation', 'aws-cloudformation'],
	// Google Cloud
	['google_compute_instance', 'gcp-compute-engine'],
	['google_compute_network', 'gcp-vpc'],
	['google_compute_subnetwork', 'network'],
	['google_compute_firewall', 'security'],
	['google_compute_global_forwarding_rule', 'gcp-load-balancing'],
	['google_compute_forwarding_rule', 'gcp-load-balancing'],
	['google_compute_backend', 'gcp-load-balancing'],
	['google_compute_url_map', 'gcp-load-balancing'],
	['google_compute_target', 'gcp-load-balancing'],
	['google_compute_security_policy', 'gcp-cloud-armor'],
	['google_cloud_run', 'gcp-cloud-run'],
	['google_cloudfunctions', 'gcp-cloud-functions'],
	['google_app_engine', 'gcp-app-engine'],
	['google_container', 'gcp-gke'],
	['google_storage', 'gcp-cloud-storage'],
	['google_bigquery', 'gcp-bigquery'],
	['google_pubsub', 'gcp-pubsub'],
	['google_sql', 'gcp-cloud-sql'],
	['google_spanner', 'gcp-spanner'],
	['google_firestore', 'gcp-firestore'],
	['google_bigtable', 'gcp-bigtable'],
	['google_redis', 'gcp-memorystore'],
	['google_memcache', 'gcp-memorystore'],
	['google_dns', 'gcp-cloud-dns'],
	['google_service_account', 'gcp-iam'],
	['google_project_iam', 'gcp-iam'],
	['google_secret_manager', 'gcp-secret-manager'],
	['google_api_gateway', 'gcp-api-gateway'],
	['google_dataflow', 'gcp-dataflow'],
	['google_dataproc', 'gcp-dataproc'],
	['google_composer', 'gcp-composer'],
	['google_vertex_ai', 'gcp-vertex-ai'],
	['google_logging', 'gcp-cloud-logging'],
	['google_monitoring', 'gcp-cloud-monitoring'],
	['google_artifact_registry', 'gcp-artifact-registry'],
	['google_cloudbuild', 'gcp-cloud-build'],
	['google_cloud_scheduler', 'gcp-cloud-scheduler'],
	['google_cloud_tasks', 'gcp-cloud-tasks'],
	// Azure
	['azurerm_resource_group', 'azure'],
	['azurerm_linux_function_app', 'azure-functions'],
	['azurerm_windows_function_app', 'azure-functions'],
	['azurerm_function_app', 'azure-functions'],
	['azurerm_linux_virtual_machine', 'azure-virtual-machines'],
	['azurerm_windows_virtual_machine', 'azure-virtual-machines'],
	['azurerm_virtual_machine', 'azure-virtual-machines'],
	['azurerm_linux_web_app', 'azure-app-service'],
	['azurerm_windows_web_app', 'azure-app-service'],
	['azurerm_app_service', 'azure-app-service'],
	['azurerm_service_plan', 'azure-app-service'],
	['azurerm_kubernetes', 'azure-aks'],
	['azurerm_container_app', 'azure-container-apps'],
	['azurerm_container_group', 'azure-container-instances'],
	['azurerm_container_registry', 'azure-container-registry'],
	['azurerm_storage_container', 'azure-blob-storage'],
	['azurerm_storage', 'azure-storage-accounts'],
	['azurerm_mssql', 'azure-sql-database'],
	['azurerm_sql', 'azure-sql-database'],
	['azurerm_postgresql', 'postgres'],
	['azurerm_mysql', 'mysql'],
	['azurerm_cosmosdb', 'azure-cosmos-db'],
	['azurerm_redis', 'azure-cache-redis'],
	['azurerm_servicebus', 'azure-service-bus'],
	['azurerm_eventhub', 'azure-event-hubs'],
	['azurerm_eventgrid', 'azure-event-grid'],
	['azurerm_api_management', 'azure-api-management'],
	['azurerm_cdn_frontdoor', 'azure-front-door'],
	['azurerm_frontdoor', 'azure-front-door'],
	['azurerm_cdn', 'azure-cdn'],
	['azurerm_dns', 'azure-dns'],
	['azurerm_private_dns', 'azure-dns'],
	['azurerm_virtual_network', 'azure-virtual-network'],
	['azurerm_subnet', 'network'],
	['azurerm_network_security_group', 'security'],
	['azurerm_lb', 'azure-load-balancer'],
	['azurerm_application_gateway', 'azure-application-gateway'],
	['azurerm_key_vault', 'azure-key-vault'],
	['azurerm_log_analytics', 'azure-log-analytics'],
	['azurerm_monitor', 'azure-monitor'],
	['azurerm_application_insights', 'azure-monitor'],
	['azurerm_cognitive', 'azure-openai'],
	['azurerm_machine_learning', 'azure-machine-learning'],
	['azurerm_data_factory', 'azure-data-factory'],
	['azurerm_synapse', 'azure-synapse'],
	['azurerm_databricks', 'azure-databricks'],
	['azurerm_logic_app', 'azure-logic-apps'],
	['azurerm_static_site', 'azure-static-web-apps'],
	['azurerm_static_web_app', 'azure-static-web-apps'],
	['azurerm_user_assigned_identity', 'azure-entra-id'],
	['azurerm_role_assignment', 'azure-entra-id'],
	// Others
	['kubernetes_', 'kubernetes'],
	['helm_release', 'helm'],
	['cloudflare_', 'cloudflare'],
	['vercel_', 'vercel'],
	['github_', 'github'],
	['datadog_', 'datadog'],
]

export const TERRAFORM_TYPE_ICONS: readonly (readonly [string, string])[] = TYPE_ICONS

/** Plumbing resources that add noise but no architecture: dropped (their references still link the parent blocks). */
const GLUE = /(_association|_attachment|_security_group_rule|_ingress_rule|_egress_rule|_listener_rule|_policy_document|_permission|_event_target|_event_source_mapping|_subscription|_route|_route_table|_version|_object|_record|_member|_binding|_policy|_integration|_stage|_deployment)$|^(random|null|time|tls|local|terraform|archive|external)_/

export function iconForTerraformType(type: string): string {
	// the cloud connectors' exact type table wins when its icon resolves here (some names exist only in the downloaded official packs)
	const exact = iconForResourceType(type)
	if (exact && resolveIcon(exact)) return exact
	for (const [prefix, icon] of TYPE_ICONS) if (type.startsWith(prefix)) return icon
	const vendor = type.startsWith('aws_') ? 'aws' : type.startsWith('google_') ? 'gcp' : type.startsWith('azurerm_') ? 'azure' : undefined
	if (vendor) {
		const parts = type.split('_').slice(1)
		for (let n = Math.min(3, parts.length); n >= 1; n--) {
			const name: string = `${vendor}-${parts.slice(0, n).join('-')}`
			if (resolveIcon(name) && resolveIcon(name)!.name.startsWith(vendor)) return name
		}
		return vendor
	}
	return 'terraform'
}

/** Registry module source → icon (`terraform-aws-modules/vpc/aws` → `aws-vpc`). */
function iconForModuleSource(source: string | undefined): string {
	const m = source?.match(/(?:^|\/)terraform-(aws|google|azurerm)-modules?\/([\w-]+)|^([\w-]+)\/([\w-]+)\/(aws|google|azurerm)$/)
	if (m) {
		const vendor = { aws: 'aws', google: 'gcp', azurerm: 'azure' }[(m[1] ?? m[5]) as 'aws' | 'google' | 'azurerm']
		const svc = (m[2] ?? m[4]).replace(/^terraform-(aws|google|azurerm)-/, '')
		const name = `${vendor}-${svc}`
		const r = resolveIcon(name)
		return r && r.name.startsWith(vendor) ? name : vendor
	}
	return 'terraform'
}

interface Block {
	addr: string
	kind: 'resource' | 'module'
	type: string
	name: string
	dir: string
	attrs: Record<string, string>
	body: string
}

const GENERIC_NAMES = new Set(['this', 'main', 'default', 'primary', 'example', 'self', 'current'])

function humanType(type: string): string {
	return type.replace(/^(aws|google|azurerm)_/, '').replace(/_/g, ' ')
}

export function analyzeTerraform(files: ScanFiles): AnalyzerResult {
	const r = emptyResult('terraform')
	const tf = [...files.keys()].filter((p) => p.endsWith('.tf')).sort()
	if (!tf.length) return r
	const blocks: Block[] = []
	for (const path of tf) {
		const dir = dirname(path)
		for (const b of scanBlocks(files.get(path) ?? '')) {
			if (b.type === 'resource' && b.labels.length >= 2) blocks.push({ addr: `${b.labels[0]}.${b.labels[1]}`, kind: 'resource', type: b.labels[0], name: b.labels[1], dir, attrs: attributes(b.body), body: b.body })
			else if (b.type === 'module' && b.labels.length >= 1) blocks.push({ addr: `module.${b.labels[0]}`, kind: 'module', type: 'module', name: b.labels[0], dir, attrs: attributes(b.body), body: b.body })
		}
	}
	if (!blocks.length) return r

	// Local modules: module "x" { source = "./modules/x" } groups the resources in that directory.
	const moduleDirOwner = new Map<string, Block>()
	for (const b of blocks) {
		if (b.kind !== 'module') continue
		const src = stringValue(b.attrs.source)
		if (src && /^\.\.?\//.test(src)) moduleDirOwner.set(join(b.dir, src), b)
	}
	const glue = blocks.filter((b) => b.kind === 'resource' && GLUE.test(b.type))
	const kept = blocks.filter((b) => !glue.includes(b))
	const scoped = (b: Block) => `${b.dir}\u0000${b.addr}`
	const byScope = new Map(kept.map((b) => [scoped(b), b]))

	const keys = new KeyAllocator()
	const keyOf = new Map<Block, string>()
	const multiDir = new Set(kept.map((b) => b.dir)).size > 1
	for (const b of kept) keyOf.set(b, keys.take(multiDir && byScope.size !== new Set(kept.map((x) => x.addr)).size ? `${b.addr} (${b.dir || 'root'})` : b.addr))

	/** Blocks referenced from `text`, resolved within the same directory (Terraform scope). */
	const referenced = (text: string, dir: string): Block[] => {
		const out = new Set<Block>()
		for (const m of text.matchAll(/\b(module)\.([A-Za-z_][\w-]*)|\b([a-z][a-z0-9]*_[a-z0-9_]+)\.([A-Za-z_][\w-]*)/g)) {
			const addr = m[1] ? `module.${m[2]}` : `${m[3]}.${m[4]}`
			const b = byScope.get(`${dir}\u0000${addr}`)
			if (b) out.add(b)
		}
		return [...out]
	}

	const nodes: ArchNode[] = []
	const edges: ArchEdge[] = []
	const edgeSet = new Set<string>()
	const addEdge = (from: string, to: string, dotted = false) => {
		const id = `${from}\u0000${to}`
		if (from === to || edgeSet.has(id)) return
		edgeSet.add(id)
		edges.push({ from, to, dotted: dotted || undefined })
	}

	// containers: local modules, VPCs / networks / VNets, subnets, Azure resource groups
	const isContainerType = (t: string) => /^(aws_vpc|aws_subnet|google_compute_network|google_compute_subnetwork|azurerm_virtual_network|azurerm_subnet|azurerm_resource_group)$/.test(t)
	const parentOf = new Map<Block, Block>()
	const refAttr = (b: Block, names: RegExp, types: RegExp): Block | undefined => {
		for (const [k, v] of Object.entries(b.attrs)) {
			if (!names.test(k)) continue
			const hits = referenced(v, b.dir).filter((x) => types.test(x.type))
			if (hits.length === 1) return hits[0]
		}
		return undefined
	}
	for (const b of kept) {
		if (b.kind !== 'resource') continue
		const p =
			refAttr(b, /^(subnet_id|subnet_ids|subnetwork|subnets|vpc_zone_identifier)$/, /^(aws_subnet|google_compute_subnetwork|azurerm_subnet)$/) ??
			refAttr(b, /^(vpc_id|network|virtual_network_name)$/, /^(aws_vpc|google_compute_network|azurerm_virtual_network)$/) ??
			refAttr(b, /^resource_group_name$/, /^azurerm_resource_group$/)
		// nested blocks (vpc_config { subnet_ids = [...] }) for Lambda / EKS
		const nested = p ?? (/subnet_ids\s*=/.test(b.body) ? (() => {
			const m = /subnet_ids\s*=\s*(\[[^\]]*\]|[^\n]+)/.exec(b.body)
			const hits = m ? referenced(m[1], b.dir).filter((x) => /subnet/.test(x.type)) : []
			return hits.length === 1 ? hits[0] : undefined
		})() : undefined)
		if (nested && nested !== b) parentOf.set(b, nested)
	}
	const usedAsParent = new Set(parentOf.values())
	const nameCount = new Map<string, number>()
	for (const b of kept) if (b.kind === 'resource') nameCount.set(b.name, (nameCount.get(b.name) ?? 0) + 1)
	const modGroups = new Map<Block, string>()
	for (const b of kept) {
		const k = keyOf.get(b)!
		const owner = moduleDirOwner.get(b.dir)
		const parentBlock = parentOf.get(b)
		const parent = parentBlock ? keyOf.get(parentBlock) : owner ? keyOf.get(owner) : undefined
		if (owner) modGroups.set(owner, keyOf.get(owner)!)
		if (b.kind === 'module') {
			const src = stringValue(b.attrs.source)
			const local = !!src && /^\.\.?\//.test(src)
			nodes.push({ key: k, label: `module ${b.name}`, icon: local ? 'terraform' : iconForModuleSource(src), role: local ? 'group' : 'infra', parent, facts: src ? [`source ${src}`] : [] })
			continue
		}
		const icon = iconForTerraformType(b.type)
		const label = GENERIC_NAMES.has(b.name) || /^this_/.test(b.name) ? `${humanType(b.type)} ${b.name}` : (nameCount.get(b.name) ?? 0) > 1 ? `${b.name} ${humanType(b.type)}` : b.name
		const store = /(_db_|_rds_|dynamodb|_s3_bucket$|storage_bucket|_sql_|cosmosdb|_redis|elasticache|bigquery_dataset|bigtable|spanner|firestore|_storage_account|_efs_)/.test(b.type)
		nodes.push({ key: k, label, icon, shape: store ? 'cylinder' : undefined, role: isContainerType(b.type) && usedAsParent.has(b) ? 'group' : store ? 'store' : 'infra', parent, facts: [b.type] })
	}
	// mark containers
	const containers = new Set<string>()
	for (const n of nodes) if (n.parent) containers.add(n.parent)
	for (const n of nodes) if (containers.has(n.key)) n.isContainer = true

	// edges: references and depends_on; edges to a node's own container are implied by nesting
	const support = /(_iam_|_security_group|_kms_|_log_group|service_account|_role$)/
	for (const b of kept) {
		const from = keyOf.get(b)!
		for (const t of referenced(b.body, b.dir)) {
			if (t === b || parentOf.get(b) === t || moduleDirOwner.get(b.dir) === t) continue
			const to = keyOf.get(t)!
			if (containers.has(to)) continue
			addEdge(from, to, support.test(t.type))
		}
	}
	// glue resources connect what they reference (e.g. lambda permission: api gateway → lambda)
	for (const g of glue) {
		const ts = referenced(g.body, g.dir).filter((t) => !containers.has(keyOf.get(t)!))
		if (ts.length !== 2 || /_iam_|_policy/.test(g.type)) continue
		// the compute side (function, service, queue consumer) is the target
		const compute = /(lambda_function|cloud_run|cloudfunctions|function_app|ecs_service|_instance$)/
		const [a, b] = compute.test(ts[0].type) && !compute.test(ts[1].type) ? [ts[1], ts[0]] : [ts[0], ts[1]]
		addEdge(keyOf.get(a)!, keyOf.get(b)!, true)
	}

	r.root = { nodes, edges }
	r.confidence = 0.7
	r.notes.push(`${plural(kept.filter((b) => b.kind === 'resource').length, 'resource')}, ${plural(kept.filter((b) => b.kind === 'module').length, 'module')} in ${plural(tf.length, '.tf file')}`)
	if (glue.length) r.notes.push(`${plural(glue.length, 'plumbing resource')} (associations, attachments, rules, policies) folded into edges or hidden`)
	if (containers.size) r.notes.push(`${plural(containers.size, 'group')} from modules / networks / resource groups`)
	return r
}
