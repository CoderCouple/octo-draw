# Connectors

## Cloud accounts (AWS, Google Cloud, Azure)

octo-draw can draw the live architecture of a cloud account, or of an inventory you exported yourself. Either way it builds a multi-page diagram:

- **Root page:** account / project / subscription → regions → VPCs / VNets → subnets, holding compute, data and services. Edges come from real configuration, not guesses.
- **Application pages** (`App · checkout`), grouped by the tags `app`, `application`, `service`, `app.kubernetes.io/part-of`, `app.kubernetes.io/name`, `aws:cloudformation:stack-name`, `project` and similar. In Azure the resource group is the fallback.
- **Folding:** each page holds at most about 40 nodes, groups included. Over that limit, octo-draw folds in this order:
  1. Subnets into their VPC.
  2. The largest tagged application or same-type bucket into a count node, such as "37 Lambda functions". It drills into a page that lists the resources.
  3. Whole VPCs, then whole regions.
  4. Whatever is left goes into a "N more resources" continuation page.

  Nothing disappears: every resource is on some page.

| Input | Meaning |
|---|---|
| `aws:` | Default credential chain. Region from `AWS_REGION` / `AWS_DEFAULT_REGION`, else `us-east-1` |
| `aws:prod@us-east-1,eu-west-1` | Profile `prod`, two regions (`aws:us-east-1` = regions only, `aws:prod` = profile only) |
| `gcp:my-project` | Also `gcp:folders/123`, `gcp:organizations/456` |
| `azure:<subscription-id>[,<id>…]` | `azure:` = every enabled subscription the credentials can see |
| `aws:export.json`, `gcp:a.json,b.json`, `azure:graph.json` | Offline import. Several files are merged |
| `export.json` (bare path) | Offline import. The provider is detected from the content |

```sh
octo-draw scan aws:prod@us-east-1 -o prod.octo --render prod.svg
octo-draw scan gcp:acme-shop-prod -o gcp.octo
octo-draw scan ./exports/resource-graph.json -o azure.octo
```

### What gets connected

- **AWS**
  - Security-group rules: source SG members → target SG members, labelled with the port.
  - Lambda event source mappings, plus Lambda and ECS task environment references to queues, topics, tables, buckets, secrets, RDS / ElastiCache endpoints and SQS URLs.
  - API Gateway (REST and HTTP) integrations → Lambda or VPC-link load balancers.
  - ALB / NLB → target groups → instances, IPs, Lambdas and ECS services.
  - ECS services → clusters.
  - RDS / Aurora placed in their subnets. Aurora members fold into the cluster.
  - CloudFront → S3 and custom origins.
  - SNS → SQS / Lambda subscriptions.
  - EventBridge buses → rules → targets.
  - Route 53 alias / CNAME records → ALB / CloudFront.
- **Google Cloud**
  - Forwarding rule → proxy → URL map → backend service / bucket → serverless NEG / instance group, collapsed into `LB → service`.
  - Managed instance groups → their VMs.
  - Cloud Run VPC connectors, Cloud SQL attachments, secrets and env refs.
  - Cloud Functions (1st and 2nd gen) Pub/Sub, Storage and Firestore triggers. A 2nd-gen function's backing Cloud Run service is drawn as the function.
  - Pub/Sub push, BigQuery and Storage subscriptions.
  - Eventarc triggers.
  - Cloud Scheduler targets.
  - GKE, Cloud SQL, Memorystore and AlloyDB placed in their networks.
  - Cloud Asset Inventory relationships, when available.
- **Azure**
  - NIC → subnet / VM.
  - VNet subnets.
  - App Service / Function App → plan, and VNet integration subnet.
  - Private endpoints → target resource.
  - AKS node subnets.
  - Application Gateway and Load Balancer backends.
  - Classic Front Door backends.
  - Container Apps → environment.
  - Event Grid system topic sources.
  - Function triggers are not visible in Resource Graph, so they are not drawn.

### Setup (live scans)

The scan runs on the machine running the CLI or the server, with that machine's credentials. Credentials never reach the browser and are never logged or returned.

**AWS:** the AWS SDK v3 standard chain. This covers `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, `~/.aws/config` and `~/.aws/credentials` profiles, IAM Identity Center (`aws sso login --profile prod`), `credential_process`, and container or instance roles. To scan another account, pass `roleArn` (and optionally `externalId`). octo-draw assumes that role for 15 minutes with session name `octo-draw-scan`.

For breadth, octo-draw first tries Resource Explorer (`Search` on the default view), which includes untagged resources when an index exists. It then reads the Tagging API in every region, plus the describe calls below for relations. Resources only referenced by ARN (event sources, subscription endpoints, integrations) are added too.

Minimal IAM policy. The AWS managed `ReadOnlyAccess` also works:

```json
{
	"Version": "2012-10-17",
	"Statement": [{
		"Sid": "OctoDrawReadOnlyScan",
		"Effect": "Allow",
		"Action": [
			"sts:GetCallerIdentity",
			"resource-explorer-2:Search", "resource-explorer-2:GetDefaultView",
			"tag:GetResources",
			"ec2:DescribeVpcs", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeInstances",
			"ec2:DescribeNatGateways", "ec2:DescribeInternetGateways", "ec2:DescribeVpcEndpoints",
			"lambda:ListFunctions", "lambda:ListEventSourceMappings",
			"elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth",
			"ecs:ListClusters", "ecs:DescribeClusters", "ecs:ListServices", "ecs:DescribeServices", "ecs:DescribeTaskDefinition",
			"rds:DescribeDBInstances", "rds:DescribeDBClusters",
			"elasticache:DescribeCacheClusters",
			"apigateway:GET",
			"cloudfront:ListDistributions",
			"sns:ListSubscriptions",
			"events:ListRules", "events:ListTargetsByRule",
			"route53:ListHostedZones", "route53:ListResourceRecordSets"
		],
		"Resource": "*"
	}]
}
```

`lambda:ListFunctions` and `ecs:DescribeTaskDefinition` return environment variables. octo-draw reads them only to find references (see Privacy). If even that is too much, leave those two actions out: the diagram loses the env-reference edges but nothing else. To assume a role, the caller also needs `sts:AssumeRole` on it.

**Google Cloud:** Application Default Credentials (`gcloud auth application-default login`, `GOOGLE_APPLICATION_CREDENTIALS`, or the metadata server), with the read-only scope `cloud-platform.read-only`. Grant **Cloud Asset Viewer** (`roles/cloudasset.viewer`) on the project, folder or organization, and enable the Cloud Asset API (`gcloud services enable cloudasset.googleapis.com`). octo-draw calls `searchAllResources` and `assets.list` (`contentType=RESOURCE` for the relation-bearing types, and `RELATIONSHIP` best effort, which needs Security Command Center Premium / Enterprise). All calls are GET.

**Azure:** `DefaultAzureCredential` covers `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET`, workload or managed identity, `az login`, `azd auth login` and PowerShell. Grant the built-in **Reader** role on the subscriptions. octo-draw lists subscriptions, when none are given, and queries Azure Resource Graph (`Resources | where <kql> | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties, sku`). Resource Graph is read-only.

Every collector only makes read calls. The AWS client refuses any operation outside the allowlist above. The GCP and Azure clients refuse URLs other than the Cloud Asset API, Resource Graph and the subscriptions list.

### Offline import (no credentials given to octo-draw)

Run these yourself and pass the JSON file. The format is detected automatically.

**AWS**, any of:

```sh
# breadth (one file per region; merge several with jq -s .)
aws resourcegroupstaggingapi get-resources --region us-east-1 > aws-tags.json

# AWS Config: a snapshot delivered to S3, or an advanced query
aws configservice deliver-config-snapshot --delivery-channel-name default   # then download the .json.gz from the bucket and gunzip it
aws configservice select-resource-config --expression "SELECT resourceId, resourceType, resourceName, arn, awsRegion, accountId, tags, configuration, relationships" > aws-config.json

# describe bundle (best relations): one JSON array of responses, region given once
R=us-east-1
{
  aws sts get-caller-identity
  aws ec2 describe-vpcs --region $R; aws ec2 describe-subnets --region $R
  aws ec2 describe-security-groups --region $R; aws ec2 describe-instances --region $R
  aws ec2 describe-nat-gateways --region $R; aws ec2 describe-internet-gateways --region $R
  aws lambda list-functions --region $R; aws lambda list-event-source-mappings --region $R
  aws elbv2 describe-load-balancers --region $R; aws elbv2 describe-target-groups --region $R
  aws rds describe-db-instances --region $R; aws rds describe-db-clusters --region $R
  aws elasticache describe-cache-clusters --show-cache-node-info --region $R
  aws ecs describe-clusters --clusters $(aws ecs list-clusters --region $R --query 'clusterArns[]' --output text) --region $R
  aws sns list-subscriptions --region $R; aws events list-rules --region $R
  aws apigatewayv2 get-apis --region $R
  aws cloudfront list-distributions; aws route53 list-hosted-zones
  aws resourcegroupstaggingapi get-resources --region $R
} | jq -s "{region: \"$R\", responses: .}" > aws-bundle.json
```

A few per-parent calls don't name their parent in the response. Add it with `jq` before bundling:

| Call | Add the field |
|---|---|
| `elbv2 describe-target-health` | `TargetGroupArn` |
| `events list-targets-by-rule` | `Rule` or `RuleArn` |
| `apigatewayv2 get-integrations` | `ApiId` |
| `apigateway get-resources --embed methods` | `RestApiId` |
| `route53 list-resource-record-sets` | `HostedZoneId` |

For example:

```sh
aws elbv2 describe-target-health --target-group-arn $TG | jq --arg tg $TG '. + {TargetGroupArn: $tg}'
```

ECS services and task definitions come from `aws ecs describe-services --cluster C --services …` and `aws ecs describe-task-definition --task-definition …`.

**Google Cloud:**

```sh
gcloud asset search-all-resources --scope=projects/my-project --format=json > gcp-search.json
# optional, for relations (full configuration):
gcloud asset list --project=my-project --content-type=resource --format=json \
  --asset-types='compute.googleapis.com/.*,run.googleapis.com/.*,cloudfunctions.googleapis.com/.*,pubsub.googleapis.com/Subscription,eventarc.googleapis.com/Trigger,cloudscheduler.googleapis.com/Job,container.googleapis.com/Cluster,sqladmin.googleapis.com/Instance,redis.googleapis.com/Instance,vpcaccess.googleapis.com/Connector' > gcp-assets.json
octo-draw scan gcp:gcp-search.json,gcp-assets.json
```

`gcloud asset export --output-path=gs://…` (newline-delimited JSON) works too.

**Azure:**

```sh
az graph query --first 1000 -o json -q "Resources | project id, name, type, kind, location, resourceGroup, subscriptionId, tags, properties, sku" > azure-graph.json
# more than 1000 rows: repeat with --skip-token <skip_token from the previous output> and merge with jq -s
```

### Server (`POST /api/scan`)

The body is `{ source: "aws:prod@us-east-1" }`. Provider options go in an `options` object, which the scan route passes through to `ref.options`:

| Option | Meaning |
|---|---|
| `regions` | AWS regions (array or comma-separated) |
| `profile` | AWS profile |
| `roleArn` | AWS role to assume |
| `externalId` | External id for `roleArn` |
| `scope` | GCP project / folder / organization |
| `subscriptions` | Azure subscription ids |
| `kql` | Azure KQL filter |
| `export` | Uploaded export JSON (text or object), instead of a file |
| `maxNodesPerPage` | Node budget per page |
| `maxPages` | Pages read per paginated API call |
| `title` | Diagram title |
| `allowFiles: false` | Refuse file-path sources. Servers should set it so a request can't read server files |

Example body:

```json
{ "source": "azure:", "options": { "export": "<contents of azure-graph.json>" } }
```

### Privacy

- **Credentials:** they stay in the cloud SDKs, are never logged or returned, and errors carry only the SDK error name and message.
- **Environment variables:** octo-draw never emits their values. It reads them only to recognise references to other resources (ARNs, hostnames, queue URLs, resource names). The diagram shows the reference as a dotted edge named after the variable (`env TABLE_NAME`).
  - Variables whose names match `secret|token|password|key|credential|private` are skipped entirely, unless the value is an ARN.
  - URL credentials are stripped before anything is kept in memory.
- **Tag and label values** whose keys match the same pattern are replaced with `[redacted]`.
- **Not kept:**
  - SNS email / HTTP subscription endpoints.
  - EventBridge target inputs.
  - Instance metadata and startup scripts.
  - Application Insights keys.
  - Key Vault contents.
- **Results** contain only the octo code, counts and warnings. The `source` echo includes the regions, profile, role, scope or subscriptions and the file's base name, never the uploaded export.
- **Bundle size:** the SDKs (AWS SDK v3 clients, `google-auth-library`, `@azure/identity`) load only when a live scan runs, through a runtime-only import that bundlers skip.

## Hugging Face (models, datasets, Spaces, collections)

The `huggingface` connector (`packages/scan/src/connectors/huggingface/`) diagrams what is on the Hub. It uses the public Hub API through `ctx.fetch` and needs no new dependencies.

**Inputs:**

| Input | Diagram |
|---|---|
| `hf:org/name`, `huggingface.co/org/name`, `hf.co/org/name` | Model |
| `huggingface.co/datasets/org/name`, `hf:datasets/org/name` | Dataset |
| `huggingface.co/spaces/org/name`, `hf:spaces/org/name` | Space |
| `huggingface.co/collections/owner/slug` | Collection |

A revision can be given as `@rev`, `/tree/<rev>` or `/blob/<rev>/...`.

### Token and errors

- **Token:** set `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) to read gated or private repos.
  - The token is read server-side from `ctx.env`.
  - It is sent only to `huggingface.co` hosts.
  - It never appears in results.
- **Public repos** work without a token.
- **Gated repos:** the metadata is public but `config.json` isn't. Without access, the model still gets its root page, and the Architecture node becomes a "config.json is gated" note with a warning.
- **401 without a token** means "not found, private or gated". The Hub answers 401 for names that don't exist too.
- **403** means "accept the terms on huggingface.co".
- **429** reports the wait time from the `ratelimit` header.

### Model root page

- **Lineage:** the model and its `base_model` chain.
  - Relations come from the Hub's `base_model:<finetune|adapter|quantized|merge>:` tags, which follow repo renames. The card is the fallback.
  - The chain is walked up 3 levels.
- **Card facts:** training datasets, license, `pipeline_tag` and library.
- **Weights:** formats, dtypes and size.
- **Spaces** that use the model.
- **Parameter count:** from the safetensors (or GGUF) metadata, otherwise estimated from the config. The estimates are within about 1 to 3% for Llama, Qwen, Mixtral, T5, Whisper and llava.
- **GGUF and adapter-only repos:** GGUF repos get a note listing their quantizations. PEFT adapter repos get a note with r, α and target modules, plus an edge to the adapter's base model.

### Model level 1

The "Architecture" page comes from `config.json`.

- **Layer stack:** embeddings → `Decoder × N layers` group → final norm → LM head.
  - The group's attention node shows MHA/GQA/MQA/MLA, the head and KV-head counts, head dim, RoPE θ and scaling, and the sliding window.
  - The group's MLP node shows SwiGLU/GELU and the sizes, or MoE with its experts, top-k and shared experts.
- **VLMs** (`vision_config` + `text_config`): image → patch embedding → vision tower group → projector → merge with the text tokens.
- **Encoder-decoders** (T5, BART, Whisper): the encoder group feeds the decoder's cross-attention. Whisper also gets the log-mel and conv stem.
- **Encoder-only models** (BERT family): the encoder stack and its head.
- **Diffusers repos** (`model_index.json`) get a "Pipeline" page instead: prompt → tokenizers → text encoders → unet/transformer ← scheduler, then latents → vae → image. Component labels are read from each component's `config.json`.

### Datasets, Spaces and collections

- **Dataset:**
  - Root: the dataset, with size, row count, modality, tasks, license and languages.
  - A node and a page per config, showing its splits (rows and bytes) and features. These come from the datasets-server `/info`, falling back to the card's `dataset_info`.
  - Up to 6 of the most downloaded models trained on the dataset.
- **Space:**
  - Root: a request flow, User → UI (SDK, version, inputs) → handlers (wired events, `@spaces.GPU` marked ZeroGPU) → model calls → Outputs. The Space group shows the SDK and hardware.
  - Model calls come from transformers `pipeline`/`from_pretrained`, diffusers pipelines, `SentenceTransformer`, `InferenceClient`, `gr.load`, and the OpenAI, Anthropic, Gemini, Groq and other SDKs. An OpenAI client with an HF router `base_url` counts as HF Inference Providers.
  - The flow also shows vector DBs (Chroma, FAISS, Pinecone, Qdrant, …), frameworks, raw HTTP APIs, and the card's `models`/`datasets`.
  - The "App code" page shows the files read: the app file, other small `.py` files, `requirements.txt` and the `Dockerfile`.
- **Collection:** one node per item type, each drilling into a page that lists the items with links.

### Drill-down v2

- **Refs:** the root page carries `source hf:<id>`, and every node carries `src: hf:<id>#<path>`.
- **Expander:** `registerExpander('huggingface', …)` expands any node on demand:

| Path | Expands into |
|---|---|
| `architecture` | The network |
| `decoder`, `encoder`, `vision` | One block: norms, attention, MLP/MoE, residual adds, plus the cross-attention for decoders of encoder-decoders |
| `<stack>.attn`, `<stack>.cross` | Q/K/V projections (or MLA latent), RoPE, SDPA, KV cache and O proj |
| `<stack>.mlp` | Gate/up/act/down, or the router, experts and combine |
| `<stack>.expert` | One expert |
| `pipeline`, `<component>/` | The diffusers pipeline, or a component: UNet down/mid/up blocks, transformer blocks, or a nested transformers config such as `text_encoder_2/` |
| `config/<name>` | A dataset config |
| `app`, `app/<handler>`, `file/<path>` | Space code |
| A bare `hf:<id>` (a base model, a dataset in the card, a Space's model) | That repo's own diagram |

- **Depth:** scans pre-generate the root plus one level. `options.depth = N` pre-generates more levels with the same functions, using page names like `Architecture / Decoder / MoE`.
