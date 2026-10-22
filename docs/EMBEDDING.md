# Embedding octo-draw: the planned `@octo-draw/react` package

Status: plan. Nothing is extracted yet, because the files involved are being changed heavily right now. This note fixes the public API and lists what has to move, so the extraction can happen in one pass later.

The first host will be **Octonote** (Next.js). Octonote stores canvases as tldraw v5 snapshots in a Postgres `jsonb` column, and its CLI creates canvases with `octonote --from-mermaid`. octo-draw will replace tldraw there, so the component must:

- work inside a Next.js app (client component, no SSR of the canvas, no global CSS leaks)
- load and save a stable JSON document, which is `OctoDocument` v1 from `@octo-draw/core`
- let the host keep its own persistence, auth and AI proxy
- read old tldraw canvases (`fromTldrawSnapshot`) so existing rows can be migrated

## Public API

```tsx
import { OctoDraw, type OctoDrawApi } from '@octo-draw/react'
import '@octo-draw/react/styles.css'
import type { OctoDocument } from '@octo-draw/core'

const api = useRef<OctoDrawApi>(null)

<OctoDraw
	document={doc}                        // OctoDocument (controlled) or defaultDocument (uncontrolled)
	onChange={(next, change) => save(next)} // debounced by the host; `change.kind`: 'code' | 'pins' | 'shapes' | 'title'
	readOnly={!canEdit}                    // no editing; pan, zoom, select and copy still work
	theme="system"                         // 'light' | 'dark' | 'system'
	layout="split"                         // 'split' (code + canvas) | 'canvas' | 'code'
	ai={{ endpoint: '/api/octo/ai' }}      // optional; omit to hide the AI bar and agent panel
	onExportImage={(blob, format) => upload(blob)} // called by the Export menu (svg | png); default downloads
	ref={api}
	className="h-full"
/>
```

Props:

| Prop | Type | Notes |
|---|---|---|
| `document` / `defaultDocument` | `OctoDocument` | Run older JSON through `migrateDocument` first. A changed `document.id` resets undo history |
| `onChange` | `(doc: OctoDocument, change: { kind; source: 'user' \| 'agent' \| 'api' }) => void` | Fires on every committed change. `updatedAt` is already bumped |
| `readOnly` | `boolean` | Hides the toolbar, AI bar and code editor's write access |
| `theme` | `'light' \| 'dark' \| 'system'` | Overrides `document.theme.appearance` |
| `layout` | `'split' \| 'canvas' \| 'code'` | Octonote's read view uses `canvas` |
| `ai` | `{ endpoint: string; headers?: () => Record<string, string> } \| false` | The host proxies to its own server, which uses `@octo-draw/server`'s handlers (see below) |
| `onExportImage` | `(blob: Blob, format: 'svg' \| 'png') => void` | |
| `icons` | `(name: string) => IconNode \| null` | Defaults to the lazily loaded lucide set |
| `ref` | `OctoDrawApi` | |

Imperative API (`ref`). This is the same surface as today's `window.octo`, plus document-level calls:

```ts
interface OctoDrawApi {
	getDocument(): OctoDocument
	setDocument(doc: OctoDocument): void
	getCode(): string
	setCode(code: string): void
	applyActions(actions: AgentAction[]): ApplyResult   // one undo step
	getIR(): DiagramIR | null
	getLayout(): DiagramLayout | null
	importText(text: string): boolean                   // mermaid / ASCII / octo
	exportSvg(opts?: { theme?: 'light' | 'dark' }): string
	exportPng(opts?: { scale?: number }): Promise<Blob>
	fit(): void
	undo(): void
	redo(): void
}
```

## Server side for hosts

Hosts don't run `apps/server`. A later `@octo-draw/server` package exports framework-neutral handlers (`generate`, `vision`, `agentStream`) that take a `StreamFn`, so a Next.js route handler can wrap them with the host's auth and API key. For thumbnails and the CLI, `renderDocumentSvg(doc)` from `@octo-draw/core` works in any Node runtime. It needs no DOM or browser.

## Migrating Octonote canvases

1. Read the row's tldraw snapshot (`{ store, schema }`, or `{ document, session }`).
2. Call `fromTldrawSnapshot(snapshot, { onWarning })`. It maps geo shapes to nodes, dashed or unfilled boxes and frames that contain other boxes to groups, bound arrows to edges, and text, draw, line, note and image shapes to the freehand layer. Leaf nodes are pinned, so the arrangement survives.
3. Store the resulting `OctoDocument` in a new column, or alongside the old one with a `format` flag, and keep the tldraw snapshot until the migration is verified.
4. `octonote --from-mermaid` can switch to `importText(mermaid)` → `printOcto` → `createDocument`. Until then, its existing tldraw output converts with step 2. `apps/cli/fixtures/octonote-canvas.tldraw.json` is a real example and is covered by tests.
5. To go back, `toTldrawSnapshot(doc, layout)` produces records that pass tldraw 5.5's own validators. Groups become dashed geo boxes and edges become bound arrows.

## What must be extracted from `apps/web`

Target layout: `packages/react` (the component), with `apps/web` becoming a thin app that renders `<OctoDraw>` full screen and adds what only the standalone product needs.

| Today (`apps/web/src`) | Moves to | Change needed |
|---|---|---|
| `store.ts` (global zustand store) | `packages/react/src/store.ts` | One store **per instance**, created by `createOctoStore(initialDoc)` and passed through React context. No module-level `useStore` singleton, because two editors on one page must not share state |
| `canvas/*` (Canvas, DiagramLayer, SequenceLayer, ErdLayer, freehand, selection, snap, SelectionOverlay, AgentPresence, camera) | `packages/react/src/canvas/` | The camera becomes per-instance state. Keyboard handlers attach to the editor root, not `window`. Element ids like `octo-world` and filter ids get an instance prefix |
| `canvas/geometry.ts` | delete; use `@octo-draw/core/src/render/geometry.ts` | Already duplicated in core for headless rendering |
| `lib/colors.ts` | keep the CSS-variable reader; import `PALETTE`, `mix`, `nodeColors` and the rest from `@octo-draw/core/src/render/colors.ts` | Removes the second copy of the color rules |
| `lib/icons.ts` | `packages/react` | Import `ICON_ALIASES` / `iconCandidates` from core; accept the `icons` prop |
| `lib/export.ts` | `packages/react` | Prefer `renderDiagramSvg` from core over cloning the DOM, so exports match the server and CLI exactly |
| `lib/pipeline.ts`, `lib/layoutClient.ts` (layout worker) | `packages/react` | The worker URL must work under Next.js bundling (`new Worker(new URL(...), { type: 'module' })`) |
| `lib/actions.ts`, `lib/clipboard.ts`, `lib/importing.ts`, `lib/images.ts` | `packages/react` | Images should go through a host `uploadImage` callback instead of data URLs in the document |
| `editor/*` (CodeMirror language, completion, Editor) | `packages/react/src/editor/` | |
| `components/*` (TopBar, CanvasChrome, PasteDialog, AgentPanel, Icon) | `packages/react/src/ui/` | The TopBar's title and file actions become optional slots |
| `lib/persist.ts` (localStorage) | stays in `apps/web` | The host owns persistence, so the component only emits `onChange`. The web app's saved shape is already readable by `migrateDocument` (v0) |
| `lib/sync.ts` (`/api/doc` + SSE) | stays in `apps/web` (optional `useDocSync` helper) | The single shared server document is a local-dev feature, not part of the component |
| `lib/api.ts`, `lib/agent.ts`, `lib/presence.ts` | `packages/react` | Hard-coded `/api/...` URLs come from the `ai.endpoint` prop |
| `lib/theme.ts` | `packages/react` | Driven by the `theme` prop. Never toggle classes on `<html>`; scope them to the editor root |
| `styles.css` | `packages/react/styles.css` | Every selector is scoped under `.octo-draw`, and CSS variables are set on that root, not `:root` |
| `main.tsx` (`window.octo`, starter, example loader) | stays in `apps/web` | `window.octo` becomes a call to the ref API |

Packaging: ESM only, with React 19 as a peer dependency. `@octo-draw/core` must be built to JS (today it ships TS sources) before `@octo-draw/react` can be published or consumed by Next.js without `transpilePackages`.

## Order of work

1. Build `@octo-draw/core` to `dist/` (tsc or tsdown) and keep `src/` exports for the monorepo.
2. Make the store per-instance (`createOctoStore` plus context) while it still lives in `apps/web`. This is the riskiest change, so land it alone.
3. Move files into `packages/react` in the order of the table above. `apps/web` imports from the package.
4. Add the `document` / `onChange` contract, with tests that render two instances side by side.
5. Add an `examples/nextjs` app that mirrors Octonote's setup (client component, `dynamic(() => import(...), { ssr: false })`, `jsonb` round-trip).
