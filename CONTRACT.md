# octo-draw build contract (v0)

octo-draw is an Eraser.io-style editor: **diagram code on the left, a live canvas on the right, an AI bar on top**. It has four goals: human drawing, agent drawing, diagram-as-code, and importing diagrams that AI models produce as text or images.

Shared types live in `packages/core/src/ir.ts` (DiagramIR, layout types) and `packages/core/src/agent.ts` (AgentAction). **Do not change these without updating every user.** If you must add a field, make it optional.

Everything is TypeScript, ESM and strict. The style is tabs, single quotes, no semicolons and small modules, with tests next to the code as `*.test.ts` (vitest). Run the tests from that package's directory with `pnpm vitest run`. Don't run `pnpm install` without a reason; the deps are already installed. If you really need a new dep, add it with an exact version and run `pnpm install` from the repo root.

## Licensing rule

tldraw's `editor`, `tldraw`, `mermaid` and `sync` packages are proprietary. **Never copy code from them.** Reference: `/private/tmp/claude-501/-Users-suniltiwari-Desktop-octo-draw/82dff52f-3fb0-423a-b92f-42a71b5a56f1/scratchpad/tldraw` and reports in `../scratchpad/reports/`. Write all code fresh.

## packages/core public API (`src/index.ts`)

| Function | Signature | File |
|---|---|---|
| `parseOcto` | `(src: string) => ParseResult` — never throws; errors go to `diagnostics` with offsets | `src/dsl/parse.ts` |
| `printOcto` | `(ir: DiagramIR) => string` — canonical formatter; `parseOcto(printOcto(ir))` round-trips | `src/dsl/print.ts` |
| `setNodeProp` | `(src: string, key: string, prop: string, value: string \| null, page?: string) => string` — minimal text edit on the node's declaration (adds a declaration line if the node is only implicit); `null` removes the prop. `page` (default root `''`) limits the edit to that page's section; an unknown page returns `src` unchanged | `src/dsl/patch.ts` |
| `setEdgeProp` | `(src: string, edgeKey: string, prop: string, value: string \| null, page?: string) => string` — same, for one connection | `src/dsl/patch.ts` |
| `renameNodeLabel` | `(src: string, key: string, label: string, page?: string) => string` — sets `label:` (identity unchanged) | `src/dsl/patch.ts` |
| `parseMermaid` | `(src: string) => ParseResult` — flowchart/graph subset, hand-written, no mermaid dep | `src/mermaid/parse.ts` |
| `toMermaid` | `(ir: DiagramIR) => string` | `src/mermaid/print.ts` |
| `parseAscii` | `(text: string) => ParseResult & { confidence: number; cells?: Record<string, CellRect> }` — ASCII/Unicode diagrams from chat LLMs: boxes, groups, diamonds, trees, arrow chains, numbered steps, ASCII sequence diagrams (→ kind `sequence`) and markdown schema tables (→ kind `erd`). `cells` is each node's grid rectangle | `src/ascii/parse.ts` |
| `detectFormat` | `(text: string) => TextFormat` where `TextFormat = 'octo' \| 'mermaid' \| 'ascii' \| 'plain'` | `src/import/detect.ts` |
| `importText` | `(text: string) => { format: TextFormat; ir: DiagramIR; diagnostics: Diagnostic[]; confidence?: number; pins?: Record<string, Point> } \| null` — strips markdown ``` fences first. Optional fields (ASCII imports only): `confidence` 0..1; `pins` = top-left canvas positions per node key scaled from the text grid (overlaps pushed apart, containers never pinned, absent for sequence/ERD) — pass as `layoutDiagram(ir, { pinned: pins })` to keep the drawn arrangement | `src/import/detect.ts` |
| `pinsFromRects` | `(ir, rects: Record<string, SourceRect>, { scaleX, scaleY, gap?, snap? }) => Record<string, Point>` — source rectangles (grid cells, image bboxes) → non-overlapping pins; `pinsFromCells(ir, cells)` is the ASCII preset | `src/import/pins.ts` |
| `layoutDiagram` | `(ir: DiagramIR, opts?: LayoutOptions) => Promise<DiagramLayout>` — ELK layered, compound groups, orthogonal edges; pinned nodes stay put and their edges are re-routed | `src/layout/layout.ts` |
| `applyActions` | `(src: string, actions: AgentAction[], opts?: { page?: string }) => ApplyResult` — edits octo DSL source. Every action edits only `opts.page`'s section (default: the root page, so a multi-page source keeps its other pages); an unknown page is a per-action error. `replaceCode` without `opts.page` still replaces the whole source; with it, only that page's body | `src/agent/apply.ts` |

## octo DSL (Eraser-compatible)

```
// comments with // or #
title My system
direction right            // down | up | right | left
colorMode pastel           // pastel | bold | outline
styleMode shadow           // shadow | plain | watercolor
typeface clean             // rough | clean | mono

Users [icon: users, shape: oval]
Backend [color: blue] {
  API gateway [icon: server]
  Worker [icon: cpu]
  "Pub/Sub" [icon: radio]
}
DB [shape: cylinder, icon: database, label: "Postgres 16"]

Users > API gateway: HTTPS
API gateway > Worker, "Pub/Sub"      // branching
Worker > DB > Backups                // chaining, implicit node "Backups"
Worker <> Cache: [color: red]
Worker -- Logs
API gateway --> Audit: async [id: audit-edge]
```

- **Operators:** `>`, `<`, `<>`, `-`, `--`, `-->`. They **must have whitespace around them**, so names like `main-vpc` stay intact.
  - `-` is a solid line with no arrowheads.
  - `--` is a dotted line.
  - `-->` is a dotted arrow.
- **Names:** may contain spaces. Quote them when they contain `[ ] { } , : "` or an operator token.
- **Node properties:** `shape`, `icon`, `color`, `label`, `link`. Unknown properties go to `ext`. Props without a value (e.g. `pin`) mean `"true"`.
- **Edge properties:** `id`, `color`, `dash`.
- **Edge keys:** use `id` if given. Otherwise the key is `${from}->${to}#${n}`, where n counts edges between the same pair starting at 0.
- **Groups:** `Name [props] { ... }` nests. A group child can be a declaration, a connection, or a reference to an existing name (comma- or line-separated). Containers get `isContainer: true`, and children get `parent`.

### Pages and drill-down

- `page <Name>` alone on a line at column 0 (name may be quoted; a trailing `//` or `#` comment is fine) starts a page that runs to the next `page` line. Before the first one is the root page `''`. A node named `page`, `page > x`, `page x [..]`, or an indented `page x` is not a header. The printer quotes node names starting with `page ` so they never turn into headers.
- Each page body is parsed like a standalone source: its own directives, its own `sequence` / `erd` header (the first meaningful line of the page), its own node namespace. `title` is only read from the root; a `title` on another page is a warning.
- Node prop `drill: <Page>` (kept in `ext.drill`) names the page a node opens; without it, a page named like the node's key (case-insensitive) is the target. A bare `[drill]` means "the page named like me". See "Drill-down (v1)" below for the API.

## Agent / AI server (`apps/server`)

A Node HTTP server on port **8787**. Vite proxies `/api` to it. It uses `@anthropic-ai/sdk`, model `claude-opus-5-5`, credentials from the environment (`ANTHROPIC_API_KEY` or an `ant auth login` profile). The key must never be sent to the browser.

- `POST /api/generate` `{ prompt, code? }`: streams text/plain chunks of octo DSL (`text/event-stream`, `data: {"delta": "..."}` lines, then `data: {"done": true, "code": "..."}`). With `code`, it edits the existing diagram.
- `POST /api/vision` `{ imageBase64, mediaType, mode? }`: takes an image of a diagram (ChatGPT/Gemini/whiteboard) and returns `{ code, pins?, confidence?, warnings?, diagnostics?, pipeline }`.
  - `mode: 'auto'` (default) runs the two-pass pipeline (`src/vision.ts`): pass 1 asks for nodes as strict JSON (structured outputs: id, label, shape, bbox normalised 0–1000, parent group), pass 2 sends the image again with the node list and asks for edges (endpoint ids, direction, label, endpoint points), an optional pass 3 repairs edges with the conversion diagnostics. Endpoints are snapped to node ids (exact → case/label match → nearest bbox to the endpoint point). The result is IR → `printOcto`; `pins` are top-left canvas positions from the bboxes (keeps the image's arrangement), `confidence` is 0..1, `warnings` lists dropped/snapped items. `pipeline` is `'two-pass'` or `'single-pass'`.
  - Sequence diagrams, ERDs, non-diagrams and any two-pass failure fall back to the original single-pass DSL transcription (`mode: 'single'` forces it); that path returns `{ code, diagnostics?, pipeline: 'single-pass' }`.
- `POST /api/agent` `{ prompt, code }`: returns `{ actions: AgentAction[], code, errors }` using tool use (an `apply_actions` tool whose schema is AgentAction[]).
- `POST /api/scan` `{ path } | { source }`, optional `only: string[]`, `title`: source scanning (see "Source scanning" below). Returns `{ code, findings: { analyzer, confidence, notes }[], warnings, source: { kind, id, ref? } }`. Local dev only: loopback clients, no foreign `Origin`. Local paths are refused (403) unless their realpath is under `OCTO_SCAN_ROOTS` (path-delimiter separated; default the home directory). `source` takes any connector input (`github.com/o/r[/tree/ref/dir]`, `o/r@ref`, ...). The GitHub token (`GITHUB_TOKEN` / `GH_TOKEN` / `gh auth token`) is read server-side only and never returned. Connector errors keep their status (404 not found, 429 rate limited, ...).
- `POST /api/scan/explain` (same body): runs the scan, then sends the code, findings and key files (README, manifests, entrypoints; truncated) to Claude (structured output) and returns the scan response plus `{ code, scanCode, summary, labels: { page, key, label }[], notes }`. `code` has the refined labels applied per page and `// summary:` / `// note:` comments after the title; `scanCode` is the unrefined scan. 503 without credentials.
- An MCP stdio server (`src/mcp.ts`) with the tools `get_diagram`, `set_diagram`, `apply_actions`, `import_text`, `export_mermaid`, `describe_diagram`, `get_diagram_svg` and `scan_source { source? | path?, only?, apply?, docId? }` (proxies `POST /api/scan`; `apply: true` also sets the result as the current diagram). It talks to the running server's document via `GET/PUT /api/doc`. The web app syncs its current code to `/api/doc` when it changes and polls (or uses SSE `GET /api/doc/events`) so that external agents' edits show up live.

## Web app (`apps/web`)

Vite + React 19 + zustand + CodeMirror 6.

- **Layout:**
  - Top bar: logo, editable title, AI prompt input with Generate/Edit, Import (image/ASCII/mermaid), Export (octo, mermaid, SVG, PNG, JSON).
  - Resizable split: code editor on the left, canvas on the right.
- **Code editor:** octo DSL syntax highlighting (a StreamLanguage is fine), diagnostics from `parseOcto`, and autocomplete for property keys, shapes, colors, icons and directives.
- **Canvas:** SVG renderer with infinite pan/zoom.
  - **Diagram layer** (from code): nodes per shape with icon and label, groups as rounded containers with a title, and edges as polylines with arrowheads and labels.
    - Drag a node to pin its position. Positions are stored per key in the store, not in the code.
    - Double-click a node to edit its label, which calls `renameNodeLabel` on the code.
    - Selecting a node highlights its declaration line in the editor.
  - **Freehand layer** (human drawing, not in code):
    - Tools: select (V), hand (H), pen (P, perfect-freehand), rectangle (R), ellipse (O), arrow (A), text (T), eraser (E).
    - Undo/redo (Cmd+Z / Shift+Cmd+Z) covers both code changes and drawing.
- **Paste:** text runs through `importText` (mermaid, ASCII box art and octo get converted to octo code via `printOcto`). Images go to `/api/vision`. When either returns `pins`, merge them into the document's pins (replacing pins for the imported keys) so the canvas keeps the source arrangement; `confidence` < 0.6 or `warnings` should surface as a dismissible review toast.
- **Persistence:** localStorage.
- **Agent hooks:**
  - `window.octo = { getCode, setCode, applyActions, getIR, getLayout }`.
  - When the AI or an agent is editing, show an "AI is drawing…" presence badge with a cursor on the canvas.

## Drill-down (v1)

Interactive drill-down lives entirely in the one code text, so sync, agents, undo and MCP need no changes.

**Pages.** A line that is exactly `page <Name>` at column 0 (name may be quoted) starts a sub-diagram that runs until the next `page` line. Everything before the first `page` line is the root page (name `''`). Directives (`direction`, `colorMode`, …) are per page; `title` is only read from the root.

```
title Checkout
API [icon: server]
Payments [icon: credit-card, drill: Payments flow]   // explicit target
Orders                                              // implicit: a page named "Orders" exists
API > Payments, Orders

page Payments flow
direction right
Validate > Charge > Receipt

page Orders
Create > Reserve stock > Ship
```

- **Drill targets:** a node drills into page P if it has `drill: P`, or if a page has the same name as the node's key (case-insensitive). `drill` is a regular node prop (it currently lands in `ext`; keep it there).
- **Unknown pages:** `drill:` naming a missing page is a warning diagnostic.

**Core API (`packages/core/src/drill/`, exported from index):**

| Function | Signature |
|---|---|
| `splitPages` | `(src: string) => OctoPage[]` where `OctoPage = { name: string; from: number; to: number; bodyFrom: number; line: number }`. `from` is the `page` line start (0 for root), `bodyFrom` is just after the header line, `to` is exclusive. The root page is always first, even if empty. |
| `parsePage` | `(src: string, name: string) => ParseResult \| null` parses one page's body. Spans and diagnostics are offsets into the **full** source, so `setNodeProp`/`renameNodeLabel`/CodeMirror highlighting keep working. |
| `parseOctoPages` | `(src: string) => { pages: (OctoPage & ParseResult)[]; diagnostics: Diagnostic[] }` parses all pages and adds the cross-page warnings. |
| `drillTargets` | `(ir: DiagramIR, pageNames: string[]) => Record<string, string>` maps node key to target page name. |
| `pageAt` | `(src: string, offset: number) => string` gives the page containing the offset (the editor uses it to follow the caret). |
| `addPage` | `(src: string, name: string, body?: string) => string` appends a page. |
| `collapseGroups` | `(ir: DiagramIR, collapsed: Iterable<string>) => DiagramIR`. Each collapsed container becomes a leaf node with `isContainer: false`, its own label/icon/color, and `ext.collapsed = '<descendant count>'`. Descendants are removed. Edges are rewired to the nearest visible ancestor; self-loops are dropped; parallel edges between the same pair and direction merge into one, with `ext`-less label `"<n> links"` when they had more than one distinct label. Nested collapse works. Never mutates the input. |
| `focusGroup` | `(ir: DiagramIR, groupKey: string) => DiagramIR`. Only the group's descendants (re-parented to the top level). Every edge crossing the boundary connects to a ghost node for the nearest top-level outside ancestor: key `ghost:<key>` with `ext.ghost = 'true'`. |

Parsing a source with no `page` lines must give exactly what `parseOcto` gives today.

Implementation notes and additions (all exported from index):
- `parsePage` matches the name exactly, then case-insensitively; returns `null` for an unknown page. Duplicate page names (case-insensitive) are a warning in `parseOctoPages`; the first wins.
- `drillTargets(ir, pageNames, self?)`: the optional `self` (the page the IR came from) is excluded, so a node never drills into its own page. Root is never a target. An unknown `drill:` falls back to the key-name match.
- `parseOctoPages` warns when `drill:` (or bare `drill` → the node's key) names no other page.
- `addPage` returns `src` unchanged when the name is empty or already exists (case-insensitive), quotes names that would not read back, and separates the new page with a blank line.
- `collapseGroups`: edges between visible nodes stay untouched (parallel ones included); a (from, to) pair merges only when at least one of its edges was rewired. The merged edge keeps the first edge's key, arrows and style; ERD `fromField`/`toField` are dropped on rewired ends. Unknown or non-container keys are ignored.
- `focusGroup`: the ghost stands for the outside endpoint's outermost ancestor that does not itself contain the focused group (an enclosing container that is an endpoint is its own ghost). Ghosts copy label (falls back to the key), icon, shape and color, and also get `ext.ghostOf = '<key>'`. Edges touching the focused group itself, or with both ends outside, are dropped; crossing edges to the same ghost merge like in `collapseGroups`. An unknown key returns a copy of the input.
- Helpers: `pageNames(src)`, `findPage(pages, name)`, `parsePageHeader(line) => string | null`, `printPageName(name)`, `analyzePage(src, page)` (statement-level analysis with full-source offsets), `editPage(src, page, edit)` (runs a text transform on one page body and splices it back; throws on an unknown page), `ROOT_PAGE`, `GHOST_PREFIX`, type `ParsedPage`, type `ApplyOptions`.
- Editor autocomplete for `drill` lives in `apps/web/src/editor/completion.ts` (web agent).

**Web:**
- **Store:** `page` (current page name) and `collapsed: Record<pageName, string[]>`. Both are view state (localStorage), not code. The canvas renders `collapseGroups(parsePage(code, page).ir, collapsed[page])`. Pins are per page: key them as `<page>/<key>` for non-root pages, and leave root keys unchanged for backward compatibility.
- **Breadcrumbs:** a bar at the top-left of the canvas, e.g. `Checkout › Payments flow`. Clicking a crumb goes back. Backspace or Alt+↑ goes up one level. When a page has several entry nodes, the path is the stack of visited pages.
- **Drillable nodes** show a small "↘" corner affordance. Double-click or Enter drills in. The camera animates: zoom into the node's box with a fade, then the sub-page fits the view. Going back reverses it.
- **Groups:** a chevron on the group header collapses or expands it (animated). A collapsed group renders as a node with a stacked-card look and a count badge. Double-click on a group's header enters focus mode, which uses the same breadcrumb (`Checkout › Backend`). Ghost nodes are dashed and faded, and clicking one exits focus to that node.
- **Code panel:** a page tab strip above the editor, plus "+ page". The editor scrolls to and highlights the current page's section, and moving the caret into another page switches the canvas.
- **Agent hooks:** `window.octo.getPage()` and `window.octo.setPage(name)`.

## Source scanning (`packages/scan`, `@octo-draw/scan`)

Point octo-draw at a code repo or infrastructure files and get an architecture diagram as octo DSL with drill-down pages. Analyzers are **pure**: they take `ScanFiles = Map<repoRelativePosixPath, text>` and never touch the file system, so the web app can run them in the browser on a `showDirectoryPicker` folder. The fs walker is separate (`@octo-draw/scan/node`).

| Export | Signature |
|---|---|
| `scanSource` | `(files: ScanFiles, opts?: { only?: AnalyzerName[]; title?; rootName?; ci?: boolean; maxModuleNodes?: number }) => { code; ir; pages: { name; ir }[]; findings: { analyzer; confidence; notes }[]; warnings; graph }` |
| `emitGraph` | `(graph, headerComments?) => string` re-emits a (refined) `graph` |
| `analyzeCode` / `analyzeCompose` / `analyzeK8s` / `analyzeTerraform` / `analyzeOpenApi` | `(files) => AnalyzerResult` (`{ analyzer, confidence, notes, warnings, root, pages }`) |
| `walkDir` (node) | `(dir, { maxFiles=4000, maxFileBytes=512K, maxTotalBytes=24M, maxDepth=12 }) => { files, root, skipped, warnings }`: skips `node_modules`, `dist`, `.git`, `vendor`, `build` (and other build/cache dirs, hidden dirs except `.github`), secrets (`.env*`, keys, `*.tfvars`, state), lockfiles and binaries; follows symlinks only inside the root |
| `scanDir` (node) | `(dir, opts?) => scanSource result + { root, fileCount, files }` |

- **AnalyzerName:** `code | compose | k8s | terraform | openapi` (selectable with `only`), plus `actions` (GitHub Actions, enabled by `ci: true`).
- **Output:** `title <name> architecture`, a `// scanned by octo-draw: …` comment, a `direction right` root page, then `page <Name>` sections. Every workspace with a module graph gets `drill: "<key> modules"`. Node keys are stable and readable: workspace short names (`server`), compose / k8s names, Terraform addresses (`aws_lambda_function.api`), external systems (`Postgres`, `LLM API`).
- **Merging:** compose services match workspaces by build context dir or name (the compose name becomes the key); data stores inferred from dependencies (`pg` → Postgres) merge into the compose service running that image (`postgres:16`). Kubernetes and Terraform get their own pages (`Kubernetes`, `Terraform infrastructure`) when the root already has code/compose; otherwise they are the root. OpenAPI specs (page `API <title>`) are drilled from the owning service, or from its module page if that service already drills.
- **Icons** are always core catalog names (`resolveIcon` / `searchIcons`): images and dependencies map via data tables (`EXTERNALS`, `TERRAFORM_TYPE_ICONS`).
- **Secrets:** env values and Secret data are never output (hosts in connection URLs are used for edges, Secrets by name only).

**Connectors** (`connectors/`): one input box for any source.

```ts
interface SourceRef { kind: 'local' | 'github' | 'huggingface' | 'aws' | 'gcp' | 'azure'; id: string; ref?: string; options?: Record<string, unknown> }
interface ConnectorContext { fetch: typeof fetch; env: Record<string, string | undefined>; signal?: AbortSignal; log?: (msg: string) => void }
interface ConnectorResult { code: string; findings: { analyzer: string; confidence: number; notes?: string[] }[]; warnings: string[]; source: SourceRef; files?: Map<string, string> /* never serialized */ }
interface Connector { kind: SourceRef['kind']; parse(input: string): SourceRef | null; scan(ref: SourceRef, ctx: ConnectorContext): Promise<ConnectorResult> }
```

- **Registry:** `registerConnector(c)`, `resolveSource(input)` (non-local connectors first, local last), `scanAny(input | ref, ctx)`. Failures throw `ConnectorError(message, status)`. `local` is registered by `@octo-draw/scan/node` (absolute, `./`, `~/`, `file://`, `local:` paths); `github` is built in.
- **GitHub:**
  - **Input:** `github.com/o/r`, `…/tree/<ref>/<subdir>` (refs with slashes are resolved), `o/r@ref[/subdir]`, `github:o/r[/subdir]`, `git@github.com:o/r.git`.
  - **Fetching:** the REST API (`/repos/{o}/{r}`, `/languages`, `/git/trees/{ref}?recursive=1`) plus raw contents for the scannable files only. Manifests and infra come first, then config, then source, within a budget (1200 files / 16 MB / 256 KB each), fetched 12 at a time.
  - **Output:** the repo description becomes the title. `// source:` and `// repo languages:` comments are added. Workspace nodes get `link:` to their GitHub path, and a `CI/CD` page is built from `.github/workflows` (jobs, `needs`, deploy targets).
  - **Auth:** `GITHUB_TOKEN` / `GH_TOKEN`; the CLI and server fall back to `gh auth token`. The token is only sent to api.github.com and raw.githubusercontent.com. Rate limits give a clear 429 `ConnectorError` with the reset time.

**CLI:** `octo-draw scan <dir|source> [-o out.octo] [--render out.svg] [--only code,compose,k8s,terraform,openapi] [--json] [--title T]`. Folders are tried first; anything else goes through `resolveSource`. `--render` draws the root page.

## Recursive drill-down (v2)

Drill-down works at any depth, both across pages and within groups on one page. Deeper levels can be generated on demand.

### 1. Nested pages
- **Page tree:** pages stay a flat list in the code, and the tree comes from `drill:` links. `pageTree(src) => PageTreeNode[]` where `PageTreeNode = { name: string; via?: string /* node key on the parent page */; children: PageTreeNode[]; depth: number }`.
  - The root is the top.
  - A page reachable from several parents appears under its first parent (BFS order). Cycles are cut and noted on the node with `cycle: true`.
  - Orphan pages, which no node drills into, go under a synthetic "Unlinked" entry.
- **Path-style page names** like `server modules / sync / room.ts` are just names. Generated pages use `<parent page> / <node label>`, so the code reads as a tree and names stay unique.
- **Breadcrumbs:**
  - They come from the navigation stack. Deep links (opening a page directly, or the caret moving into a page) rebuild the stack from `pageTree` (`pagePath(src, name) => { page, via }[]`).
  - Long trails collapse the middle into a "…" menu.

### 2. Nested groups on one page
- Groups nest to any depth; that already works.
- **Focus inside focus:** focusing a group inside a focused view pushes a new crumb (`Checkout › Backend › Workers`). `focusGroup` works on the original page IR with the deepest group key, and ghosts are computed against that group.
- **Depth control:** `collapseToDepth(ir, depth) => string[]` returns the container keys that are deeper than `depth`, to feed `collapseGroups`. The web adds a "Levels: All / 1 / 2 / 3…" control to the canvas chrome that sets `collapsed[page]` from it.
- **Collapsed nested groups** show a count of all descendants, plus the number of direct children.

### 3. On-demand expansion (lazy drill)
A node can be expanded into a new page when it has no page yet.
- **Source refs:** scanners put the scanned origin on nodes as the prop `src`, e.g.:
  - `src: "local:apps/server/src/sync"`
  - `src: "github:o/r@sha:path"`
  - `src: "aws:arn:aws:lambda:…"`
  - `src: "hf:org/model#layers.0"`
  The value is relative to a document-level directive `source <connector input>` on the root page (e.g. `source github.com/o/r@abc123`), so repo-relative paths stay short. `src` lands in `ext` like `drill`.
- **Expandable nodes:** a node is expandable if it has no drill target and either has `src` (a source expander exists for its kind) or is any other node (AI expansion). The web shows a different corner mark for "expandable" (dotted ↘) than for "has page" (solid ↘).
- **Expander API (`@octo-draw/scan`):** `expandNode(input: { source: string /* the document's source directive */; src: string; node: { key; label? }; parentPage: string; depth?: number }, ctx) => Promise<{ body: string /* octo page body */; title: string; findings; warnings }>`.
  - **Code:**
    - A directory gives its subdirectories and files, with import edges aggregated at that level and external systems.
    - A file gives its top-level symbols: classes, functions, exported consts, types/interfaces, with call/reference edges between them and imports to sibling files as ghost-ish nodes.
    - A class gives its methods and properties, with calls between methods.
    - Every child node carries its own `src` so it is expandable again.
    - Cap at about 30 nodes per page and fold the rest.
    - TS/JS uses a solid tokenizer-based symbol extractor (no TypeScript compiler dependency). Python, Go and Rust are best-effort.
  - **Cloud:**
    - A VPC gives its subnets and resources; a subnet gives its resources.
    - An ECS service gives its tasks and containers.
    - A Lambda gives its triggers, destinations, env references and IAM role.
    - A load balancer gives its listeners, rules and targets.
    - Other resources give a details page of key props as a note, plus related resources.
    - It reads from the same inventory the scan used: the export or a live read-only call.
  - **Hugging Face:** a model gives its blocks, and a block gives its sublayers.
  - **Depth:** `depth > 1` expands recursively and returns several pages at once (a `body` with extra `page` sections).
- **AI expansion:** `POST /api/expand { code, page, node, mode: 'auto' | 'ai' | 'source' }`.
  - In `auto` mode the source expander is used when `src` resolves, otherwise AI.
  - AI mode sends the full doc (all pages), the parent page and the node to Claude. Claude returns a page body that decomposes the node into its internals, with nodes consistent with the surrounding pages and edges to ghost references of the parent's neighbours. It streams over SSE like `/api/generate`.
  - Response: `{ code }`. This is the full new code: the page appended via `addPage(src, '<parent> / <label>', body)` and the node patched with `drill:` via `setNodeProp(..., page)`. Expanding is therefore a normal code edit: synced, undoable, visible to agents.
  - **MCP:** `expand_node { node, page?, mode?, depth? }`.
- **Scan depth:** `scan --depth N` (and `/api/scan { depth }`) pre-generates N levels using the same expanders. The default is 1, which is today's behaviour: root plus one module page per service.

### v2 implementation notes (as built)
- **Core** (`packages/core/src/drill/tree.ts`, exported): `pageTree(src) => PageTreeNode[]` (`{ name; via?; children; depth; cycle?: true; unlinked?: true }`; root first, synthetic `{ name: 'Unlinked', unlinked: true }` last when there are orphans), `pagePath(src, name) => { page; via? }[]` (unknown → `[]`, root → `[{ page: '' }]`), `collapseToDepth(ir, depth) => string[]` (top-level = level 1; every container at level ≥ depth; non-finite → `[]`), `sourceDirective(src) => string | undefined`. `DiagramIR.source?: string` (root page only; a `source` on another page is a warning). `collapseGroups` adds `ext.children` (direct children) next to `ext.collapsed` (descendants). `drillTargets` returns a null-prototype record. Fixture: `packages/core/fixtures/deep.octo` (6 page levels, 5 group levels, a cycle, an orphan).
- **src values:** `<scheme>:<path>[#fragment]`. Code: `local:` / `github:` + repo-relative path (`local:.` = root), fragments `Class`, `Class.method`, `uses:<System>` (files using an external system); config files `docker-compose.yml#services.api`, `k8s.yaml#Deployment/api`, `main.tf#aws_lambda_function.api`. Cloud: `aws:<arn>`, `gcp:<name>`, `azure:<id>`. HF: `hf:org/model#path`.
- **Scan** (`@octo-draw/scan`): `expandNode(input: ExpandNodeInput, ctx: ExpandContext) => Promise<ExpandNodeResult>` (`{ body, title, findings, warnings, pages }`); `registerExpander(kind, fn: Expander)` where `Expander = (req: ExpanderRequest, ctx: ExpandContext) => Promise<ExpandedPage | null>`, `ExpandedPage = { body; children?: string[]; findings?; warnings? }` (one page body; `children` = node keys recursed into for depth > 1). `registerFileSource(kind, factory)` for code (local: `@octo-draw/scan/node`, fs confined to the root; github: REST tree + raw). `ScanOptions.depth` (also `maxNodesPerPage` 30, `maxPages` 200, `timeBudgetMs` 20000; cloud connectors use `maxDiagramPages`). `deepenScan`, `deepenSync/deepenAsync/applyDeepen`, `extractSymbols(path, text)` (TS/JS tokenizer-based; Python/Go/Rust best effort). Generated page names are `<parent page> / <label>` (labels lose a trailing `/`).
- **Server:** `POST /api/expand { code, page?, node, mode?, depth?, options?, stream? }`. SSE by default (`{delta}` chunks in AI mode, then `{ done: true, code, page, pages, mode, warnings, findings }`); `stream: false` returns that object as JSON. Errors: 400 bad request / no source, 403 outside OCTO_SCAN_ROOTS or foreign origin (source expansion is loopback-only like `/api/scan`), 404 unknown page/node/src, 409 node already has a page, 503 no credentials (AI). auto falls back to AI (with a warning) when source expansion fails. `/api/scan { depth }` (1-5). MCP: `expand_node { node, page?, mode?, depth?, docId? }`, `scan_source { depth? }`.
- **CLI:** `octo-draw scan --depth N`, `octo-draw expand <file.octo> --node <key> [--page P] [--depth N] [-o out]` (stdout by default; a relative local `source` resolves against the file's folder).
