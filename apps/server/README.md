# @octo-draw/server

A plain `node:http` server on port 8787. It holds the AI endpoints and the shared diagram document.

```bash
pnpm --dir apps/server dev      # tsx watch, http://localhost:8787
pnpm --dir apps/server test     # vitest (the Anthropic client is mocked)
```

## Credentials

The server uses `claude-opus-5-5` through `@anthropic-ai/sdk`. It reads credentials from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile.

Without credentials the server still starts. The AI endpoints then return `503 {"error":"No Anthropic credentials. ..."}`, and the document endpoints keep working.

Server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) are on by default. Turn them off with `OCTO_FALLBACKS=0`. The code for this lives in one block in `src/claude.ts`.

Environment variables:

| Variable | Default |
|---|---|
| `PORT` | `8787` |
| `OCTO_DOC_FILE` | `./data/doc.json` |
| `OCTO_FALLBACKS` | on (`0` turns it off) |
| `OCTO_SERVER_URL` | `http://localhost:8787` (used by the MCP server) |

## HTTP API

| Route | Body | Response |
|---|---|---|
| `POST /api/generate` | `{prompt, code?}` | SSE: `data: {"delta"}` events, then `{"done":true,"code"}`, or `{"error"}` on failure |
| `POST /api/vision` | `{imageBase64, mediaType}` | `{code, diagnostics?}`. The output is validated with `parseOcto`, with one repair round if it fails |
| `POST /api/agent` | `{prompt, code}` | `{actions, code, errors, message}`. Uses the `apply_actions` tool, up to 4 turns |
| `POST /api/agent/stream` | `{prompt, code, history?, selection?, mode?, source?}` | SSE, see below. The chat agent behind the web app's Agent panel |
| `GET /api/doc` | | `{code, version, source, updatedAt}` |
| `PUT /api/doc` | `{code, baseVersion?, source}` | `{code, version}`. Returns `409` if `baseVersion` is stale |
| `GET /api/doc/svg` | `?theme=light\|dark&scale=1&background=1` | `image/svg+xml`: the current diagram rendered headlessly (thumbnails, CLI, MCP `get_diagram_svg`) |
| `GET /api/doc/events` | | SSE: `{code, version, source}` once on connect and again on every change |
| `POST /api/doc/actions` | `{actions, source?}` | `{code, version, applied, errors}`. The change is broadcast to `/api/doc/events` listeners |

### `POST /api/agent/stream`

The multi-turn chat agent. Body:

- `prompt`: the user's request.
- `code`: the current diagram source.
- `history`: earlier turns as `[{role: "user" | "assistant", content: string}]` (text only; the last 16 are kept, consecutive same-role turns are merged).
- `selection`: selected node keys, given to the model as context for "this" / "these".
- `mode`: `edit`, `explain` or `auto`. When omitted it is picked from the wording ("explain…", "what does…" → `explain`; "add…", "make…" → `edit`). `explain` answers without tools; `edit` nudges the model once if it replies without calling `apply_actions`.
- `source`: the doc-store source id to write under (the web app sends its sync id so its own tab ignores the echo).

Events, one `data: {...}` line each:

| Event | Meaning |
|---|---|
| `{type:"mode", mode}` | The mode in use |
| `{type:"text", delta}` | Streamed reply text |
| `{type:"progress", count}` | Actions in the tool call still streaming (eager input streaming; informational) |
| `{type:"actions", actions, code, applied, errors}` | One validated `apply_actions` call, already applied. `code` is the full diagram after it |
| `{type:"done", code, message, errors}` | The run finished |
| `{type:"error", message}` | The run failed (refusal, API error, ...) |

Each applied step is also written to the shared document, so other open tabs and MCP clients see the agent's edits live. Tool inputs are streamed eagerly (`eager_input_streaming`), so every input is validated with zod before it is applied. Tool calls from a turn that stopped on `max_tokens` or `refusal` are never applied. Disconnecting aborts the model request.

CORS is allowed for `localhost` and `127.0.0.1` origins.

## MCP server (Claude Code and other MCP clients)

`src/mcp.ts` is an MCP stdio server with six tools: `get_diagram`, `set_diagram`, `apply_actions`, `import_text`, `export_mermaid` and `describe_diagram` (read-only: a one-line summary, stats such as entry points, sinks, most connected and unconnected nodes and nesting depth, plus the full IR as JSON). There is no image tool: rendering needs a browser. It forwards every call to the running HTTP server's `/api/doc*` routes. Edits made through it show up live in the open web app.

1. Start the HTTP server: `pnpm --dir apps/server dev`.
2. Register the MCP server with Claude Code:

   ```bash
   claude mcp add octo-draw -- pnpm --silent --dir /absolute/path/to/octo-draw/apps/server mcp
   ```

3. In Claude Code, ask for things like "draw our checkout flow in octo-draw" or "import this mermaid into octo-draw".

To point the MCP server at another host, set `OCTO_SERVER_URL`: `claude mcp add octo-draw -e OCTO_SERVER_URL=http://localhost:8787 -- pnpm --silent --dir ... mcp`.

Keep `--silent`. Without it pnpm writes its `> @octo-draw/server mcp` banner to stdout, and that corrupts the MCP stdio stream.

## Prompt eval harness

`eval/cases.json` holds 18 realistic requests (flowchart, sequence and ERD generation, agent edits, explain) with deterministic expectations, for example "a node matching `/cache/i`, an edge API → Cache and Cache → DB, and no edge API → DB". `eval/run.ts` runs them against the real API and scores each result with `parseOcto`-based checks:

```bash
ANTHROPIC_API_KEY=... pnpm --dir apps/server exec tsx eval/run.ts           # all cases
ANTHROPIC_API_KEY=... pnpm --dir apps/server exec tsx eval/run.ts agent-    # cases whose id contains "agent-"
```

Without `ANTHROPIC_API_KEY` it prints a skip message and exits 0. Results go to `eval/results.json`. The scorer itself is unit-tested offline (`eval/run.test.ts`).
