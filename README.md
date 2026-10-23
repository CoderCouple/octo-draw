# octo-draw

octo-draw is a diagram-as-code editor in the style of Eraser.io. You write diagram code on the left, see a live canvas on the right, and an AI bar sits on top. It is built to be embedded: the document format is stable and versioned, and the same core renders diagrams in the browser, on a server, or from the command line.

It has four goals:

1. **Human drawing.** Drag nodes to pin them, draw freehand with pen, shapes, arrows, text, sticky notes and images, and undo/redo all of it.
2. **Agent drawing.** AI agents edit diagrams through a small action API (`addNode`, `addEdge`, …), from the in-app agent panel, the HTTP API or MCP. Their edits appear live.
3. **Diagram-as-code.** An Eraser-compatible DSL for flowcharts, architecture diagrams, sequence diagrams and ERDs, with ELK auto-layout.
4. **Import what AI models produce.** Paste mermaid, ASCII box art from a chat answer, or a screenshot of a diagram (via Claude vision) and get editable code.

## Repository layout

| Path | Package | What it is |
|---|---|---|
| `packages/core` | `@octo-draw/core` | Parsers, printers, layout, the agent action API, the document format, headless SVG rendering, tldraw interop. No DOM needed |
| `apps/web` | `@octo-draw/web` | The editor (Vite, React 19, zustand, CodeMirror 6) |
| `apps/server` | `@octo-draw/server` | AI endpoints, the shared document (`/api/doc`) and the MCP server |
| `apps/cli` | `@octo-draw/cli` | The `octo-draw` command: convert, render, push and pull |
| `docs/` | | Design notes, e.g. [EMBEDDING.md](docs/EMBEDDING.md) |

`CONTRACT.md` holds the shared types and conventions that contributors (human or agent) build against.

## Quick start

You need Node 22 or later and pnpm 10.

```bash
pnpm install
pnpm dev          # web on http://localhost:5173, API server on http://localhost:8787
```

Other commands:

```bash
pnpm test         # every package's tests in one vitest run
pnpm typecheck    # tsc in every package
pnpm build        # production build of the web app
```

### AI setup

The AI features (generate, edit, image import, agent panel) run on the server with `claude-opus-5-5`. The browser never sees the key. Give the server credentials in one of these ways:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # or ANTHROPIC_AUTH_TOKEN
# or sign in once with: ant auth login
```

Without credentials everything else still works, and the AI endpoints answer `503`. See [apps/server/README.md](apps/server/README.md) for the full HTTP API and environment variables (`PORT`, `OCTO_DOC_FILE`, `OCTO_SERVER_URL`, …).

### MCP

The MCP server lets Claude Code, Claude Desktop or any MCP client read and edit the diagram that is open in your browser. Start `pnpm dev` first, then register it:

```bash
claude mcp add octo-draw -- pnpm --silent --dir /path/to/octo-draw/apps/server mcp
```

Tools: `get_diagram`, `set_diagram`, `apply_actions`, `import_text`, `export_mermaid` and `get_diagram_svg`.

## CLI

```bash
pnpm cli --help                                            # or: node apps/cli/bin/octo-draw.mjs
pnpm cli convert flow.mmd --to octo > flow.octo            # mermaid → octo DSL
pnpm cli convert notes.txt --to mermaid                    # ASCII box art → mermaid
pnpm cli render flow.octo -o flow.svg --theme dark         # headless SVG, with icons
pnpm cli convert canvas.tldraw.json --to json -o doc.json  # tldraw snapshot → octo document
pnpm cli convert flow.octo --to tldraw -o canvas.tldraw.json
pnpm cli push flow.octo                                    # replace the open editor's diagram
pnpm cli pull --to svg -o now.svg                          # fetch it back in any format
pnpm cli schema                                            # JSON schema of the document format
```

The input format is detected automatically: octo DSL, mermaid flowcharts, ASCII box art (markdown fences are fine), octo documents (`.json`, any version) or tldraw snapshots. Output formats are `octo`, `mermaid`, `svg`, `json` and `tldraw`. To link the `octo-draw` binary globally, run `pnpm --dir apps/cli link --global`.

## Document format

An `OctoDocument` (version 1) is plain JSON. It holds the diagram code, positions the user pinned by dragging, the freehand layer and display preferences. Layout is never stored; it is recomputed from the code and pins.

```json
{
	"version": 1,
	"id": "6f0c…",
	"title": "My system",
	"format": "octo",
	"code": "Users > API: HTTPS\n",
	"pins": { "API": { "x": 320, "y": 40 } },
	"shapes": [{ "id": "a1", "type": "sticky", "x": 0, "y": 200, "w": 200, "h": 200, "text": "todo", "color": "ink", "size": 1 }],
	"theme": { "appearance": "system" },
	"createdAt": "2026-10-22T10:00:00.000Z",
	"updatedAt": "2026-10-22T10:05:00.000Z"
}
```

`@octo-draw/core` exports `createDocument`, `validateDocument`, `migrateDocument` (it upgrades older documents, including the web app's original localStorage shape), `parseDocument`, `serializeDocument` and `OCTO_DOCUMENT_SCHEMA`. It also exports `renderDocumentSvg` for headless thumbnails, and `fromTldrawSnapshot` / `toTldrawSnapshot` for moving canvases to and from tldraw v5.

## DSL cheat sheet

```
// comments with // or #
title My system
direction right            // down | up | right | left
colorMode pastel           // pastel | bold | outline
styleMode shadow           // shadow | plain | watercolor
typeface clean             // rough | clean | mono

Users [icon: users, shape: oval]
Backend [color: blue] {               // a group; groups nest
  API gateway [icon: server]
  Worker [icon: cpu]
}
DB [shape: cylinder, icon: database, label: "Postgres 16"]

Users > API gateway: HTTPS            // labeled arrow
API gateway > Worker, DB              // branching
Worker > DB > Backups                 // chaining; Backups is created implicitly
Worker <> Cache [color: red]
Worker -- Logs                        // dotted line
API gateway --> Audit: async          // dotted arrow
```

| | |
|---|---|
| Operators | `>` arrow, `<` reverse, `<>` both, `-` line, `--` dotted line, `-->` dotted arrow. They need spaces around them, so names like `main-vpc` stay intact |
| Names | May contain spaces. Quote them when they contain `[ ] { } , : "` or an operator |
| Node props | `shape` (rectangle, oval, ellipse, diamond, cylinder, hexagon, parallelogram, document, trapezoid, triangle, star, cloud), `icon` (lucide names and aliases such as `db`, `k8s`, `aws-lambda`), `color` (palette name or `#hex`), `label`, `link`, `drill` (page to open) |
| Edge props | `id`, `color`, `dash` |

**Sequence diagrams** start with `sequence`:

```
sequence
autoNumber on
Web App [icon: monitor] > API: login
activate API
API --> Web App: token
deactivate API
alt [label: ok] { … } else [label: error] { … }      // also loop, opt, par … and, break, critical
note over Web App, API: text                          // or: note left of X / note right of X
```

**ERDs** start with `erd`:

```
erd
users [icon: user] {
  id string pk
  teamId string fk
}
users.teamId > teams.id      // > many-to-one, < one-to-many, - one-to-one, <> many-to-many
notation crows-feet          // or chen
```

**Pages and drill-down.** A line that is exactly `page <Name>` (column 0; quote the name if needed; a trailing comment is fine) starts a sub-diagram that runs until the next `page` line. Everything before the first one is the root page. Double-click a node to drill into its page: the target is its `drill:` prop, or else a page with the same name as the node (case-insensitive).

```
title Checkout
Payments [icon: credit-card, drill: Payments flow]
Orders                                  // drills into "page Orders"
API > Payments, Orders

page Payments flow
direction right                         // directives (and sequence / erd) are per page
Validate > Charge > Receipt

page Orders
Create > Reserve stock > Ship
```

`title` is only read from the root page, and node names are per page. A node called `page`, or a line like `page > x`, is not a page header. A `drill:` naming a missing page is a warning.

## License

MIT, © 2026 Sunil Tiwari. See [LICENSE](LICENSE). Third-party licenses are listed in [NOTICE](NOTICE). Note that elkjs, the layout engine, is EPL-2.0.
