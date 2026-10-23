/**
 * Cloud resource type → icon / label / category, shared by the cloud
 * connectors and the Terraform analyzer. One row lists every spelling of the
 * same thing: CloudFormation / AWS Config (`AWS::Lambda::Function`), Terraform
 * (`aws_lambda_function`), Cloud Asset Inventory (`run.googleapis.com/Service`)
 * and Azure Resource Manager (`microsoft.web/sites`). Lookups ignore case.
 *
 * Icons are core catalog names where one exists (they render with or without
 * the official packs), otherwise official pack names (`aws-vpc-lattice`).
 */

export type CloudCategory =
	| 'compute'
	| 'container'
	| 'serverless'
	| 'data'
	| 'storage'
	| 'messaging'
	| 'network'
	| 'edge'
	| 'security'
	| 'analytics'
	| 'ml'
	| 'observability'
	| 'integration'
	| 'other'

export interface CloudKind {
	icon: string
	/** Singular label: `Lambda function`. */
	label: string
	plural: string
	category: CloudCategory
	/** Network containers become groups. */
	container?: 'vpc' | 'subnet'
	/** Used for inference only, never drawn (target groups, ENIs, policies, ...). */
	hidden?: boolean
	shape?: 'cylinder'
}

type Row = [types: string[], icon: string, label: string, category: CloudCategory, extra?: Partial<CloudKind> & { plural?: string }]

const DB: Partial<CloudKind> = { shape: 'cylinder' }
const HIDE: Partial<CloudKind> = { hidden: true }

const ROWS: Row[] = [
	// ---- AWS ----
	[['AWS::EC2::VPC', 'aws_vpc'], 'aws-vpc', 'VPC', 'network', { container: 'vpc' }],
	[['AWS::EC2::Subnet', 'aws_subnet'], 'aws-group-private-subnet', 'Subnet', 'network', { container: 'subnet' }],
	[['AWS::EC2::Instance', 'aws_instance'], 'aws-ec2', 'EC2 instance', 'compute'],
	[['AWS::AutoScaling::AutoScalingGroup', 'aws_autoscaling_group'], 'aws-ec2-auto-scaling', 'Auto Scaling group', 'compute'],
	[['AWS::Lambda::Function', 'aws_lambda_function'], 'aws-lambda', 'Lambda function', 'serverless'],
	[['AWS::Lambda::EventSourceMapping', 'aws_lambda_event_source_mapping'], 'aws-lambda', 'Event source mapping', 'serverless', HIDE],
	[['AWS::Lambda::Permission', 'aws_lambda_permission'], 'aws-lambda', 'Lambda permission', 'security', HIDE],
	[['AWS::ECS::Cluster', 'aws_ecs_cluster'], 'aws-ecs', 'ECS cluster', 'container'],
	[['AWS::ECS::Service', 'aws_ecs_service'], 'aws-fargate', 'ECS service', 'container'],
	[['AWS::ECS::TaskDefinition', 'aws_ecs_task_definition'], 'aws-ecs', 'ECS task definition', 'container', HIDE],
	[['AWS::EKS::Cluster', 'aws_eks_cluster'], 'aws-eks', 'EKS cluster', 'container'],
	[['AWS::EKS::Nodegroup', 'aws_eks_node_group'], 'aws-eks', 'EKS node group', 'container', HIDE],
	[['AWS::ECR::Repository', 'aws_ecr_repository'], 'aws-ecr', 'ECR repository', 'container'],
	[['AWS::ElasticBeanstalk::Environment', 'aws_elastic_beanstalk_environment'], 'aws-elastic-beanstalk', 'Beanstalk environment', 'compute'],
	[['AWS::AppRunner::Service', 'aws_apprunner_service'], 'aws-app-runner', 'App Runner service', 'compute'],
	[['AWS::Batch::ComputeEnvironment', 'aws_batch_compute_environment'], 'aws-batch', 'Batch environment', 'compute'],
	[['AWS::S3::Bucket', 'aws_s3_bucket'], 'aws-s3', 'S3 bucket', 'storage'],
	[['AWS::EFS::FileSystem', 'aws_efs_file_system'], 'aws-efs', 'EFS file system', 'storage'],
	[['AWS::EC2::Volume', 'aws_ebs_volume'], 'aws-ebs', 'EBS volume', 'storage', HIDE],
	[['AWS::DynamoDB::Table', 'aws_dynamodb_table'], 'aws-dynamodb', 'DynamoDB table', 'data', DB],
	[['AWS::RDS::DBInstance', 'aws_db_instance'], 'aws-rds', 'RDS instance', 'data', DB],
	[['AWS::RDS::DBCluster', 'aws_rds_cluster'], 'aws-aurora', 'Aurora cluster', 'data', DB],
	[['AWS::RDS::DBSubnetGroup', 'aws_db_subnet_group'], 'aws-rds', 'DB subnet group', 'network', HIDE],
	[['AWS::ElastiCache::CacheCluster', 'AWS::ElastiCache::ReplicationGroup', 'aws_elasticache_cluster', 'aws_elasticache_replication_group'], 'aws-elasticache', 'ElastiCache cluster', 'data', DB],
	[['AWS::MemoryDB::Cluster', 'aws_memorydb_cluster'], 'aws-memorydb', 'MemoryDB cluster', 'data', DB],
	[['AWS::Redshift::Cluster', 'aws_redshift_cluster'], 'aws-redshift', 'Redshift cluster', 'analytics', DB],
	[['AWS::DocDB::DBCluster', 'aws_docdb_cluster'], 'aws-documentdb', 'DocumentDB cluster', 'data', DB],
	[['AWS::Neptune::DBCluster', 'aws_neptune_cluster'], 'aws-neptune', 'Neptune cluster', 'data', DB],
	[['AWS::OpenSearchService::Domain', 'AWS::Elasticsearch::Domain', 'aws_opensearch_domain', 'aws_elasticsearch_domain'], 'aws-opensearch-service', 'OpenSearch domain', 'data', DB],
	[['AWS::SQS::Queue', 'aws_sqs_queue'], 'aws-sqs', 'SQS queue', 'messaging'],
	[['AWS::SNS::Topic', 'aws_sns_topic'], 'aws-sns', 'SNS topic', 'messaging'],
	[['AWS::SNS::Subscription', 'aws_sns_topic_subscription'], 'aws-sns', 'SNS subscription', 'messaging', HIDE],
	[['AWS::Events::EventBus', 'aws_cloudwatch_event_bus'], 'aws-eventbridge', 'Event bus', 'messaging'],
	[['AWS::Events::Rule', 'aws_cloudwatch_event_rule'], 'aws-eventbridge', 'EventBridge rule', 'messaging'],
	[['AWS::Scheduler::Schedule', 'aws_scheduler_schedule'], 'aws-eventbridge', 'Schedule', 'messaging'],
	[['AWS::Kinesis::Stream', 'aws_kinesis_stream'], 'aws-kinesis', 'Kinesis stream', 'messaging'],
	[['AWS::KinesisFirehose::DeliveryStream', 'aws_kinesis_firehose_delivery_stream'], 'aws-data-firehose', 'Firehose stream', 'messaging'],
	[['AWS::MSK::Cluster', 'aws_msk_cluster'], 'aws-msk', 'MSK cluster', 'messaging'],
	[['AWS::AmazonMQ::Broker', 'aws_mq_broker'], 'aws-mq', 'MQ broker', 'messaging'],
	[['AWS::StepFunctions::StateMachine', 'aws_sfn_state_machine'], 'aws-step-functions', 'State machine', 'integration'],
	[['AWS::ApiGateway::RestApi', 'aws_api_gateway_rest_api'], 'aws-api-gateway', 'REST API', 'edge'],
	[['AWS::ApiGatewayV2::Api', 'aws_apigatewayv2_api'], 'aws-api-gateway', 'HTTP API', 'edge'],
	[['AWS::ApiGateway::Stage', 'AWS::ApiGatewayV2::Stage', 'aws_api_gateway_stage', 'aws_apigatewayv2_stage'], 'aws-api-gateway', 'API stage', 'edge', HIDE],
	[['AWS::ApiGatewayV2::Integration', 'aws_apigatewayv2_integration', 'aws_api_gateway_integration'], 'aws-api-gateway', 'API integration', 'edge', HIDE],
	[['AWS::AppSync::GraphQLApi', 'aws_appsync_graphql_api'], 'aws-appsync', 'AppSync API', 'edge'],
	[['AWS::ElasticLoadBalancingV2::LoadBalancer', 'AWS::ElasticLoadBalancing::LoadBalancer', 'aws_lb', 'aws_alb', 'aws_elb'], 'aws-elb', 'Load balancer', 'network'],
	[['AWS::ElasticLoadBalancingV2::TargetGroup', 'aws_lb_target_group', 'aws_alb_target_group'], 'aws-elb', 'Target group', 'network', HIDE],
	[['AWS::ElasticLoadBalancingV2::Listener', 'aws_lb_listener'], 'aws-elb', 'Listener', 'network', HIDE],
	[['AWS::CloudFront::Distribution', 'aws_cloudfront_distribution'], 'aws-cloudfront', 'CloudFront distribution', 'edge'],
	[['AWS::Route53::HostedZone', 'aws_route53_zone'], 'aws-route-53', 'Hosted zone', 'edge'],
	[['AWS::Route53::RecordSet', 'aws_route53_record'], 'aws-route-53', 'DNS record', 'edge'],
	[['AWS::GlobalAccelerator::Accelerator', 'aws_globalaccelerator_accelerator'], 'aws-global-accelerator', 'Global Accelerator', 'edge'],
	[['AWS::WAFv2::WebACL', 'aws_wafv2_web_acl'], 'aws-waf', 'Web ACL', 'security'],
	[['AWS::EC2::SecurityGroup', 'aws_security_group'], 'aws-vpc', 'Security group', 'security', HIDE],
	[['AWS::EC2::NetworkInterface', 'aws_network_interface'], 'aws-vpc', 'Network interface', 'network', HIDE],
	[['AWS::EC2::InternetGateway', 'aws_internet_gateway'], 'aws-vpc', 'Internet gateway', 'network'],
	[['AWS::EC2::NatGateway', 'aws_nat_gateway'], 'aws-vpc', 'NAT gateway', 'network'],
	[['AWS::EC2::VPCEndpoint', 'aws_vpc_endpoint'], 'aws-privatelink', 'VPC endpoint', 'network'],
	[['AWS::EC2::TransitGateway', 'aws_ec2_transit_gateway'], 'aws-transit-gateway', 'Transit gateway', 'network'],
	[['AWS::EC2::RouteTable', 'AWS::EC2::NetworkAcl', 'AWS::EC2::EIP', 'AWS::EC2::SubnetRouteTableAssociation', 'AWS::EC2::Route', 'AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress', 'aws_route_table', 'aws_network_acl', 'aws_eip', 'aws_route_table_association', 'aws_route', 'aws_security_group_rule', 'aws_vpc_security_group_ingress_rule', 'aws_vpc_security_group_egress_rule'], 'aws-vpc', 'Network plumbing', 'network', HIDE],
	[['AWS::Cognito::UserPool', 'aws_cognito_user_pool'], 'aws-cognito', 'Cognito user pool', 'security'],
	[['AWS::SecretsManager::Secret', 'aws_secretsmanager_secret'], 'aws-secrets-manager', 'Secret', 'security'],
	[['AWS::SSM::Parameter', 'aws_ssm_parameter'], 'aws-systems-manager', 'SSM parameter', 'security', HIDE],
	[['AWS::KMS::Key', 'AWS::KMS::Alias', 'aws_kms_key', 'aws_kms_alias'], 'aws-kms', 'KMS key', 'security', HIDE],
	[['AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::User', 'AWS::IAM::Group', 'AWS::IAM::InstanceProfile', 'aws_iam_role', 'aws_iam_policy', 'aws_iam_role_policy', 'aws_iam_role_policy_attachment', 'aws_iam_user', 'aws_iam_group', 'aws_iam_instance_profile'], 'aws-iam', 'IAM entity', 'security', HIDE],
	[['AWS::CertificateManager::Certificate', 'aws_acm_certificate'], 'aws-certificate-manager', 'Certificate', 'security', HIDE],
	[['AWS::Logs::LogGroup', 'aws_cloudwatch_log_group'], 'aws-cloudwatch', 'Log group', 'observability', HIDE],
	[['AWS::CloudWatch::Alarm', 'aws_cloudwatch_metric_alarm'], 'aws-cloudwatch', 'Alarm', 'observability', HIDE],
	[['AWS::CloudTrail::Trail', 'aws_cloudtrail'], 'aws-cloudtrail', 'Trail', 'observability'],
	[['AWS::Glue::Job', 'AWS::Glue::Database', 'aws_glue_job', 'aws_glue_catalog_database'], 'aws-glue', 'Glue job', 'analytics'],
	[['AWS::Athena::WorkGroup', 'aws_athena_workgroup'], 'aws-athena', 'Athena workgroup', 'analytics'],
	[['AWS::EMR::Cluster', 'aws_emr_cluster'], 'aws-emr', 'EMR cluster', 'analytics'],
	[['AWS::SageMaker::Endpoint', 'AWS::SageMaker::NotebookInstance', 'aws_sagemaker_endpoint', 'aws_sagemaker_notebook_instance'], 'aws-sagemaker', 'SageMaker endpoint', 'ml'],
	[['AWS::SES::ConfigurationSet', 'AWS::SES::EmailIdentity', 'aws_ses_domain_identity', 'aws_sesv2_email_identity'], 'aws-ses', 'SES identity', 'messaging'],
	[['AWS::Amplify::App', 'aws_amplify_app'], 'aws-amplify', 'Amplify app', 'edge'],
	[['AWS::CloudFormation::Stack', 'aws_cloudformation_stack'], 'aws-cloudformation', 'Stack', 'other', HIDE],

	// ---- Google Cloud ----
	[['compute.googleapis.com/Network', 'google_compute_network'], 'gcp-vpc', 'VPC network', 'network', { container: 'vpc' }],
	[['compute.googleapis.com/Subnetwork', 'google_compute_subnetwork'], 'gcp-virtual-private-cloud', 'Subnet', 'network', { container: 'subnet' }],
	[['compute.googleapis.com/Instance', 'google_compute_instance'], 'gcp-compute-engine', 'VM instance', 'compute'],
	[['compute.googleapis.com/InstanceGroup', 'compute.googleapis.com/InstanceGroupManager', 'compute.googleapis.com/RegionInstanceGroupManager', 'google_compute_instance_group', 'google_compute_instance_group_manager', 'google_compute_region_instance_group_manager'], 'gcp-compute-engine', 'Instance group', 'compute'],
	[['compute.googleapis.com/InstanceTemplate', 'google_compute_instance_template'], 'gcp-compute-engine', 'Instance template', 'compute', HIDE],
	[['compute.googleapis.com/Disk', 'compute.googleapis.com/Snapshot', 'compute.googleapis.com/Image', 'google_compute_disk'], 'gcp-persistent-disk', 'Disk', 'storage', HIDE],
	[['compute.googleapis.com/ForwardingRule', 'compute.googleapis.com/GlobalForwardingRule', 'google_compute_forwarding_rule', 'google_compute_global_forwarding_rule'], 'gcp-load-balancing', 'Load balancer', 'network'],
	[['compute.googleapis.com/BackendService', 'compute.googleapis.com/RegionBackendService', 'google_compute_backend_service', 'google_compute_region_backend_service'], 'gcp-load-balancing', 'Backend service', 'network', HIDE],
	[['compute.googleapis.com/BackendBucket', 'google_compute_backend_bucket'], 'gcp-load-balancing', 'Backend bucket', 'network', HIDE],
	[['compute.googleapis.com/UrlMap', 'compute.googleapis.com/TargetHttpsProxy', 'compute.googleapis.com/TargetHttpProxy', 'compute.googleapis.com/TargetTcpProxy', 'compute.googleapis.com/TargetSslProxy', 'compute.googleapis.com/NetworkEndpointGroup', 'compute.googleapis.com/HealthCheck', 'compute.googleapis.com/SslCertificate', 'compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress', 'compute.googleapis.com/Route', 'google_compute_url_map', 'google_compute_target_https_proxy', 'google_compute_target_http_proxy', 'google_compute_region_network_endpoint_group', 'google_compute_health_check', 'google_compute_managed_ssl_certificate', 'google_compute_address', 'google_compute_global_address', 'google_compute_route'], 'gcp-load-balancing', 'LB plumbing', 'network', HIDE],
	[['compute.googleapis.com/Firewall', 'google_compute_firewall'], 'gcp-cloud-firewall-rules', 'Firewall rule', 'security', HIDE],
	[['compute.googleapis.com/Router', 'google_compute_router', 'google_compute_router_nat'], 'gcp-cloud-nat', 'Cloud Router / NAT', 'network'],
	[['compute.googleapis.com/SecurityPolicy', 'google_compute_security_policy'], 'gcp-cloud-armor', 'Cloud Armor policy', 'security'],
	[['vpcaccess.googleapis.com/Connector', 'google_vpc_access_connector'], 'gcp-virtual-private-cloud', 'VPC connector', 'network'],
	[['run.googleapis.com/Service', 'google_cloud_run_service', 'google_cloud_run_v2_service'], 'gcp-cloud-run', 'Cloud Run service', 'serverless'],
	[['run.googleapis.com/Job', 'google_cloud_run_v2_job'], 'gcp-cloud-run', 'Cloud Run job', 'serverless'],
	[['run.googleapis.com/Revision', 'run.googleapis.com/Execution'], 'gcp-cloud-run', 'Cloud Run revision', 'serverless', HIDE],
	[['cloudfunctions.googleapis.com/CloudFunction', 'cloudfunctions.googleapis.com/Function', 'google_cloudfunctions_function', 'google_cloudfunctions2_function'], 'gcp-cloud-functions', 'Cloud Function', 'serverless'],
	[['appengine.googleapis.com/Application', 'appengine.googleapis.com/Service', 'google_app_engine_application'], 'gcp-app-engine', 'App Engine app', 'compute'],
	[['appengine.googleapis.com/Version'], 'gcp-app-engine', 'App Engine version', 'compute', HIDE],
	[['container.googleapis.com/Cluster', 'google_container_cluster'], 'gcp-gke', 'GKE cluster', 'container'],
	[['container.googleapis.com/NodePool', 'google_container_node_pool'], 'gcp-gke', 'GKE node pool', 'container', HIDE],
	[['k8s.io/Namespace', 'k8s.io/Node', 'k8s.io/Pod', 'k8s.io/Service', 'apps.k8s.io/Deployment', 'apps.k8s.io/ReplicaSet', 'apps.k8s.io/StatefulSet', 'apps.k8s.io/DaemonSet', 'batch.k8s.io/Job', 'networking.k8s.io/Ingress', 'rbac.authorization.k8s.io/Role', 'rbac.authorization.k8s.io/RoleBinding', 'rbac.authorization.k8s.io/ClusterRole', 'rbac.authorization.k8s.io/ClusterRoleBinding'], 'kubernetes', 'Kubernetes object', 'container', HIDE],
	[['artifactregistry.googleapis.com/Repository', 'google_artifact_registry_repository'], 'gcp-artifact-registry', 'Artifact repository', 'container'],
	[['storage.googleapis.com/Bucket', 'google_storage_bucket'], 'gcp-cloud-storage', 'Bucket', 'storage'],
	[['sqladmin.googleapis.com/Instance', 'google_sql_database_instance'], 'gcp-cloud-sql', 'Cloud SQL instance', 'data', DB],
	[['spanner.googleapis.com/Instance', 'google_spanner_instance'], 'gcp-spanner', 'Spanner instance', 'data', DB],
	[['spanner.googleapis.com/Database', 'google_spanner_database'], 'gcp-spanner', 'Spanner database', 'data', { ...DB, hidden: true }],
	[['firestore.googleapis.com/Database', 'datastore.googleapis.com/Database', 'google_firestore_database'], 'gcp-firestore', 'Firestore database', 'data', DB],
	[['bigtableadmin.googleapis.com/Instance', 'google_bigtable_instance'], 'gcp-bigtable', 'Bigtable instance', 'data', DB],
	[['redis.googleapis.com/Instance', 'memcache.googleapis.com/Instance', 'google_redis_instance', 'google_memcache_instance'], 'gcp-memorystore', 'Memorystore instance', 'data', DB],
	[['alloydb.googleapis.com/Cluster', 'google_alloydb_cluster'], 'gcp-alloydb', 'AlloyDB cluster', 'data', DB],
	[['bigquery.googleapis.com/Dataset', 'google_bigquery_dataset'], 'gcp-bigquery', 'BigQuery dataset', 'analytics', DB],
	[['bigquery.googleapis.com/Table', 'google_bigquery_table'], 'gcp-bigquery', 'BigQuery table', 'analytics', HIDE],
	[['pubsub.googleapis.com/Topic', 'google_pubsub_topic'], 'gcp-pubsub', 'Pub/Sub topic', 'messaging'],
	[['pubsub.googleapis.com/Subscription', 'google_pubsub_subscription'], 'gcp-pubsub', 'Pub/Sub subscription', 'messaging', HIDE],
	[['eventarc.googleapis.com/Trigger', 'google_eventarc_trigger'], 'gcp-eventarc', 'Eventarc trigger', 'messaging', HIDE],
	[['cloudscheduler.googleapis.com/Job', 'google_cloud_scheduler_job'], 'gcp-cloud-scheduler', 'Scheduler job', 'integration'],
	[['cloudtasks.googleapis.com/Queue', 'google_cloud_tasks_queue'], 'gcp-cloud-tasks', 'Tasks queue', 'messaging'],
	[['workflows.googleapis.com/Workflow', 'google_workflows_workflow'], 'gcp-workflows', 'Workflow', 'integration'],
	[['apigateway.googleapis.com/Gateway', 'apigateway.googleapis.com/Api', 'google_api_gateway_gateway', 'google_api_gateway_api'], 'gcp-api-gateway', 'API Gateway', 'edge'],
	[['dns.googleapis.com/ManagedZone', 'google_dns_managed_zone'], 'gcp-cloud-dns', 'DNS zone', 'edge'],
	[['secretmanager.googleapis.com/Secret', 'google_secret_manager_secret'], 'gcp-secret-manager', 'Secret', 'security'],
	[['secretmanager.googleapis.com/SecretVersion', 'google_secret_manager_secret_version'], 'gcp-secret-manager', 'Secret version', 'security', HIDE],
	[['cloudkms.googleapis.com/KeyRing', 'cloudkms.googleapis.com/CryptoKey', 'cloudkms.googleapis.com/CryptoKeyVersion', 'google_kms_key_ring', 'google_kms_crypto_key'], 'gcp-key-management-service', 'KMS key', 'security', HIDE],
	[['iam.googleapis.com/ServiceAccount', 'iam.googleapis.com/ServiceAccountKey', 'iam.googleapis.com/Role', 'google_service_account'], 'gcp-iam', 'Service account', 'security', HIDE],
	[['cloudresourcemanager.googleapis.com/Project', 'google_project'], 'gcp-project', 'Project', 'other', HIDE],
	[['serviceusage.googleapis.com/Service', 'logging.googleapis.com/LogBucket', 'logging.googleapis.com/LogSink', 'logging.googleapis.com/LogMetric', 'monitoring.googleapis.com/AlertPolicy', 'monitoring.googleapis.com/NotificationChannel', 'google_project_service', 'google_logging_project_sink', 'google_monitoring_alert_policy'], 'gcp-cloud-logging', 'Ops config', 'observability', HIDE],
	[['dataflow.googleapis.com/Job', 'google_dataflow_job'], 'gcp-dataflow', 'Dataflow job', 'analytics'],
	[['dataproc.googleapis.com/Cluster', 'google_dataproc_cluster'], 'gcp-dataproc', 'Dataproc cluster', 'analytics'],
	[['composer.googleapis.com/Environment', 'google_composer_environment'], 'gcp-composer', 'Composer environment', 'analytics'],
	[['aiplatform.googleapis.com/Endpoint', 'google_vertex_ai_endpoint'], 'gcp-vertex-ai', 'Vertex AI endpoint', 'ml'],

	// ---- Azure ----
	[['microsoft.network/virtualnetworks', 'azurerm_virtual_network'], 'azure-virtual-network', 'Virtual network', 'network', { container: 'vpc' }],
	[['microsoft.network/virtualnetworks/subnets', 'azurerm_subnet'], 'azure-subnet', 'Subnet', 'network', { container: 'subnet' }],
	[['microsoft.compute/virtualmachines', 'azurerm_virtual_machine', 'azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine'], 'azure-virtual-machines', 'Virtual machine', 'compute'],
	[['microsoft.compute/virtualmachinescalesets', 'azurerm_virtual_machine_scale_set', 'azurerm_linux_virtual_machine_scale_set', 'azurerm_windows_virtual_machine_scale_set'], 'azure-vm-scale-sets', 'VM scale set', 'compute'],
	[['microsoft.compute/disks', 'microsoft.compute/snapshots', 'microsoft.compute/virtualmachines/extensions', 'microsoft.compute/availabilitysets', 'microsoft.compute/sshpublickeys', 'azurerm_managed_disk'], 'azure-disks', 'Disk', 'storage', HIDE],
	[['microsoft.web/sites', 'azurerm_linux_web_app', 'azurerm_windows_web_app', 'azurerm_app_service'], 'azure-app-service', 'App Service app', 'compute'],
	[['microsoft.web/sites/functionapp', 'azurerm_linux_function_app', 'azurerm_windows_function_app', 'azurerm_function_app'], 'azure-functions', 'Function app', 'serverless'],
	[['microsoft.web/sites/slots', 'microsoft.web/certificates', 'microsoft.web/connections'], 'azure-app-service', 'Deployment slot', 'compute', HIDE],
	[['microsoft.web/serverfarms', 'azurerm_service_plan', 'azurerm_app_service_plan'], 'azure-app-service-plans', 'App Service plan', 'compute'],
	[['microsoft.web/staticsites', 'azurerm_static_site', 'azurerm_static_web_app'], 'azure-static-web-apps', 'Static web app', 'edge'],
	[['microsoft.containerservice/managedclusters', 'azurerm_kubernetes_cluster'], 'azure-aks', 'AKS cluster', 'container'],
	[['microsoft.app/containerapps', 'azurerm_container_app'], 'azure-container-apps', 'Container app', 'serverless'],
	[['microsoft.app/managedenvironments', 'azurerm_container_app_environment'], 'azure-container-apps-environments', 'Container Apps environment', 'container'],
	[['microsoft.containerinstance/containergroups', 'azurerm_container_group'], 'azure-container-instances', 'Container group', 'container'],
	[['microsoft.containerregistry/registries', 'azurerm_container_registry'], 'azure-container-registry', 'Container registry', 'container'],
	[['microsoft.storage/storageaccounts', 'azurerm_storage_account'], 'azure-storage-accounts', 'Storage account', 'storage'],
	[['microsoft.sql/servers', 'azurerm_mssql_server', 'azurerm_sql_server'], 'azure-sql-server', 'SQL server', 'data', DB],
	[['microsoft.sql/servers/databases', 'azurerm_mssql_database', 'azurerm_sql_database'], 'azure-sql-database', 'SQL database', 'data', DB],
	[['microsoft.sql/servers/elasticpools'], 'azure-sql-elastic-pools', 'Elastic pool', 'data', HIDE],
	[['microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbforpostgresql/servers', 'azurerm_postgresql_flexible_server', 'azurerm_postgresql_server'], 'azure-database-postgresql-server', 'PostgreSQL server', 'data', DB],
	[['microsoft.dbformysql/flexibleservers', 'microsoft.dbformysql/servers', 'azurerm_mysql_flexible_server', 'azurerm_mysql_server'], 'azure-database-mysql-server', 'MySQL server', 'data', DB],
	[['microsoft.documentdb/databaseaccounts', 'azurerm_cosmosdb_account'], 'azure-cosmos-db', 'Cosmos DB account', 'data', DB],
	[['microsoft.cache/redis', 'microsoft.cache/redisenterprise', 'azurerm_redis_cache'], 'azure-cache-redis', 'Redis cache', 'data', DB],
	[['microsoft.servicebus/namespaces', 'azurerm_servicebus_namespace'], 'azure-service-bus', 'Service Bus namespace', 'messaging'],
	[['microsoft.eventhub/namespaces', 'azurerm_eventhub_namespace'], 'azure-event-hubs', 'Event Hubs namespace', 'messaging'],
	[['microsoft.eventgrid/topics', 'microsoft.eventgrid/systemtopics', 'microsoft.eventgrid/domains', 'azurerm_eventgrid_topic', 'azurerm_eventgrid_system_topic'], 'azure-event-grid', 'Event Grid topic', 'messaging'],
	[['microsoft.apimanagement/service', 'azurerm_api_management'], 'azure-api-management', 'API Management', 'edge'],
	[['microsoft.network/frontdoors', 'microsoft.cdn/profiles', 'azurerm_frontdoor', 'azurerm_cdn_frontdoor_profile', 'azurerm_cdn_profile'], 'azure-front-door', 'Front Door / CDN', 'edge'],
	[['microsoft.network/applicationgateways', 'azurerm_application_gateway'], 'azure-application-gateway', 'Application gateway', 'network'],
	[['microsoft.network/loadbalancers', 'azurerm_lb'], 'azure-load-balancer', 'Load balancer', 'network'],
	[['microsoft.network/privateendpoints', 'azurerm_private_endpoint'], 'azure-private-endpoints', 'Private endpoint', 'network'],
	[['microsoft.network/azurefirewalls', 'azurerm_firewall'], 'azure-firewalls', 'Firewall', 'security'],
	[['microsoft.network/natgateways', 'azurerm_nat_gateway'], 'azure-nat', 'NAT gateway', 'network'],
	[['microsoft.network/bastionhosts', 'azurerm_bastion_host'], 'azure-bastions', 'Bastion', 'security'],
	[['microsoft.network/virtualnetworkgateways', 'azurerm_virtual_network_gateway'], 'azure-virtual-network-gateways', 'VNet gateway', 'network'],
	[['microsoft.network/dnszones', 'microsoft.network/privatednszones', 'azurerm_dns_zone', 'azurerm_private_dns_zone'], 'azure-dns', 'DNS zone', 'edge'],
	[['microsoft.network/trafficmanagerprofiles', 'azurerm_traffic_manager_profile'], 'azure-traffic-manager-profiles', 'Traffic Manager', 'edge'],
	[['microsoft.network/networkinterfaces', 'microsoft.network/networksecuritygroups', 'microsoft.network/publicipaddresses', 'microsoft.network/routetables', 'microsoft.network/privatednszones/virtualnetworklinks', 'microsoft.network/networkwatchers', 'microsoft.network/applicationsecuritygroups', 'azurerm_network_interface', 'azurerm_network_security_group', 'azurerm_public_ip', 'azurerm_route_table'], 'azure-network-interfaces', 'Network plumbing', 'network', HIDE],
	[['microsoft.keyvault/vaults', 'azurerm_key_vault'], 'azure-key-vault', 'Key vault', 'security'],
	[['microsoft.managedidentity/userassignedidentities', 'azurerm_user_assigned_identity'], 'azure-managed-identities', 'Managed identity', 'security', HIDE],
	[['microsoft.insights/components', 'azurerm_application_insights'], 'azure-application-insights', 'Application Insights', 'observability'],
	[['microsoft.operationalinsights/workspaces', 'azurerm_log_analytics_workspace'], 'azure-log-analytics', 'Log Analytics workspace', 'observability'],
	[['microsoft.insights/actiongroups', 'microsoft.insights/metricalerts', 'microsoft.insights/scheduledqueryrules', 'microsoft.insights/activitylogalerts', 'microsoft.alertsmanagement/smartdetectoralertrules', 'microsoft.insights/datacollectionrules', 'microsoft.portal/dashboards'], 'azure-monitor', 'Monitoring config', 'observability', HIDE],
	[['microsoft.logic/workflows', 'azurerm_logic_app_workflow'], 'azure-logic-apps', 'Logic app', 'integration'],
	[['microsoft.datafactory/factories', 'azurerm_data_factory'], 'azure-data-factory', 'Data factory', 'analytics'],
	[['microsoft.synapse/workspaces', 'azurerm_synapse_workspace'], 'azure-synapse', 'Synapse workspace', 'analytics'],
	[['microsoft.databricks/workspaces', 'azurerm_databricks_workspace'], 'azure-databricks', 'Databricks workspace', 'analytics'],
	[['microsoft.cognitiveservices/accounts', 'azurerm_cognitive_account'], 'azure-openai', 'AI services account', 'ml'],
	[['microsoft.machinelearningservices/workspaces', 'azurerm_machine_learning_workspace'], 'azure-machine-learning', 'ML workspace', 'ml'],
	[['microsoft.search/searchservices', 'azurerm_search_service'], 'azure-cognitive-search', 'AI Search', 'data'],
	[['microsoft.signalrservice/signalr', 'azurerm_signalr_service'], 'azure-signalr', 'SignalR', 'messaging'],
]

const PLURAL_EXCEPTIONS: Record<string, string> = {
	'Auto Scaling group': 'Auto Scaling groups',
	'Web ACL': 'Web ACLs',
	'Front Door / CDN': 'Front Door / CDN profiles',
	'Cloud Router / NAT': 'Cloud Routers / NATs',
	'AI Search': 'AI Search services',
	'API Management': 'API Management services',
	'Traffic Manager': 'Traffic Manager profiles',
	'Global Accelerator': 'Global Accelerators',
	SignalR: 'SignalR services',
	'Application Insights': 'Application Insights components',
	'Network plumbing': 'network plumbing',
	'LB plumbing': 'LB plumbing',
	'Ops config': 'ops config',
	'Monitoring config': 'monitoring config',
}

function pluralize(label: string): string {
	if (PLURAL_EXCEPTIONS[label]) return PLURAL_EXCEPTIONS[label]
	if (/(s|sh|ch|x)$/.test(label)) return `${label}es`
	if (/[^aeiou]y$/.test(label)) return `${label.slice(0, -1)}ies`
	return `${label}s`
}

const TABLE = new Map<string, CloudKind>()
for (const [types, icon, label, category, extra] of ROWS) {
	const kind: CloudKind = { icon, label, plural: extra?.plural ?? pluralize(label), category, ...extra }
	for (const t of types) TABLE.set(t.toLowerCase(), kind)
}

/** Any spelling (CloudFormation, Terraform, asset type, ARM type), case-insensitive. */
export function cloudKind(type: string): CloudKind | undefined {
	return TABLE.get(type.toLowerCase())
}

/** Icon for a resource type, or undefined when unknown. Handy for the Terraform analyzer. */
export function iconForResourceType(type: string): string | undefined {
	return cloudKind(type)?.icon
}

const PROVIDER_ICON = { aws: 'aws', gcp: 'gcp', azure: 'azure' } as const

/** Fallback for unknown types: a readable label from the type and the provider icon. */
export function kindOrFallback(type: string, provider: 'aws' | 'gcp' | 'azure'): CloudKind {
	const k = cloudKind(type)
	if (k) return k
	let label = type
	if (provider === 'aws') label = type.split('::').slice(1).join(' ')
	else if (provider === 'gcp') label = type.split('/').pop() ?? type
	else label = type.split('/').slice(1).join(' ')
	label = label.replace(/([a-z])([A-Z])/g, '$1 $2') || type
	return { icon: PROVIDER_ICON[provider], label, plural: pluralize(label), category: 'other' }
}

/** Every type the table knows (lowercased), for tests and docs. */
export function knownResourceTypes(): string[] {
	return [...TABLE.keys()]
}
