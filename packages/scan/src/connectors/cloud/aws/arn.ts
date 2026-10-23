/**
 * ARN → CloudFormation type + canonical id + name. EC2 resources use their
 * short id (`vpc-0abc`) as the canonical id because describe calls and AWS
 * Config refer to them that way; everything else keeps the ARN (minus Lambda
 * versions / aliases).
 */

export interface ParsedArn {
	partition: string
	service: string
	region: string
	account: string
	resource: string
}

export function parseArn(arn: string): ParsedArn | null {
	if (!arn.startsWith('arn:')) return null
	const parts = arn.split(':')
	if (parts.length < 6) return null
	const [, partition, service, region, account, ...rest] = parts
	return { partition, service, region, account, resource: rest.join(':') }
}

export interface ArnInfo {
	/** Canonical id. */
	id: string
	type: string
	name: string
	region?: string
	account?: string
	/** Global service (CloudFront, Route 53): never placed in a region. */
	global?: boolean
}

const EC2_TYPES: Record<string, string> = {
	instance: 'AWS::EC2::Instance',
	vpc: 'AWS::EC2::VPC',
	subnet: 'AWS::EC2::Subnet',
	'security-group': 'AWS::EC2::SecurityGroup',
	natgateway: 'AWS::EC2::NatGateway',
	'internet-gateway': 'AWS::EC2::InternetGateway',
	'vpc-endpoint': 'AWS::EC2::VPCEndpoint',
	'transit-gateway': 'AWS::EC2::TransitGateway',
	volume: 'AWS::EC2::Volume',
	'network-interface': 'AWS::EC2::NetworkInterface',
	'route-table': 'AWS::EC2::RouteTable',
	'network-acl': 'AWS::EC2::NetworkAcl',
	'elastic-ip': 'AWS::EC2::EIP',
}

/** Resource kinds that are pure noise on an architecture diagram; skipped entirely. */
const NOISE_SERVICES = new Set(['iam', 'kms', 'acm', 'logs', 'cloudwatch', 'ssm', 'backup', 'config', 'cloudformation', 'tag', 'resource-groups', 'access-analyzer', 'guardduty', 'securityhub', 'inspector2', 'servicecatalog', 'sso', 'organizations', 'budgets', 'ce', 'xray', 'synthetics', 'codestar-connections', 'ram', 'resource-explorer-2'])

const pascal = (s: string) => s.replace(/(^|[-_])([a-z])/g, (_m, _p, c: string) => c.toUpperCase())

/** Returns null for noise or unparseable ARNs. */
export function arnInfo(arn: string): ArnInfo | null {
	const a = parseArn(arn)
	if (!a) return null
	const { service, resource } = a
	if (NOISE_SERVICES.has(service)) return null
	const region = a.region || undefined
	const account = a.account || undefined
	const slash = resource.split('/')
	const colon = resource.split(':')
	const base = { region, account }
	switch (service) {
		case 'ec2': {
			const t = EC2_TYPES[slash[0]]
			if (!t || !slash[1]) return null
			return { ...base, id: slash[1], type: t, name: slash[1] }
		}
		case 'lambda':
			if (colon[0] === 'function' && colon[1]) return { ...base, id: `arn:${a.partition}:lambda:${a.region}:${a.account}:function:${colon[1]}`, type: 'AWS::Lambda::Function', name: colon[1] }
			if (colon[0] === 'event-source-mapping') return { ...base, id: arn, type: 'AWS::Lambda::EventSourceMapping', name: colon[1] ?? arn }
			return null
		case 'sqs':
			return { ...base, id: arn, type: 'AWS::SQS::Queue', name: resource }
		case 'sns':
			if (colon.length > 1) return { ...base, id: arn, type: 'AWS::SNS::Subscription', name: colon[0] }
			return { ...base, id: arn, type: 'AWS::SNS::Topic', name: resource }
		case 's3':
			if (slash.length > 1 || !resource) return null
			return { ...base, id: `arn:${a.partition}:s3:::${resource}`, type: 'AWS::S3::Bucket', name: resource }
		case 'dynamodb':
			if (slash[0] === 'table' && slash[1] && slash.length === 2) return { ...base, id: arn, type: 'AWS::DynamoDB::Table', name: slash[1] }
			return null
		case 'rds': {
			const map: Record<string, string> = { db: 'AWS::RDS::DBInstance', cluster: 'AWS::RDS::DBCluster', subgrp: 'AWS::RDS::DBSubnetGroup' }
			const t = map[colon[0]]
			return t && colon[1] ? { ...base, id: arn, type: colon[0] === 'cluster' && /docdb/.test(arn) ? 'AWS::DocDB::DBCluster' : t, name: colon[1] } : null
		}
		case 'elasticloadbalancing':
			if (slash[0] === 'loadbalancer') return { ...base, id: arn, type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', name: slash.length >= 4 ? slash[2] : slash[1] }
			if (slash[0] === 'targetgroup') return { ...base, id: arn, type: 'AWS::ElasticLoadBalancingV2::TargetGroup', name: slash[1] }
			if (slash[0] === 'listener') return { ...base, id: arn, type: 'AWS::ElasticLoadBalancingV2::Listener', name: slash[3] ?? arn }
			return null
		case 'ecs':
			if (slash[0] === 'cluster') return { ...base, id: arn, type: 'AWS::ECS::Cluster', name: slash[1] }
			if (slash[0] === 'service') return { ...base, id: arn, type: 'AWS::ECS::Service', name: slash[slash.length - 1] }
			if (slash[0] === 'task-definition') return { ...base, id: arn, type: 'AWS::ECS::TaskDefinition', name: slash[1] }
			return null
		case 'eks':
			if (slash[0] === 'cluster') return { ...base, id: arn, type: 'AWS::EKS::Cluster', name: slash[1] }
			if (slash[0] === 'nodegroup') return { ...base, id: arn, type: 'AWS::EKS::Nodegroup', name: slash[2] ?? arn }
			return null
		case 'ecr':
			return slash[0] === 'repository' ? { ...base, id: arn, type: 'AWS::ECR::Repository', name: slash.slice(1).join('/') } : null
		case 'apigateway': {
			// arn:aws:apigateway:us-east-1::/restapis/abc123[/stages/prod]
			const p = resource.replace(/^\//, '').split('/')
			if (p[0] === 'restapis' && p[1]) return p.length === 2 ? { ...base, id: `apigw:${p[1]}`, type: 'AWS::ApiGateway::RestApi', name: p[1] } : null
			if (p[0] === 'apis' && p[1]) return p.length === 2 ? { ...base, id: `apigw:${p[1]}`, type: 'AWS::ApiGatewayV2::Api', name: p[1] } : null
			return null
		}
		case 'cloudfront':
			return slash[0] === 'distribution' ? { ...base, global: true, id: arn, type: 'AWS::CloudFront::Distribution', name: slash[1] } : null
		case 'route53':
			return slash[0] === 'hostedzone' ? { ...base, global: true, id: `route53:${slash[1]}`, type: 'AWS::Route53::HostedZone', name: slash[1] } : null
		case 'events':
			if (slash[0] === 'rule') return { ...base, id: arn, type: 'AWS::Events::Rule', name: slash[slash.length - 1] }
			if (slash[0] === 'event-bus') return slash[1] === 'default' ? null : { ...base, id: arn, type: 'AWS::Events::EventBus', name: slash[1] }
			return null
		case 'scheduler':
			return slash[0] === 'schedule' ? { ...base, id: arn, type: 'AWS::Scheduler::Schedule', name: slash[slash.length - 1] } : null
		case 'states':
			return colon[0] === 'stateMachine' ? { ...base, id: arn, type: 'AWS::StepFunctions::StateMachine', name: colon[1] } : null
		case 'kinesis':
			return slash[0] === 'stream' ? { ...base, id: arn, type: 'AWS::Kinesis::Stream', name: slash[1] } : null
		case 'firehose':
			return slash[0] === 'deliverystream' ? { ...base, id: arn, type: 'AWS::KinesisFirehose::DeliveryStream', name: slash[1] } : null
		case 'elasticache':
			if (colon[0] === 'cluster' || colon[0] === 'replicationgroup') return { ...base, id: arn, type: colon[0] === 'cluster' ? 'AWS::ElastiCache::CacheCluster' : 'AWS::ElastiCache::ReplicationGroup', name: colon[1] }
			return null
		case 'memorydb':
			return slash[0] === 'cluster' ? { ...base, id: arn, type: 'AWS::MemoryDB::Cluster', name: slash[1] } : null
		case 'secretsmanager':
			return colon[0] === 'secret' ? { ...base, id: arn, type: 'AWS::SecretsManager::Secret', name: colon[1].replace(/-[A-Za-z0-9]{6}$/, '') } : null
		case 'cognito-idp':
			return slash[0] === 'userpool' ? { ...base, id: arn, type: 'AWS::Cognito::UserPool', name: slash[1] } : null
		case 'es':
			return slash[0] === 'domain' ? { ...base, id: arn, type: 'AWS::OpenSearchService::Domain', name: slash[1] } : null
		case 'kafka':
			return slash[0] === 'cluster' ? { ...base, id: arn, type: 'AWS::MSK::Cluster', name: slash[1] } : null
		case 'mq':
			return colon[0] === 'broker' ? { ...base, id: arn, type: 'AWS::AmazonMQ::Broker', name: colon[1] } : null
		case 'apprunner':
			return slash[0] === 'service' ? { ...base, id: arn, type: 'AWS::AppRunner::Service', name: slash[1] } : null
		case 'autoscaling': {
			const m = /autoScalingGroupName\/(.+)$/.exec(resource)
			return m ? { ...base, id: arn, type: 'AWS::AutoScaling::AutoScalingGroup', name: m[1] } : null
		}
		case 'appsync':
			return slash[0] === 'apis' && slash.length === 2 ? { ...base, id: arn, type: 'AWS::AppSync::GraphQLApi', name: slash[1] } : null
		case 'redshift':
			return colon[0] === 'cluster' ? { ...base, id: arn, type: 'AWS::Redshift::Cluster', name: colon[1] } : null
		case 'glue':
			return slash[0] === 'job' ? { ...base, id: arn, type: 'AWS::Glue::Job', name: slash[1] } : null
		case 'sagemaker':
			return slash[0] === 'endpoint' ? { ...base, id: arn, type: 'AWS::SageMaker::Endpoint', name: slash[1] } : null
		case 'wafv2':
			return slash[1] === 'webacl' ? { ...base, id: arn, type: 'AWS::WAFv2::WebACL', name: slash[2] } : null
		case 'elasticbeanstalk':
			return colon[0].startsWith('environment') ? { ...base, id: arn, type: 'AWS::ElasticBeanstalk::Environment', name: slash[slash.length - 1] } : null
		case 'batch':
			return slash[0] === 'compute-environment' ? { ...base, id: arn, type: 'AWS::Batch::ComputeEnvironment', name: slash[1] } : null
		case 'amplify':
			return slash[0] === 'apps' && slash.length === 2 ? { ...base, id: arn, type: 'AWS::Amplify::App', name: slash[1] } : null
		case 'globalaccelerator':
			return slash[0] === 'accelerator' && slash.length === 2 ? { ...base, global: true, id: arn, type: 'AWS::GlobalAccelerator::Accelerator', name: slash[1] } : null
		case 'athena':
			return slash[0] === 'workgroup' ? { ...base, id: arn, type: 'AWS::Athena::WorkGroup', name: slash[1] } : null
		case 'elasticfilesystem':
			return slash[0] === 'file-system' ? { ...base, id: arn, type: 'AWS::EFS::FileSystem', name: slash[1] } : null
		default:
			// unknown service: keep it so nothing silently disappears, but only top-level resources
			if (slash.length <= 2 && colon.length <= 2) return { ...base, id: arn, type: `AWS::${pascal(service)}::${pascal(slash.length === 2 ? slash[0] : colon.length === 2 ? colon[0] : 'Resource')}`, name: slash[1] ?? colon[1] ?? resource }
			return null
	}
}

/** `https://sqs.us-east-1.amazonaws.com/123456789012/orders` → queue ARN. */
export function queueUrlToArn(url: string): string | null {
	const m = /^https:\/\/sqs[.-]([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/(\d{12})\/([^/?#\s]+)$/.exec(url) ?? /^https:\/\/([a-z0-9-]+)\.queue\.amazonaws\.com\/(\d{12})\/([^/?#\s]+)$/.exec(url)
	return m ? `arn:aws:sqs:${m[1]}:${m[2]}:${m[3]}` : null
}

/** Listener ARN → its load balancer ARN. */
export function listenerToLb(arn: string): string | null {
	const m = /^(arn:[^:]+:elasticloadbalancing:[^:]*:[^:]*:)listener\/(app|net|gwy)\/([^/]+)\/([^/]+)\//.exec(arn)
	return m ? `${m[1]}loadbalancer/${m[2]}/${m[3]}/${m[4]}` : null
}
