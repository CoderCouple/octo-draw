/**
 * Realistic ASCII / Unicode diagrams as chat LLMs (ChatGPT, Claude, Gemini)
 * print them. Used by the ASCII parser and import-detection tests.
 */

export const asciiFixtures = {
	/** Claude-style vertical request flow with a label beside the line. */
	stackedUnicode: String.raw`
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ HTTPS
       ▼
┌─────────────┐
│ API Gateway │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Database   │
└─────────────┘
`,

	/** ChatGPT-style horizontal ASCII boxes. */
	horizontalAscii: String.raw`
+--------+      +---------+      +----------+
| Client | ---> |  Server | ---> | Database |
+--------+      +---------+      +----------+
`,

	/** Load balancer fanning out to three servers through a bus line. */
	fanOut: String.raw`
            ┌───────────────┐
            │ Load Balancer │
            └───────┬───────┘
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      ┌───────┐ ┌───────┐ ┌───────┐
      │ Web 1 │ │ Web 2 │ │ Web 3 │
      └───────┘ └───────┘ └───────┘
`,

	/** Group with the title in its top border. */
	containerTitleBorder: String.raw`
┌──────────────── AWS VPC ────────────────┐
│                                         │
│   ┌──────────┐         ┌──────────┐     │
│   │   API    │────────▶│  Worker  │     │
│   └──────────┘         └──────────┘     │
│                                         │
└─────────────────────────────────────────┘
        ▲
        │
   ┌─────────┐
   │  Users  │
   └─────────┘
`,

	/** ASCII group with the title on the first interior row. */
	containerTitleInside: String.raw`
+-----------------------------------+
|  Backend                          |
|                                   |
|  +---------+       +-----------+  |
|  |  Auth   | ----> |  Users DB |  |
|  +---------+       +-----------+  |
+-----------------------------------+
`,

	/** Single-line bracket chain. */
	bracketChain: String.raw`[User] --> [Frontend] --> [Backend] --> [(Postgres)]`,

	/** Several inline chains sharing node names. */
	inlineChains: String.raw`
Browser -> CDN -> Origin
Origin -> Cache
Cache -> Origin
`,

	/** Project layout. */
	directoryTree: String.raw`
my-app/
├── src/
│   ├── index.ts
│   ├── components/
│   │   └── Button.tsx      # shared button
│   └── utils.ts
├── package.json
└── README.md
`,

	/** Request / response loop with labels on both lines. */
	requestResponse: String.raw`
┌────────┐   request   ┌────────┐
│ Client │────────────▶│ Server │
└────────┘             └────────┘
     ▲                      │
     │       response       │
     └──────────────────────┘
`,

	/** Label written inside the line. */
	inlineLabel: String.raw`
┌───────┐               ┌────────┐
│ Order │──── paid ────▶│  Ship  │
└───────┘               └────────┘
`,

	/** Flowchart with a decision and a label to the left of the line. */
	decision: String.raw`
      ┌─────────┐
      │  Start  │
      └────┬────┘
           │
           ▼
     ┌───────────┐
     │  Valid?   │
     └─────┬─────┘
       yes │
           ▼
      ┌─────────┐
      │  Save   │
      └─────────┘
`,

	/** No boxes: names joined by vertical ASCII arrows. */
	verticalTextChain: String.raw`
User
 |
 v
Load Balancer
 |
 v
App Server
`,

	/** Right border drifts by one column (common LLM miscount). */
	misaligned: String.raw`
┌───────────┐
│ Service   │
│ Layer      │
└───────────┘
      │
      ▼
┌──────────┐
│  Store   │
└──────────┘
`,

	/** Emoji counted as one column by the model. */
	emoji: String.raw`
┌───────────┐     ┌──────────┐
│ 🚀 Deploy │────▶│ ✅ Done  │
└───────────┘     └──────────┘
`,

	/** Bidirectional and dashed ASCII edges. */
	dashedBidirectional: String.raw`
+-------+            +------+
| Cache | <--------> |  DB  |
+-------+            +------+
    |
    v
+-------+            +------+
| Jobs  | - - - - -> | Logs |
+-------+            +------+
`,

	/** Queue fanning out via ASCII '+' corners. */
	asciiCorners: String.raw`
+---------+
|  Queue  |
+---------+
     |
     +--------------+
     |              |
     v              v
+---------+    +---------+
| Worker1 |    | Worker2 |
+---------+    +---------+
`,

	/** Multi-line labels and a rounded box, as Claude often draws. */
	multiLineRounded: String.raw`
╭──────────────────╮        ╭──────────────╮
│  Auth Service    │        │   Redis      │
│  (JWT issuing)   │───────▶│   sessions   │
╰──────────────────╯        ╰──────────────╯
`,

	/** Box with a section divider (UML-ish). */
	sectioned: String.raw`
┌──────────────┐       ┌──────────┐
│ UserService  │──────▶│  Mailer  │
├──────────────┤       └──────────┘
│ + create()   │
│ + delete()   │
└──────────────┘
`,

	/** Prose, not a diagram. */
	prose: String.raw`
The system has three parts. First, the client sends a request - usually over HTTPS.
Then the server validates it and writes to the database. Finally, a timeline of
events is stored for auditing.
`,
}

export const mermaidFixtures = {
	fenced: '```mermaid\nflowchart LR\n  A[Client] -->|HTTPS| B(API)\n  B --> C[(DB)]\n```',
	graph: 'graph TD;\n  A-->B;\n  A-->C;\n  B-->D;\n  C-->D;',
	sequence: 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
	withInit: '%%{init: {"theme": "forest"}}%%\nflowchart TB\n  start --> stop',
}

export const octoFixtures = {
	basic: 'direction right\nUsers [icon: users]\nUsers > API: HTTPS\nAPI > DB',
	grouped: 'title Shop\nBackend {\n  API\n  Worker\n}\nAPI > Worker > DB',
	simple: 'A > B\nB > C',
}
