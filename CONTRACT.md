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
| `setNodeProp` | `(src: string, key: string, prop: string, value: string \| null) => string` — minimal text edit on the node's declaration (adds a declaration line if the node is only implicit); `null` removes the prop | `src/dsl/patch.ts` |
| `renameNodeLabel` | `(src: string, key: string, label: string) => string` — sets `label:` (identity unchanged) | `src/dsl/patch.ts` |
| `parseMermaid` | `(src: string) => ParseResult` — flowchart/graph subset, hand-written, no mermaid dep | `src/mermaid/parse.ts` |
| `toMermaid` | `(ir: DiagramIR) => string` | `src/mermaid/print.ts` |
| `parseAscii` | `(text: string) => ParseResult & { confidence: number }` — ASCII/Unicode box diagrams from chat LLMs | `src/ascii/parse.ts` |
| `detectFormat` | `(text: string) => TextFormat` where `TextFormat = 'octo' \| 'mermaid' \| 'ascii' \| 'plain'` | `src/import/detect.ts` |
| `importText` | `(text: string) => { format: TextFormat; ir: DiagramIR; diagnostics: Diagnostic[] } \| null` — strips markdown ``` fences first | `src/import/detect.ts` |
| `layoutDiagram` | `(ir: DiagramIR, opts?: LayoutOptions) => Promise<DiagramLayout>` — ELK layered, compound groups, orthogonal edges; pinned nodes stay put and their edges are re-routed | `src/layout/layout.ts` |
| `applyActions` | `(src: string, actions: AgentAction[]) => ApplyResult` — edits octo DSL source | `src/agent/apply.ts` |

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

## Agent / AI server (`apps/server`)

A Node HTTP server on port **8787**. Vite proxies `/api` to it. It uses `@anthropic-ai/sdk`, model `claude-opus-5-5`, credentials from the environment (`ANTHROPIC_API_KEY` or an `ant auth login` profile). The key must never be sent to the browser.

- `POST /api/generate` `{ prompt, code? }`: streams text/plain chunks of octo DSL (`text/event-stream`, `data: {"delta": "..."}` lines, then `data: {"done": true, "code": "..."}`). With `code`, it edits the existing diagram.
- `POST /api/vision` `{ imageBase64, mediaType }`: takes an image of a diagram (ChatGPT/Gemini/whiteboard) and returns `{ code }` in octo DSL.
- `POST /api/agent` `{ prompt, code }`: returns `{ actions: AgentAction[], code, errors }` using tool use (an `apply_actions` tool whose schema is AgentAction[]).
- An MCP stdio server (`src/mcp.ts`) with the tools `get_diagram`, `set_diagram`, `apply_actions`, `import_text`, `export_mermaid`. It talks to the running server's document via `GET/PUT /api/doc`. The web app syncs its current code to `/api/doc` when it changes and polls (or uses SSE `GET /api/doc/events`) so that external agents' edits show up live.

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
- **Paste:** text runs through `importText` (mermaid, ASCII box art and octo get converted to octo code via `printOcto`). Images go to `/api/vision`.
- **Persistence:** localStorage.
- **Agent hooks:**
  - `window.octo = { getCode, setCode, applyActions, getIR, getLayout }`.
  - When the AI or an agent is editing, show an "AI is drawing…" presence badge with a cursor on the canvas.
