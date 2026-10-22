/**
 * Golden corpus for the ASCII importer: diagrams in the style chat models
 * (ChatGPT, Claude, Gemini) print, each with the nodes / edges a person reads
 * in it. Scored by `ascii/score.ts` (precision / recall table in the tests).
 *
 * Edge notation: `A > B` directed, `A <> B` both heads, `A - B` no heads,
 * optional `: label`. Sequence messages use the same notation. ERD edges
 * point from the referencing entity to the referenced one.
 */
import type { DiagramKind } from '../ir'
import { asciiFixtures as F } from './ascii'

export interface GoldenFixture {
	text: string
	kind?: DiagramKind
	nodes: string[]
	edges: string[]
	/** child label → container label */
	parents?: Record<string, string>
	/** Node label → expected shape. */
	shapes?: Record<string, string>
}

/** New fixtures (copied in the style of real chat outputs). */
export const goldenNew: Record<string, GoldenFixture> = {
	/** Claude: AWS architecture with nested groups and a line leaving a subnet. */
	archNested: {
		text: String.raw`
                ┌──────────┐
                │  Users   │
                └────┬─────┘
                     │ HTTPS
┌──────────────────── AWS Cloud ─────────────────────────────┐
│                    │                                       │
│  ┌──────── Public Subnet ───────────────┐                  │
│  │                 ▼                    │                  │
│  │   ┌──────────────────┐               │                  │
│  │   │       ALB        │               │                  │
│  │   └────────┬─────────┘               │                  │
│  │            ▼                         │                  │
│  │   ┌──────────────────┐               │   ┌──────────┐   │
│  │   │    Web (ECS)     │───────────────────▶│ RDS (PG) │   │
│  │   └──────────────────┘               │   └──────────┘   │
│  └──────────────────────────────────────┘                  │
└────────────────────────────────────────────────────────────┘
`,
		nodes: ['Users', 'AWS Cloud', 'Public Subnet', 'ALB', 'Web (ECS)', 'RDS (PG)'],
		edges: ['Users > ALB: HTTPS', 'ALB > Web (ECS)', 'Web (ECS) > RDS (PG)'],
		parents: { 'Public Subnet': 'AWS Cloud', ALB: 'Public Subnet', 'Web (ECS)': 'Public Subnet', 'RDS (PG)': 'AWS Cloud' },
	},

	/** ChatGPT: flowchart with a yes/no split over a bus line. */
	flowYesNo: {
		text: String.raw`
            ┌─────────────┐
            │   Request   │
            └──────┬──────┘
                   │
                   ▼
            ┌─────────────┐
            │ Logged in?  │
            └──────┬──────┘
        yes        │        no
        ┌──────────┴──────────┐
        ▼                     ▼
 ┌─────────────┐       ┌─────────────┐
 │  Dashboard  │       │ Login page  │
 └─────────────┘       └─────────────┘
`,
		nodes: ['Request', 'Logged in?', 'Dashboard', 'Login page'],
		edges: ['Request > Logged in?', 'Logged in? > Dashboard: yes', 'Logged in? > Login page: no'],
	},

	/** ASCII decision diamond with labelled branches. */
	asciiDiamond: {
		text: String.raw`
        +---------+
        |  Start  |
        +---------+
             |
             v
            / \
           /   \
          / OK? \------ No ------> +-------+
          \     /                  | Retry |
           \   /                   +-------+
            \ /
             |
             | Yes
             v
        +---------+
        |  Save   |
        +---------+
`,
		nodes: ['Start', 'OK?', 'Retry', 'Save'],
		edges: ['Start > OK?', 'OK? > Retry: No', 'OK? > Save: Yes'],
		shapes: { 'OK?': 'diamond' },
	},

	/** Diamond with `< >` side vertices and a `+` apex. */
	diamondAngle: {
		text: String.raw`
     [Order placed]
           |
           v
           +
          / \
         /   \
        < Paid? >---yes---> [Ship]
         \   /
          \ /
           +
           |
           no
           |
           v
       [Send invoice]
`,
		nodes: ['Order placed', 'Paid?', 'Ship', 'Send invoice'],
		edges: ['Order placed > Paid?', 'Paid? > Ship: yes', 'Paid? > Send invoice: no'],
		shapes: { 'Paid?': 'diamond' },
	},

	/** ChatGPT: plain ASCII sequence diagram, dashed return. */
	seqPlain: {
		kind: 'sequence',
		text: String.raw`
Client            API              DB
  |                |                |
  |--- POST /x --->|                |
  |                |---- query ---->|
  |                |<- - - rows - - |
  |<-- 200 OK -----|                |
  |                |                |
`,
		nodes: ['Client', 'API', 'DB'],
		edges: ['Client > API: POST /x', 'API > DB: query', 'DB > API: rows', 'API > Client: 200 OK'],
	},

	/** Claude: sequence diagram with boxed participants and labels above arrows. */
	seqBoxes: {
		kind: 'sequence',
		text: String.raw`
┌────────┐          ┌─────────┐          ┌──────────┐
│ Browser│          │  Auth   │          │  Users   │
└───┬────┘          └────┬────┘          └────┬─────┘
    │   POST /login      │                    │
    │───────────────────▶│                    │
    │                    │   find(email)      │
    │                    │───────────────────▶│
    │                    │   user row         │
    │                    │◀ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
    │   Set-Cookie       │                    │
    │◀───────────────────│                    │
    │                    │                    │
`,
		nodes: ['Browser', 'Auth', 'Users'],
		edges: ['Browser > Auth: POST /login', 'Auth > Users: find(email)', 'Users > Auth: user row', 'Auth > Browser: Set-Cookie'],
	},

	/** Gemini: sequence with a message that crosses a lifeline. */
	seqCrossing: {
		kind: 'sequence',
		text: String.raw`
User          Frontend          Backend
 |                |                 |
 |  click login   |                 |
 |--------------->|                 |
 |                |  POST /auth     |
 |                |---------------->|
 |                |   JWT token     |
 |                |<................|
 |   audit event  |                 |
 |----------------+---------------->|
 |   redirect     |                 |
 |<---------------|                 |
`,
		nodes: ['User', 'Frontend', 'Backend'],
		edges: [
			'User > Frontend: click login',
			'Frontend > Backend: POST /auth',
			'Backend > Frontend: JWT token',
			'User > Backend: audit event',
			'Frontend > User: redirect',
		],
	},

	/** Org chart: undirected tree through a ┼ bus. */
	orgChart: {
		text: String.raw`
                ┌───────┐
                │  CEO  │
                └───┬───┘
       ┌────────────┼────────────┐
       │            │            │
   ┌───┴───┐    ┌───┴───┐    ┌───┴───┐
   │  CTO  │    │  CFO  │    │  COO  │
   └───────┘    └───────┘    └───────┘
`,
		nodes: ['CEO', 'CTO', 'CFO', 'COO'],
		edges: ['CEO - CTO', 'CEO - CFO', 'CEO - COO'],
	},

	/** `tree` command output. */
	treeCommand: {
		text: String.raw`
.
├── docker-compose.yml
├── api
│   ├── Dockerfile
│   └── main.py
└── web
    ├── package.json
    └── src
        └── App.tsx
`,
		nodes: ['.', 'docker-compose.yml', 'api', 'Dockerfile', 'main.py', 'web', 'package.json', 'src', 'App.tsx'],
		edges: ['. - docker-compose.yml', '. - api', 'api - Dockerfile', 'api - main.py', '. - web', 'web - package.json', 'web - src', 'src - App.tsx'],
	},

	/** Two unicode lines crossing at ┼ (not a junction). */
	crossingUnicode: {
		text: String.raw`
           ┌────────┐
           │  Auth  │
           └───┬────┘
┌───────┐      │       ┌───────┐
│  Web  │──────┼──────▶│ Cache │
└───────┘      │       └───────┘
               ▼
           ┌────────┐
           │   DB   │
           └────────┘
`,
		nodes: ['Auth', 'Web', 'Cache', 'DB'],
		edges: ['Auth > DB', 'Web > Cache'],
	},

	/** ASCII lines crossing at +. */
	crossingAscii: {
		text: String.raw`
          +-------+
          | Queue |
          +-------+
              |
+------+      |      +-------+
| Cron |------+----->| Mailer|
+------+      |      +-------+
              v
          +--------+
          | Worker |
          +--------+
`,
		nodes: ['Queue', 'Cron', 'Mailer', 'Worker'],
		edges: ['Queue > Worker', 'Cron > Mailer'],
	},

	/** Undirected chain. */
	undirectedChain: {
		text: 'Frontend --- API Gateway --- Database',
		nodes: ['Frontend', 'API Gateway', 'Database'],
		edges: ['Frontend - API Gateway', 'API Gateway - Database'],
	},

	/** Numbered steps on one line. */
	numberedInline: {
		text: '1. Clone repo → 2. Install deps → 3. Run tests → 4. Deploy',
		nodes: ['Clone repo', 'Install deps', 'Run tests', 'Deploy'],
		edges: ['Clone repo > Install deps', 'Install deps > Run tests', 'Run tests > Deploy'],
	},

	/** Numbered steps stacked with down arrows. */
	numberedVertical: {
		text: String.raw`
1. User uploads file
        ↓
2. Virus scan
        ↓
3. Store in S3
        ↓
4. Notify user
`,
		nodes: ['User uploads file', 'Virus scan', 'Store in S3', 'Notify user'],
		edges: ['User uploads file > Virus scan', 'Virus scan > Store in S3', 'Store in S3 > Notify user'],
	},

	/** Markdown schema tables → ERD. */
	markdownErd: {
		kind: 'erd',
		text: `Here's a schema for a simple blog:

### users
| Column | Type | Constraints |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| email | VARCHAR(255) | UNIQUE, NOT NULL |
| created_at | TIMESTAMP | |

### posts
| Column | Type | Constraints |
|--------|------|-------------|
| id | SERIAL | PRIMARY KEY |
| user_id | INTEGER | FOREIGN KEY → users.id |
| title | TEXT | NOT NULL |

### comments
| Column | Type | Constraints |
|---|---|---|
| id | SERIAL | PRIMARY KEY |
| post_id | INTEGER | REFERENCES posts(id) |
| author_id | INTEGER | FK to users |
`,
		nodes: ['users', 'posts', 'comments'],
		edges: ['posts > users', 'comments > posts', 'comments > users'],
	},

	/** CJK labels padded by display width. */
	cjkDisplay: {
		text: String.raw`
┌──────────┐      ┌──────────┐
│ 用户服务 │─────▶│ 订单服务 │
└──────────┘      └──────────┘
`,
		nodes: ['用户服务', '订单服务'],
		edges: ['用户服务 > 订单服务'],
	},

	/** CJK labels where the model counted each character as one column. */
	cjkMiscount: {
		text: String.raw`
┌──────────┐      ┌──────────┐
│ 用户服务     │─────▶│ 支付网关     │
└──────────┘      └──────────┘
          │
          ▼
┌──────────┐
│ 数据库      │
└──────────┘
`,
		nodes: ['用户服务', '支付网关', '数据库'],
		edges: ['用户服务 > 支付网关', '用户服务 > 数据库'],
	},

	/** A long label pushes one border out by four columns. */
	driftWide: {
		text: String.raw`
┌──────────────┐        ┌──────────┐
│ Ingest       │        │  Kafka   │
│ Pipeline (v2)    │───▶│  Topic   │
└──────────────┘        └──────────┘
`,
		nodes: ['Ingest Pipeline (v2)', 'Kafka Topic'],
		edges: ['Ingest Pipeline (v2) > Kafka Topic'],
	},

	/** ChatGPT: microservices with labels above the arrows. */
	microservices: {
		text: String.raw`
+-----------+     REST      +-----------+    gRPC     +-----------+
|  Gateway  | ------------> |  Orders   | ----------> | Inventory |
+-----------+               +-----------+             +-----------+
                                  |
                                  | publishes
                                  v
                            +-----------+
                            |   Kafka   |
                            +-----------+
`,
		nodes: ['Gateway', 'Orders', 'Inventory', 'Kafka'],
		edges: ['Gateway > Orders: REST', 'Orders > Inventory: gRPC', 'Orders > Kafka: publishes'],
	},

	/** Gemini: bracket nodes with an inline label and a branch down. */
	bracketMixed: {
		text: String.raw`
[Mobile App] ──HTTPS──▶ [API Gateway] ──▶ [Auth Service]
                              │
                              ▼
                      [User DB (Postgres)]
`,
		nodes: ['Mobile App', 'API Gateway', 'Auth Service', 'User DB (Postgres)'],
		edges: ['Mobile App > API Gateway: HTTPS', 'API Gateway > Auth Service', 'API Gateway > User DB (Postgres)'],
	},

	/** Kubernetes cluster with a namespace group; one arrow leaves the namespace. */
	k8sNested: {
		text: String.raw`
+--------------------- Kubernetes Cluster ---------------------+
|                                                              |
|  +----------- namespace: prod ------------+                  |
|  |                                        |                  |
|  |  +---------+          +-----------+    |  +-----------+   |
|  |  | Ingress | -------> |  api-pod  | ------>|   redis   |   |
|  |  +---------+          +-----------+    |  +-----------+   |
|  |                                        |                  |
|  +----------------------------------------+                  |
|                                                              |
+--------------------------------------------------------------+
`,
		nodes: ['Kubernetes Cluster', 'namespace: prod', 'Ingress', 'api-pod', 'redis'],
		edges: ['Ingress > api-pod', 'api-pod > redis'],
		parents: { 'namespace: prod': 'Kubernetes Cluster', Ingress: 'namespace: prod', 'api-pod': 'namespace: prod', redis: 'Kubernetes Cluster' },
	},

	/** State machine with a loop back. */
	stateLoop: {
		text: String.raw`
 ┌────────┐  submit   ┌──────────┐  approve  ┌──────────┐
 │ Draft  │──────────▶│  Review  │──────────▶│ Approved │
 └────────┘           └────┬─────┘           └──────────┘
      ▲                    │
      │      reject        │
      └────────────────────┘
`,
		nodes: ['Draft', 'Review', 'Approved'],
		edges: ['Draft > Review: submit', 'Review > Approved: approve', 'Review > Draft: reject'],
	},

	/** Claude: double-line boxes, a free-text actor and a three-way fan-out. */
	messyMixed: {
		text: String.raw`
 Users (browser)
       │
       ▼
╔══════════════╗      ╔═════════════════╗
║   Next.js    ║ ───▶ ║  API (FastAPI)  ║
╚══════════════╝      ╚════════╤════════╝
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌────────────┐   ┌────────────┐   ┌────────────┐
       │  Postgres  │   │   Redis    │   │  S3 bucket │
       └────────────┘   └────────────┘   └────────────┘
`,
		nodes: ['Users (browser)', 'Next.js', 'API (FastAPI)', 'Postgres', 'Redis', 'S3 bucket'],
		edges: ['Users (browser) > Next.js', 'Next.js > API (FastAPI)', 'API (FastAPI) > Postgres', 'API (FastAPI) > Redis', 'API (FastAPI) > S3 bucket'],
	},

	/** Dashed and dotted arrows between bracket nodes. */
	pipelineDashed: {
		text: String.raw`
[Producer] - - -> [Queue] .....> [Consumer]
                     |
                     v
              [Dead letters]
`,
		nodes: ['Producer', 'Queue', 'Consumer', 'Dead letters'],
		edges: ['Producer > Queue', 'Queue > Consumer', 'Queue > Dead letters'],
	},
}

/** Golden expectations for the original fixtures in `ascii.ts`. */
export const goldenOriginal: Record<string, GoldenFixture> = {
	stackedUnicode: {
		text: F.stackedUnicode,
		nodes: ['Client', 'API Gateway', 'Database'],
		edges: ['Client > API Gateway: HTTPS', 'API Gateway > Database'],
	},
	horizontalAscii: { text: F.horizontalAscii, nodes: ['Client', 'Server', 'Database'], edges: ['Client > Server', 'Server > Database'] },
	fanOut: {
		text: F.fanOut,
		nodes: ['Load Balancer', 'Web 1', 'Web 2', 'Web 3'],
		edges: ['Load Balancer > Web 1', 'Load Balancer > Web 2', 'Load Balancer > Web 3'],
	},
	containerTitleBorder: {
		text: F.containerTitleBorder,
		nodes: ['AWS VPC', 'API', 'Worker', 'Users'],
		edges: ['API > Worker', 'Users > AWS VPC'],
		parents: { API: 'AWS VPC', Worker: 'AWS VPC' },
	},
	containerTitleInside: {
		text: F.containerTitleInside,
		nodes: ['Backend', 'Auth', 'Users DB'],
		edges: ['Auth > Users DB'],
		parents: { Auth: 'Backend', 'Users DB': 'Backend' },
	},
	bracketChain: {
		text: F.bracketChain,
		nodes: ['User', 'Frontend', 'Backend', 'Postgres'],
		edges: ['User > Frontend', 'Frontend > Backend', 'Backend > Postgres'],
		shapes: { Postgres: 'cylinder' },
	},
	inlineChains: {
		text: F.inlineChains,
		nodes: ['Browser', 'CDN', 'Origin', 'Cache'],
		edges: ['Browser > CDN', 'CDN > Origin', 'Origin > Cache', 'Cache > Origin'],
	},
	directoryTree: {
		text: F.directoryTree,
		nodes: ['my-app/', 'src/', 'index.ts', 'components/', 'Button.tsx', 'utils.ts', 'package.json', 'README.md'],
		edges: ['my-app/ - src/', 'src/ - index.ts', 'src/ - components/', 'components/ - Button.tsx', 'src/ - utils.ts', 'my-app/ - package.json', 'my-app/ - README.md'],
	},
	requestResponse: { text: F.requestResponse, nodes: ['Client', 'Server'], edges: ['Client > Server: request', 'Server > Client: response'] },
	inlineLabel: { text: F.inlineLabel, nodes: ['Order', 'Ship'], edges: ['Order > Ship: paid'] },
	decision: { text: F.decision, nodes: ['Start', 'Valid?', 'Save'], edges: ['Start > Valid?', 'Valid? > Save: yes'] },
	verticalTextChain: {
		text: F.verticalTextChain,
		nodes: ['User', 'Load Balancer', 'App Server'],
		edges: ['User > Load Balancer', 'Load Balancer > App Server'],
	},
	misaligned: { text: F.misaligned, nodes: ['Service Layer', 'Store'], edges: ['Service Layer > Store'] },
	emoji: { text: F.emoji, nodes: ['🚀 Deploy', '✅ Done'], edges: ['🚀 Deploy > ✅ Done'] },
	dashedBidirectional: { text: F.dashedBidirectional, nodes: ['Cache', 'DB', 'Jobs', 'Logs'], edges: ['Cache <> DB', 'Cache > Jobs', 'Jobs > Logs'] },
	asciiCorners: { text: F.asciiCorners, nodes: ['Queue', 'Worker1', 'Worker2'], edges: ['Queue > Worker1', 'Queue > Worker2'] },
	multiLineRounded: { text: F.multiLineRounded, nodes: ['Auth Service (JWT issuing)', 'Redis sessions'], edges: ['Auth Service (JWT issuing) > Redis sessions'] },
	sectioned: { text: F.sectioned, nodes: ['UserService', 'Mailer'], edges: ['UserService > Mailer'] },
}

export const goldenAll: Record<string, GoldenFixture> = { ...goldenOriginal, ...goldenNew }
