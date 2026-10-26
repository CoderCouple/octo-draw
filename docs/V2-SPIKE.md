# v2 spike: rebuilding the core on Eraser's engine

Branch `v2-spike`. Code: `packages/engine` (`@octo-draw/engine`) and the test page `apps/web/src/engine/EnginePage.tsx` (`/?engine=1` on the web dev server (measured on port 5180)). Everything below was measured on an Intel Mac with Node 22.20 and headless Chrome 156 unless stated otherwise. Timings are single runs on a laptop: expect ±20 %.

Short version:

- **Use:** Eraser's protocol (MDP) as the stored format, its resolver for validation, its stock templates, and its corridor router.
- **Keep:** ELK placement, the octo DSL, pages and drill-down, sync and connectors.
- **Renderer:** use it, but only once one problem is solved. Its in-page `run()` hard-wires the router's repair pass to an infinite budget, and blocks the main thread while it runs:

  | nodes | `run()` as shipped | pre-routed in our worker |
  |---|---|---|
  | 50 | 7.7 s | 21 ms |
  | 200 | **29 minutes** | 71 ms |

  Pre-routing means handing the connections over as authored points. The renderer then adopted 100 % of them, but this depends on our size estimates matching its measurements.
- **Biggest data risk:** octo's IR is much poorer than MDP. Corpus diagrams lose styling when they go through the IR, so MDP has to be the source of truth and the IR becomes a derived view.

## 1. Install

`packages/engine/package.json` pins `@eraserlabs/protocol`, `layout`, `resolve`, `render` and `diagram-templates` at exactly `0.3.0`. All five were published 2026-10-22. They pull in `@eraserlabs/utils@0.3.0`.

| package | unpacked | entries (all ESM-only, `"type": "module"`, `exports` map, no CJS build, no `browser` field) | runtime deps |
|---|---|---|---|
| protocol | 35 KB | `.`, `./schema`, `./schemas/document`, `./schemas/tag-schema` (JSON) | none |
| layout | 801 KB | `.` | utils |
| resolve | 132 KB | `.`, `./schema`, `./svg-sanitize` | ajv, marked, parse5, postcss, sanitize-html, fastest-levenshtein |
| render | 388 KB | `.` (node-safe scene types + `buildHtmlDocument`), `./browser` (ESM, **assigns `window.__eraser` on import**), `./fill`, `./browser/iife` (305 KB self-contained IIFE) | layout, protocol, utils |
| diagram-templates | 192 KB | `.`, `./normalizers`, `./svg-transforms` | layout, protocol, render, resolve |

- **Transitive closure:** 30 packages and 5.8 MB on disk. The largest are ajv (1 MB), layout (0.8 MB), dayjs (0.67 MB, via sanitize-html → launder), marked and parse5.
- **Licenses:** all MIT except
  - BSD-3-Clause: fast-uri, source-map-js
  - BSD-2-Clause: entities, domhandler, domutils, domelementtype
  - ISC: picocolors

  layout also vendors RBush (MIT) and Quickselect (ISC), with their notices in `THIRD_PARTY_NOTICES.md`. Nothing copyleft.
- **Engines:** every package declares `node ^22.23.4 || ^24.22.1 || >=26.12.1`. We run 22.20 and pnpm only warned (engine-strict is off). Before v2, bump Node or set `engine-strict=false` deliberately.
- **Node without Chromium** (`scratchpad/spike/imports.mjs`): every entry imports in plain Node, and `require()` of ESM works on Node 22, except `render/browser`, which fails with `window is not defined`. That leaves layout, resolve (validate and resolve), templates, protocol, `render` root and `render/fill` usable server-side, in the CLI and in MCP.
- **Vite in the browser:** works with no aliases or polyfills. See §4 for bundle sizes.
  - layout reads `process.env.NODE_ENV`, which Vite replaces.
  - Eraser's own playground adds `define: { 'process.env': '{}' }`; we did not need it.

## 2. Router

`routeEdges(layout, ir, { touched?, previous?, repair?, repairTimeBudgetMs?, labels? })` lives in `packages/engine/src/route.ts`. It adapts `DiagramLayout` and the IR to `LayoutManager` and `routeCorridorConnectionBatch`.

- **Entities:**
  - absolute boxes, with `containerId` from `parent`
  - `isContainer` from the IR, or from the node having children
  - each group's title row is passed as container `textPlacement`; the router treats it as blocking
- **Connections:** arrowheads are passed as `fromArrowhead` / `toArrowhead`. Labels are sized with core's `estimateText`, and the router places them (`labels: true`), which yields `labelAt`.
- **`touched`:** edges touching the moved nodes, or their descendants when a container moves, are re-routed. Every other edge is adopted at its previous geometry with `pinUnaffectedRoutes: true`. The router only adopts orthogonal polylines; anything else is re-routed.
- **Default budget:** `repairTimeBudgetMs: Infinity`. With a finite budget the result depends on the machine, as the task predicted.

Tests are in `route.test.ts` (5 tests). The comparison harness is `bench.ts` / `bench.test.ts`, run with `BENCH_REPEATS=5`, best of 5. **ELK** is core's full `layoutDiagram` (placement plus routing), so its time is not router-only. **Eraser** is router-only, on ELK's boxes.

| page | n / e | ELK bends / crossings / length / walls / ms | Eraser bends / crossings / length / walls / ms |
|---|---|---|---|
| flowchart | 6 / 6 | 4 / 0 / 1011 / 0 / 5.9 | 4 / 0 / 973 / 0 / 3.3 |
| architecture | 16 / 14 | 20 / 0 / 4421 / 9 / 10.6 | **14** / 0 / 4416 / 9 / 13.9 |
| erd | 4 / 3 | 6 / 0 / 614 / 0 / 3.7 | 2 / 0 / 451 / 0 / 0.6 † |
| drill (root) | 10 / 10 | 17 / 0 / 3258 / 4 / 8.3 | **10** / 0 / 3218 / 4 / 9.3 |
| drill / Payments | 5 / 4 | 2 / 0 / 652 / 0 / 3.9 | 2 / 0 / 588 / 0 / 1.4 |
| drill / Fulfillment | 5 / 3 | 0 / 0 / 219 / 1 / 4.1 | 0 / 0 / 219 / 1 / 0.2 |
| deep (5 levels, `fixtures/deep.octo`) | 24 / 17 | 53 / **0** / 17453 / 42 / 19 | **28** / 3 / **11136** / 42 / 724 |

- Neither router has node hits, diagonals or fallbacks on these pages. Both are deterministic: two runs give identical JSON.
- † Eraser routes ERD edges box to box. Core's ERD router attaches them to field rows. MDP's `DatabaseRelationship` has `fromField` / `toField` and the renderer honours them (see the ERD corpus screenshot), so that case is covered by the renderer rather than the bare router.
- Wall crossings were equal to the nesting minimum in all of these pages. They are not in general (see below).

**Scale.** The synthetic architecture from `synthetic.ts` has groups nested two deep and about 1.3 edges per node. Run with `BENCH_SCALE=1`.

| n / e | ELK (full layout) | Eraser, `repair:false` | Eraser, budget 100 ms | Eraser, budget 1000 ms | Eraser, budget ∞ |
|---|---|---|---|---|---|
| 50 / 64 | 185 ms; 28 crossings, 164 bends | **79 ms**; 42 crossings, 92 bends | 173 ms; 46 / 96 | 1.1 s; 47 / 104 | **11.2 s**; 35 / 108 |
| 200 / 257 | 241 ms; 115 crossings, 621 bends | **124 ms**; 145 / 332 | **9.6 s** (budget ignored) | 9.6 s | not run |

**Deep fixture, budget sweep:**

| setting | time | bends | crossings |
|---|---|---|---|
| ∞ | 0.7–1.0 s | 28 | 3 |
| 100 ms | 117 ms | 30 | 7 |
| 20 ms | 50 ms | 28 | 4 |
| no repair | 14 ms | 26 | 10 |

Findings:

- **Quality:** Eraser's routes have 30–50 % fewer bends and are often shorter.
- **Crossings:** ELK's layered crossing minimisation beats it on crossings every time (0 vs 3 on deep; 115 vs 145 at 200 nodes). ELK places and orders nodes *for* its own routes, and Eraser routes around a placement it did not choose.
- **The repair pass is the problem:**
  - It does not reliably reduce crossings: 42 → 35 at 50 nodes, after 11 s.
  - Its "budget" is only cooperative in some phases. At 200 nodes a 100 ms budget still took 9.6 s.
  - Any finite budget makes the output non-deterministic.
  - **For interactive use, run `repair: false`** (14 ms deep, 79 ms / 124 ms at 50 / 200 nodes), optionally followed by a background repair pass.
- **It cuts through unrelated groups.** In the `route.test.ts` fixture, `Client → DB` runs through the sibling `Public` subnet: in and out, so +2 wall crossings, asserted in the test. The synthetic 200-node graph had +20 extra wall crossings, and ELK had 0. If we want "never enter a group you don't belong to", we need post-checks or obstacle tweaks (for example pass non-ancestor groups as obstacles). The API has no option for that.

**Drag simulation** (move the busiest leaf 200 px right, `touched: { nodes: [key] }`, previous = Eraser's full routes):

| page | re-routed / total | partial: crossings / node hits / ms | core `applyPins` (today): crossings / hits / diagonals | full Eraser re-route: crossings / hits / ms |
|---|---|---|---|---|
| flowchart | 3 / 6 | 1 / 1 / 3.0 | 2 / 1 / 0 | 1 / 0 / 4.6 |
| architecture | 4 / 14 | 2 / 2 / 17 | 0 / 3 / 1 | 3 / 0 / 34 |
| erd | 2 / 3 | 0 / 0 / 1.8 | 1 / 1 / 0 | 0 / 0 / 1.4 |
| drill | 4 / 10 | 2 / 3 / 4.1 | 2 / 3 / 0 | 2 / 3 / 3.9 |
| deep | 6 / 17 | 1 / 0 / 228 | 5 / 2 / 0 | 1 / 0 / 537 |

- Adopted routes stay byte-identical: `kept=true` on every page, and the test asserts it.
- Partial re-routing beats today's `applyPins` on hits and diagonals.
- The remaining hits come from **adopted** edges that the moved node now sits on. `pinUnaffectedRoutes` adopts them blindly. An editor should add "edges whose polyline intersects the moved node's new box" to `touched`, which is a one-line extension.
- Drill's 3 hits come from the moved node overlapping its neighbours; no router fixes that.
- Partial routing with ∞ repair is still slow on deep (228 ms). With `repair:false` it is a few ms.

**Web Worker.** layout uses no DOM and needs only `performance.now()`, which workers have, and the whole bench runs under Node. `route.worker.ts` (`@octo-draw/engine/worker`, loaded with `?worker`) runs `routeEdges` off the main thread. In the test page ("Route in worker", deep fixture, ∞ repair), three runs measured:

| | run 1 (includes worker boot) | run 2 | run 3 |
|---|---|---|---|
| route time inside the worker | 941 ms | 866 ms | 810 ms |
| round trip | 942 ms | 866 ms | 811 ms |
| same call on the main thread | 893 ms | 888 ms | 868 ms |

Structured-clone overhead for `DiagramLayout` + IR is negligible, and the main thread stays free.

**Bundle cost.** Measured with `vite build` (`apps/web`) and source-map attribution (`scratchpad/spike/mapsize.cjs`). The main `index` chunk is unchanged (873 KB / 285 KB gzip, and it contains no Eraser code): the spike page is a dynamic import.

- **Router only** (`route.worker` chunk: layout + adapter): **251 KB, 76 KB gzip**. layout alone is 244 KB.
- **Full in-browser pipeline** (`EnginePage` chunk: resolve + render + templates + layout + page): **920 KB, 282 KB gzip**.

| contributor | size |
|---|---|
| layout | 244 KB |
| parse5 | 123 KB |
| ajv | 94 KB |
| diagram-templates | 88 KB |
| postcss | 53 KB |
| marked | 45 KB |
| resolve | 41 KB |
| render | 28 KB |
| entities + htmlparser2 + sanitize-html + dom* | ~80 KB |
| our engine code + page | ~20 KB |
| Inter woff2 (separate asset) | 48 KB |

About 400 KB of the full pipeline is resolve's validation and sanitisation stack (ajv, parse5, postcss, marked, sanitize-html). That stack could stay server-side if the browser only renders docs that were already resolved, at the cost of an extra round trip per edit.

## 3. MDP mapping

`irToMdp(ir, layout, { includeRoutes? })` and `mdpToIr(doc)` live in `packages/engine/src/mdp.ts`. `toOctoDocument` / `fromOctoDocument` / `octoDocumentToDsl` in `document.ts` wrap pages.

| octo | MDP (stock profile 0.3.0) |
|---|---|
| leaf with `icon`, no `shape` | `Icon`: glyph square of 44 px centred in the ELK box; label in `texts[0]` |
| other leaf | `Shape`: `shape`, `icon`, `texts[0]`, `color` (palette token or hex), `styleMode`, `borderStyle` from `dash` |
| container | `Group` with `title.text` / `title.icon`, `color`; children get `containerId`; containers are emitted before members |
| ERD entity / edge | `DatabaseTable` (`label`, `fields[{ name, type, meta }]`) / `DatabaseRelationship` (`fromField`, `toField`, `relType` ↔ cardinality) |
| edge | `Relationship`: `label`, `lineStyle` (dotted / dashed), `startArrowhead: 'triangle'` for `<`, `<>`; `endArrowhead: null` for `-`, `--`; `color` |
| `typeface` | per-text `typeface` (rough / clean / mono match exactly) |
| labels | markdown-escaped, because MDP text is markdown and octo labels are plain |
| geometry | layout x / y / w / h, shifted so it is ≥ 0 (MDP forbids negative coordinates) |

**Validation.** The profile is the `library` passed to resolve's `createResolver({ library: stockLibrary, normalizers: stockNormalizers, iconLoader })`.

- `resolver.validate(doc)` runs the full pipeline without loading icons.
- `resolver.resolve(doc)` also inlines and sanitises icons.
- Issues carry a stable `code`, a JSON pointer `path` and a did-you-mean suggestion.

This is wrapped as `validateMdp` / `resolveMdp` in `validate.ts`. Every page of every example (except sequence) validates with **0 errors and 0 warnings**. IR → MDP → IR is lossless for all of them, apart from spans and the added geometry, and the multi-page drill example round-trips through the DSL. Tests: `mdp.test.ts`, 15 tests.

**No MDP slot.** Every stock tag schema has `additionalProperties: false`. An unknown element prop draws `W_UNKNOWN_PROP` (a warning, but the prop does not reach the template). An unknown top-level key draws only `W_UNKNOWN_KEY`.

| octo data | carried in |
|---|---|
| `drill`, other `ext.*` (`collapsed`, `ghost`, scan `src` / owner tags…), `link` | sidecar `doc.octo.elements[id].ext` / `.link` |
| `shape: cloud` (no stock shape) | sidecar `.shape`; emitted as a plain `Shape` |
| colors outside the stock palette (`lightblue`, `gray`, …) | sidecar `.color` (the MDP element gets no color). Tokens and hex go through as-is. |
| `color: brand` | icon name `<icon>~brand`; our loader bakes in the brand color |
| `geometry.pinned` | sidecar `.pinned` |
| `kind`, `direction`, `style.colorMode` / `styleMode` / `typeface` (page level), `title`, `erd.notation` | sidecar page fields |
| sequence diagrams (events, blocks, notes, activations) | sidecar `sequence`, with an empty MDP body. MDP has no sequence vocabulary. A lowering to Shapes + vertical `Divider` lifelines + straight `Relationship`s with authored points is possible but not built. |
| spans | not stored (derived from the DSL) |
| declaration order | sidecar `order` |

**Options for carrying the extras:**

1. **Envelope / sidecar (implemented).** `doc.octo` next to `entities` / `connections`, keyed by element id. It is stripped before validation, so stock tools see a clean MDP doc. It costs nothing and is the recommended option.
2. **Custom "octo" profile.** Extend each stock schema with an `x-octo`-style `octo` object prop. The schema vocabulary allows `properties` / `additionalProperties`. That makes extras first-class and validated. The cost is that we own a forked library that has to track stock template changes, and Eraser-only consumers would reject our docs.
3. **Markdown links in labels** for `link`. Works today ("links in labels still work"), but it mixes data into text.

**Corpus round trip.** Five fixtures, vendored under `fixtures/eraser/` with Eraser's MIT LICENSE: canopy, erd-order-system, garden-plant-lookup, node-branching, bpmn-order-fulfillment.

- `mdpToIr → irToMdp` validates with 0 errors and keeps every element, every `containerId` and every connection endpoint.
- It is **lossy in style**, and badly:
  - multiple `texts` runs (title + grey subtitle) merge into one label
  - `bgColor` / `borderColor` / `fontSize` / `title.bgColor` are dropped
  - `Textbox`, `Activity` / `Event` / `Gateway` (BPMN), `Lane` / `Pool`, `Legend`, `Divider` collapse to `Shape` / `Group`, with `ext.mdpTag` kept
  - `fromPort` / `toPort`, `labelPlacement`, badges and line widths are lost

  The side-by-side screenshot (`canopy`, octo round trip) shows it: structure intact, design gone. With MDP as the source of truth this loss disappears.

## 4. In-browser render

The test page is `?engine=1`. `main.tsx` branches before any app start-up, so there is no sync and no persistence. `@octo-draw/engine/browser` provides `setupEraser` / `renderMdp` / `elementBoxes`. The pipeline:

1. octo DSL → `parseOctoPages` → `layoutDiagram` (ELK) → `irToMdp`
2. `resolver.resolve` with **our icon loader**: `resolveIcon` / `iconSvg` from core, the official AWS/GCP/Azure packs from `/api/icons` registered as lazy packs (the loader waits for the pack SVG), then the web app's full lucide set
3. `window.__eraser.setup(buildRenderPageSetup(library))` → `registerFonts` with **Inter variable** from `@fontsource-variable/inter@5.3.0` (OFL) as a `url` face for the clean and rough roles → `run()`
4. `#eraser-scene` moves into a host inside a `transform: translate() scale()` camera. Wheel zooms, drag pans.

- **Headless Chrome:** it works. Screenshots are below and in the scratchpad.
- **Positioned DOM:** yes. Each element is an absolutely positioned wrapper `div[data-mdp-id][data-mdp-tag]` in `#eraser-scene`, with a scene-wide SVG overlay for lines and a label layer. `elementBoxes()` reads `offsetLeft` / `offsetTop` / `offsetWidth` / `offsetHeight`, which are scene coordinates and unaffected by the camera transform. Clicks hit-test through the transform with `elementsFromPoint(...).closest('[data-mdp-id]')`. A selection box in the same transformed layer lines up exactly. Measured with CDP: camera panned to (-400, -60) at zoom 1.3, a real mouse click on `API` selected it, and the overlay's screen rect `[1508, 506, 65×65]` wrapped the element's `[1512, 509, 57×57]` with the intended 3 px padding × 1.3. Screenshot: `docs/v2-spike/shot-selection.png`.
- **Measurement is untransformed:** `run()` always mounts the scene on `document.body` (a singleton id), so it is measured untransformed, and we move it afterwards. Two renders in one page need sequencing; one live scene per page is the model.
- **Sanitiser:**
  - Eraser's allowlist sanitiser rejected our icons until we dropped the `data-icon` attribute. Any `data-*` attribute rejects the whole SVG.
  - It rejected 130 of 1751 official pack icons (`<style>` class palettes). Running `normalizeFetchedIcon` from `diagram-templates/svg-transforms` on pack icons fixes that: **1750 / 1751 pass**.

**Timings** (headless Chrome 156; `run` covers fill, measure, route and apply; `resolve` includes icon loading):

| source | entities / connections | ELK | resolve | run |
|---|---|---|---|---|
| flowchart | 6 / 6 | 81 ms | 31 ms | 31 ms |
| architecture | 16 / 14 | 94 ms | 34 ms | 88 ms |
| deep | 24 / 17 | 109 ms | 33 ms | 551 ms |
| corpus canopy (as is) | 13 / 10 | – | 36 ms | 65 ms |
| synthetic 50 | 58 / 64 | 136 ms | 30 ms | **7.7 s** |
| synthetic 200 | 234 / 257 | 175 ms | 33 ms | **1,725,751 ms (28.8 minutes)** |
| deep, pre-routed (`repair:false`) | 24 / 17 | 112 ms | 35 ms | **17 ms**; pre-route 31 ms; 17 / 17 routes adopted |
| synthetic 50, pre-routed | 58 / 64 | 134 ms | 29 ms | **21 ms**; pre-route 45 ms; 64 / 64 adopted |
| synthetic 200, pre-routed | 234 / 257 | 318 ms | 32 ms | **71 ms**; pre-route 288 ms; 257 / 257 adopted |

The cause is `REPAIR_TIME_BUDGET_MS = Number.POSITIVE_INFINITY`, hard-coded in `render/dist/browser/route.js`, and `repair: true` in `routeScene`. Neither can be configured through the public API: `./browser` exports only `cutLabelGap` / `clearLabelGap`, and the internals are not in the `exports` map. That leaves three workarounds:

- **Pre-route (measured).** Route in our worker with `repair:false` on the doc's own geometry (`layoutFromMdp` + `withRoutes`). `run()` adopts any authored orthogonal polyline that cuts no entity, without routing it.
  - All routes were adopted in every test, and 200 nodes went from 29 minutes to 71 ms.
  - The catch: once routes are adopted, the renderer no longer routes them, so label placement and endpoint fit against *measured* sizes are ours to get right. Where a measured box grew past our estimate, a route that now cuts it gets re-routed with the infinite budget again.
  - Measure-first layout (Risk 3) fixes that properly.
- **Patch.** A pnpm patch of one constant in `route.js` breaks the "pinned npm, not forked" rule. A small, upstreamable fix: expose `routeOptions` on `run()`.
- **Upstream.** Ask Eraser for a budget or `repair` option on `run()`.

**CSS the templates need:**

- `@scope (…) to (…)`, generated per template by `setup`: Chrome/Edge 118+, Safari 17.4+, Firefox 146+
- relative color syntax `hsl(from var(--er-color) …)` / `rgb(from …)` (33 uses): Chrome 119+, Safari 18+ (partial from 16.4), Firefox 128+
- `color-mix()` (13): Chrome 111+, Safari 16.2+, Firefox 113+
- `:has()` (10): Chrome 105+, Safari 15.4+, Firefox 121+
- CSS masks on SVG (label gaps)

So the floor is evergreen browsers from late 2024 or later, Firefox 146+ (Dec 2025) for `@scope`. Eraser's own note says Chromium skips SVG filters inside `<mask>` in iframes, which affects the watercolor style, so don't render in an iframe.

**Screenshots** (`docs/v2-spike/shot-*.png`; the page shows the corpus golden PNG side by side; `shot-synthetic_200_prerouted.png` is the 200-node pre-routed render):

- `shot-example_architecture.png`: octo example through ELK → MDP → Eraser render, brand colors from our catalog.
- `shot-corpus_canopy-direct.png`: the corpus doc as is. It matches the golden apart from icons (ours, not Eraser's bucket) and small route differences. Our Inter is the fontsource build, not Eraser's vendored file, so metrics differ slightly.
- `shot-corpus_canopy.png`: after the octo IR round trip, showing the style loss from §3.
- `shot-corpus_erd.png`: ERD round trip. Rows and relationships attach to the right fields, and crow's feet render.

## 5. Golden corpus

Covered in §3 and §4. Round trips are in `mdp.test.ts > eraser corpus` (5 fixtures). The visual check is `?engine=1&src=corpus:canopy`, `corpus:canopy-direct` and `corpus:erd` next to `*-darwin.png`.

## Risks

1. **Render performance.** `run()` uses an infinite repair budget: 7.7 s at 50 nodes and **29 minutes** at 200 nodes in headless Chrome. It blocks the main thread, so this is a hard blocker for using `run()` unmodified. Pre-routing removes it (71 ms at 200 nodes) as long as every route is adopted.
2. **Eraser's 0.x versions break without notice.** The protocol says "a change to the 0.x minor version may be breaking", and the packages are days old. Pin exact versions, keep the corpus round-trip tests as a canary, and upgrade on purpose.
3. **Placement mismatch.** ELK sizes come from our text estimate, but Eraser measures real DOM, so boxes grow after placement and can overlap. The fix is a measure-first pass: render once at x = y = 0, read `measures[].body`, feed the sizes to ELK, then render again. That is about 2× `run` cost, or a fill-and-measure-only path through `render/fill` plus our own mount.
4. **Router quality gaps:** more crossings than ELK, cuts through unrelated groups, slow and non-deterministic repair. ELK routes stay the better choice for the initial auto-layout. Eraser's router wins for incremental edits after drags.
5. **The singleton scene** (`#eraser-scene` on `document.body`, global `window.__eraser`) means one live render per document. Thumbnails and multi-page previews need an iframe or a serialised scene (`serialize()` + `buildHtmlDocument`).
6. **CSS floor:** `@scope` and relative colors exclude older Safari and Firefox.
7. **Sanitiser strictness:** our SVGs must be normalised (no `data-*`, no `<style>`). Done in `octoIconLoader`.
8. **Engines field:** Node ≥ 22.23.4 is required on paper.

## Recommended v2 architecture

**Document format.** The stored format is an `OctoDocument` envelope with pages:

```ts
{ format: 'octo-draw/mdp', version: 1, profile: { name: 'eraser-stock', version: '0.3.0' }, title,
  pages: [{ name: '', mdp: { entities, connections, octo: OctoSidecar } }, …] }
```

- **Source of truth:** MDP per page. The sidecar holds `drill` / `link` / `ext`, sequence data and page directives.
- **DSL:** compiles to MDP (DSL → IR → ELK → `irToMdp`). Positions live in MDP, so pins stop being separate view state.
- **Canvas edits** patch the MDP doc directly: move, restyle, reconnect, `labelPlacement`, ports. Text edits keep patching the DSL through `setNodeProp`, followed by a recompile that **merges** into MDP by id, keeping authored geometry and style for ids that survive. That merge is the main new piece of engineering.
- **IR:** a derived view for mermaid / ASCII import, agents, scan and the DSL printer.

**From Eraser:**

| piece | use? | how |
|---|---|---|
| protocol + resolve | yes | validation everywhere: web, server, MCP `set_diagram`, CLI. `createResolver({ library: stockLibrary, normalizers, iconLoader: octoIconLoader })`. Agents get JSON-pointer issues with did-you-mean. |
| diagram-templates | yes | stock look, palette, normalizers. Later, an octo library built with `mergeTemplates` / overrides for octo shapes (`cloud`) and colors. |
| layout (router) | yes, for incremental routing | `repair:false` in a worker on drag (touched edges plus edges hit by the moved box). Keep ELK routes for initial auto-layout. Optionally run a background repair. |
| render | yes, behind a flag until the budget is fixed | pre-route, or upstream a `run({ routing })` option. Our selection, drill and presence UI overlays the positioned DOM. |
| diagrams / diagrams-cli | no | they own Chromium and fetch icons from Eraser's bucket. Our server can use resolve plus our existing SVG export, or headless Chrome with the IIFE, when PNG parity is needed. |

**From octo:**

- **ELK placement**, including compound groups, layered crossing minimisation and the sequence / ERD layouts.
- **The DSL and its patching**, mermaid / ASCII / vision import, and the agent actions. These operate on the IR, then go through `irToMdp`.
- **Pages and drill-down:** the envelope pages plus sidecar `ext.drill`, and `collapseGroups` / `focusGroup` on the IR.
- **Sync:** today the text is synced through the text-op client. v2 syncs the document JSON. Either keep text ops on a canonical JSON serialisation (simple, conflict-prone) or move to per-element ops keyed by MDP id (better).
- **Connectors / scan:** unchanged; they emit DSL, which compiles to MDP.
- **Icons:** octo catalog plus the official packs through `octoIconLoader`. Never Eraser's GCS bucket.

**Phased plan:**

1. **Phase 0, done here:** the engine package, mappings, validation, router adapter, test page.
2. **Phase 1, format** (about 1–2 weeks):
   - `OctoDocument` as the persisted and exported format next to the DSL
   - server `GET/PUT /api/doc` carrying the envelope
   - MCP `validate_diagram` built on resolve
   - corpus and examples as CI canaries
3. **Phase 2, router** (about 1 week):
   - `routeEdges` in a worker for drags, with touched expansion and `repair:false`
   - bench gates: no node hits, no extra wall crossings
4. **Phase 3, renderer** (about 2 weeks, gated on the budget fix):
   - Eraser render as the canvas diagram layer, with measure-first ELK and our overlay UI on `data-mdp-id`
   - SVG export through `serialize()`
   - keep the current SVG renderer as a fallback and for sequence diagrams
5. **Phase 4, MDP-native editing:**
   - canvas edits patch MDP
   - DSL → MDP merge by id
   - per-element sync ops
   - richer styling (texts runs, `bgColor`, ports) surfaced in the DSL as new props
