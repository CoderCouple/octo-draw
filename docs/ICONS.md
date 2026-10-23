# Icons

octo-draw ships an icon catalog for architecture diagrams with Eraser-compatible names: `aws-*`, `gcp-*`, `azure-*`, and plain tech names (`kafka`, `postgres`, `react`, …). Aliases work too (`postgresql` → `postgres`, `k8s` → `kubernetes`).

```
Users [icon: users]
API [icon: aws-api-gateway]
Fn [icon: aws-lambda]
Events [icon: kafka]
DB [icon: postgres, color: brand]
```

## Rendering rules

- **Monochrome by default.** Every icon is drawn in the node's icon color, which is the theme foreground (or the node's `color:` tint). This matches the black and white UI.
- **`color: brand`** draws a brand logo in its official color and leaves the node surface neutral. If the brand color would be hard to read on the surface (for example, GitHub's near-black on a dark theme), the icon uses the foreground instead. Icons without a brand color (generic glyphs and vendor fallbacks) ignore `brand`.
- **Official cloud icons.** If you've downloaded the official AWS, Google Cloud and Azure packs (`pnpm icons:fetch --accept-terms`, see [below](#official-cloud-icons-aws-google-cloud-azure)), vendor names draw the vendor's icon in full color, as the vendor designed it, even in the monochrome theme. Grayscale is an option.
- **Badges.** Without a downloaded pack (fresh clones, CI), `aws-*`, `gcp-*` and `azure-*` services draw a generic glyph with a small text pill in the lower-right corner (`aws-ec2` → server glyph with `EC2`). So do brands we can't redistribute.
- **Unknown names** still render as the old text badge (the first 5 letters of the name in a rounded square).
- **Name matching ignores case**, and spaces, `_` and `.` count as `-`. So `AWS_EC2` and `Next.js` resolve.

## Sources and licenses

| Set | Version | License | Included? |
|---|---|---|---|
| [simple-icons](https://github.com/simple-icons/simple-icons) (brand logos) | 16.33.0 | [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md). Some logos carry their own license, see below. | Yes, a curated subset of about 135 logos |
| [lucide](https://github.com/lucide-icons/lucide) (generic glyphs) | 1.61.0 | [ISC](https://github.com/lucide-icons/lucide/blob/main/LICENSE) (the parts from Feather are MIT) | Yes, about 95 glyphs |
| [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) | 2026.07.31 (Q3 2026) | "We allow customers and partners to use these toolkits and assets to create architecture diagrams." No redistribution grant. | **No.** Each user downloads them with `pnpm icons:fetch`. Generic fallbacks otherwise. |
| [Azure architecture icons](https://learn.microsoft.com/en-us/azure/architecture/icons/) | V24 (July 2026) | "You can copy, distribute, and display the icons only for the permitted use [diagrams, training materials, documentation]… Microsoft reserves all other rights." Also forbids changing the icons. | **No.** Downloaded locally with `pnpm icons:fetch`. Generic fallbacks otherwise. |
| [Google Cloud icons](https://cloud.google.com/icons) | 2025 product icons + legacy set | "the Google Cloud product icons you need for your diagrams, technical documentation, and more". There is no license for redistributing them. | **No.** Downloaded locally with `pnpm icons:fetch`. Generic fallbacks otherwise (`gcp`, `google-cloud` use the simple-icons Google Cloud logo). |
| [tabler icons](https://github.com/tabler/tabler-icons) | n/a | MIT | Not needed. lucide already covers the generic glyphs. |

Per-logo licenses from simple-icons:

- **Licenses we accept:** CC0-1.0, MIT, Apache-2.0, BSD-2/3-Clause, ISC, CC-BY-3.0 and CC-BY-4.0. `scripts/build-icons.ts` enforces this list.
- **Logos we skip:** share-alike, non-commercial and custom licenses (currently Vue, PHP, Ruby, Rust, Jenkins and Keycloak). Those names fall back to a glyph with a badge.
- **Attribution:** [NOTICE](../NOTICE) lists the non-CC0 logos and their attribution.

Brand logos are still trademarks of their owners. Use them to refer to the product, not to imply endorsement. The [simple-icons disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md) applies.

## Official cloud icons (AWS, Google Cloud, Azure)

The vendors publish their architecture icons for people to use in diagrams. None of them lets an open-source repo redistribute the files:

- **AWS** ([icons page](https://aws.amazon.com/architecture/icons/)): "We allow customers and partners to use these toolkits and assets to create architecture diagrams." and "You can also put icons in materials like whitepapers, presentations, data sheets, and posters." Nothing grants redistribution or modification. The [AWS Site Terms](https://aws.amazon.com/terms/) say the site's content may not be "reproduced, duplicated, copied, sold, resold … or otherwise exploited for any commercial purpose" and that "AWS's trademarks and trade dress may not be used in connection with any product or service that is not AWS's".
- **Azure** ([icon terms](https://learn.microsoft.com/en-us/azure/architecture/icons/#icon-terms)): "Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation. You can copy, distribute, and display the icons only for the permitted use unless granted explicit permission by Microsoft. Microsoft reserves all other rights." Also: "Don't crop, flip, or rotate icons. Don't distort or change icon shape in any way."
- **Google Cloud** ([icon library](https://cloud.google.com/icons)): "Here you can find the Google Cloud product icons you need for your diagrams, technical documentation, and more." The page has no license; Google's general [terms](https://policies.google.com/terms) apply. Nothing grants redistribution or modification.

So octo-draw **never commits these icons**. Each user downloads them from the vendor into a cache outside the repo:

```sh
pnpm icons:fetch --accept-terms              # all three (or OCTO_ACCEPT_ICON_TERMS=1)
pnpm icons:fetch --accept-terms --vendor aws
pnpm icons:fetch --help                       # --dir, --latest, --force, --list, --json
```

[`packages/core/scripts/fetch-cloud-icons.ts`](../packages/core/scripts/fetch-cloud-icons.ts) does the following:

1. It prints the terms summary above and exits with code 2 unless you pass `--accept-terms`.
2. It downloads the pinned zips from the vendor URLs. `--latest` scrapes the AWS and Azure pages for a newer release.
3. It verifies each zip: HTTP status, size, zip magic and the pinned SHA-256. A re-published pack needs `--allow-hash-mismatch`.
4. It extracts every SVG and normalizes the names. It refuses to write inside the repo.
5. It writes the files to `~/.cache/octo-draw/icons/<vendor>/<version>/<name>.svg`, or under `$OCTO_ICONS_DIR` (or `$XDG_CACHE_HOME`) if set. The zips stay in `_downloads/`, so a re-run doesn't download again.
6. It writes `manifest.json` at the cache root.

| Vendor | Source files | Names |
|---|---|---|
| AWS | `Arch_Amazon-EC2_64.svg`, `Res_Amazon-EC2_Instance_48.svg`, `Arch-Category_Compute_64.svg`, `Virtual-private-cloud-VPC_32.svg` | `aws-ec2` (the `Amazon-`/`AWS-` prefix is dropped, and the long form `aws-amazon-ec2` is an alias), `aws-ec2-instance`, `aws-category-compute`, `aws-group-virtual-private-cloud-vpc`. The largest size wins. `_Dark` variants get a `-dark` suffix. |
| Google Cloud | `Unique Icons/Cloud Run/SVG/CloudRun-512-color-rgb.svg` (2025), `cloud_run/cloud_run.svg` (legacy), `Category Icons/Databases/…` | `gcp-cloud-run`, `gcp-category-databases`. A 2025 icon replaces the legacy one with the same name, and the old icon stays as `<name>-legacy`. `gcp-gke` replaces `gcp-google-kubernetes-engine`, which becomes an alias. |
| Azure | `10021-icon-service-Function-Apps.svg` | `azure-function-apps` (the `Azure-`/`Microsoft-` prefix is dropped, and the long form is an alias). |

Eraser-style names come from two sources. Every `aws-`/`gcp-`/`azure-` name and alias in the catalog is mapped to the matching pack icon, and a hand-written table in the script covers the rest (`aws-s3` → `aws-simple-storage-service`, `aws-sqs`, `aws-eks`, `azure-functions` → `azure-function-apps`, `gcp-pubsub`, …). The script reports any catalog name it couldn't map; those keep the badge fallback. Results on 2026-10-23: **AWS 857** icons (303 services, 513 resources, 26 categories, 15 groups), **Google Cloud 261** (235 products, 26 categories), **Azure 633**. All catalog vendor names are mapped except `azure-entra-id`, which has no service icon in V24.

### Manifest format

`~/.cache/octo-draw/icons/manifest.json` (`IconCacheManifest`):

```json
{ "schema": 1, "packs": { "aws": { "vendor": "aws", "version": "2026.07.31", "dir": "aws/2026.07.31",
  "icons": { "aws-ec2": { "label": "Amazon EC2", "file": "aws-ec2.svg", "kind": "service", "category": "Compute", "source": "Arch_Amazon-EC2_64.svg" } },
  "aliases": { "aws-s3": "aws-simple-storage-service", "aws-amazon-ec2": "aws-ec2" } } } }
```

### Runtime

- **Core** (platform-free): `registerIconPack(pack)` takes `{ vendor, version, icons, aliases, svg(name) }`, where `svg` returns the raw markup synchronously or `undefined` if the icon isn't loaded yet. While a pack is registered, `resolveIcon('aws-ec2')` returns `{ source: 'pack', svg, viewBox, paint: 'fill', monochrome: false, pack: { name, version } }`. The lookup accepts catalog names, catalog aliases (`ec2`, `lambda`), pack names and pack aliases. A name the pack doesn't have, or an SVG that hasn't loaded, falls back to the badge icon.
  - `svg` holds the sanitized child markup. Scripts, event handlers, external hrefs and titles are removed. Ids and CSS classes are prefixed per icon, so many icons can share one document; Google's icons all use `.cls-1`.
  - `iconSvg(icon, { grayscale: true })`, `iconInnerSvg(icon, color, bg, { grayscale })` and `renderDiagramSvg(…, { officialIcons: 'grayscale' })` desaturate the icon.
  - Other exports: `unregisterIconPack`, `clearIconPacks`, `listIconPacks`, `iconPackNames`, `onIconPacksChange(fn)`, `iconPackGeneration()`, `lazyIconPack(manifest, fetchSvg)` and `parseVendorSvg`. `searchIcons` also returns pack-only names.
- **Node glue:** `@octo-draw/core/node/iconCache` provides `defaultIconsDir()`, `readIconCacheManifest(dir)`, `iconPacksFromCache(dir)` (packs with fs-backed `svg()`) and `iconFilePath()`.
- **Server:** on startup, the server loads the manifest from the cache and registers the packs, so `/api/doc/svg` renders official icons. Add `?icons=grayscale` or set `OCTO_ICONS_GRAYSCALE=1` for grayscale. Routes:
  - `GET /api/icons/manifest` returns `{ schema: 1, packs: { aws: { vendor, version, label, terms, icons: { name: { label, kind, category } }, aliases } } }`. It returns `{ schema: 1, packs: {} }` if nothing was downloaded. It never includes file paths.
  - `GET /api/icons/:vendor/:name.svg` serves the cached file. It accepts aliases, sends `Cache-Control: public, max-age=86400` and a no-script CSP, and returns 404 if the file isn't there.
- **CLI:** `octo-draw render` reads the cache directly. It honors `OCTO_ICONS_DIR` and takes `--icons color|grayscale`.
- **Tests** never touch the network or the real cache. They use the fake pack in `packages/core/node/fixtures/icon-cache/`, which holds hand-written placeholder SVGs, not vendor files.

### Web app: loading official icons (for `apps/web`)

Load the icons lazily and cache them. The web bundle never contains them.

```ts
import { lazyIconPack, registerIconPack, onIconPacksChange, iconPackGeneration, type IconCacheManifest } from '@octo-draw/core'

// once, after the catalog loads (inside loadIcons()):
const res = await fetch('/api/icons/manifest')               // same origin via the vite proxy
const m = (await res.json()) as IconCacheManifest            // { packs: {} } when nothing was downloaded
for (const pack of Object.values(m.packs)) {
	if (!pack) continue
	registerIconPack(lazyIconPack(pack, async (name) => {
		const r = await fetch(`/api/icons/${pack.vendor}/${name}.svg`)   // browser HTTP cache: max-age=1 day
		if (!r.ok) throw new Error(String(r.status))
		return r.text()
	}))
}

// re-render when an icon arrives (the first resolveIcon call starts the fetch and returns the badge fallback):
const gen = useSyncExternalStore(onIconPacksChange, iconPackGeneration)  // include `gen` in memo deps
```

Rendering in React:

1. `const icon = resolveIcon(name)`. When `icon.svg !== undefined` it's an official icon. Render `<svg viewBox={icon.viewBox} width={size} height={size} overflow="visible" dangerouslySetInnerHTML={{ __html: icon.svg }} />`.
   - Don't apply the theme color, `iconPaint` or badges; it carries its own colors.
   - The markup is sanitized and id/class-scoped, so it's safe to inline next to other icons.
   - For a grayscale setting, add `style={{ filter: 'grayscale(1)' }}`, or use `iconInnerSvg(icon, '', '', { grayscale: true })`.
2. Otherwise render it as before (catalog glyph or brand logo with badge).
3. **Autocomplete:** add `iconPackNames()` to `ICON_ALL_NAMES`, or call `searchIcons`, which already includes pack names. Labels come from `listIconPacks()` or the manifest.
4. **Exports:** PNG/SVG export via `iconSvg(icon, { grayscale })` already inlines the official markup.
5. **No server or nothing downloaded:** the manifest has no packs, every name keeps the badge fallback, and nothing else changes.

## API (`@octo-draw/core`)

```ts
resolveIcon(name: string): ResolvedIcon | null
searchIcons(query: string, limit = 20): IconSearchHit[]   // { name, label, matched?, score }
ICON_NAMES: readonly string[]       // canonical names, sorted
ICON_ALL_NAMES: readonly string[]   // canonical names + aliases, sorted
iconSvg(icon, { size?, color?, brand?, background?, attrs? }): string   // standalone <svg>
iconColor(icon, foreground, { brand?, background? }): string
iconPaint(icon, color)              // wrapper attrs: fill or stroke styling
iconInnerSvg(icon, color, background?)  // child markup incl. badge pill
badgeBox(text)                      // badge geometry in 24×24 icon units

interface ResolvedIcon {
	name: string            // canonical (aliases resolve to it)
	label: string           // "PostgreSQL", "AWS EC2"
	viewBox: '0 0 24 24'
	nodes: [tag, attrs][]   // SVG children
	paint: 'fill' | 'stroke'  // brand logos are filled; lucide glyphs are 2px strokes
	monochrome: boolean     // true = has no brand color
	brandColor?: string     // '#4169E1'
	badge?: string          // 'EC2'
	vendor?: 'aws' | 'gcp' | 'azure'
	source: 'simple-icons' | 'lucide' | 'pack'
	svg?: string            // official pack icons: sanitized markup with its own colors
	pack?: { name: string; version: string }
}
```

`resolveIcon` tries these steps in order and stops at the first match:

1. A catalog name or alias. For vendor entries, the official pack icon is used when a pack is registered and has it.
2. A name or alias from a registered official pack (`aws-ec2-instance`, `azure-function-apps`).
3. Any vendored lucide glyph name.
4. The legacy `ICON_ALIASES` table.
5. For `aws-`/`gcp-`/`azure-` names, the name with the prefix stripped (`aws-cache` → `cache`).

`searchIcons` ranks results in this order:

1. Exact name.
2. Exact alias.
3. Exact label.
4. Name prefix, including vendor-prefixed queries like `aws lam`.
5. Alias prefix.
6. Label word prefixes, so `cloud run` finds `gcp-cloud-run`.
7. Substrings.
8. Tags, such as `queue` or `database`.

Ties go to the shorter name, then alphabetical order.

The headless renderer (`renderDiagramSvg`, `renderDocumentSvg`) uses `resolveIcon` by default:

- `icon: false` forces text badges.
- A custom `icon` resolver can return either a `ResolvedIcon` or a raw lucide-style node.
- The CLI tries the catalog first, then falls back to the full lucide set.

## Web integration (for `apps/web/src/lib/icons.ts`)

The web app currently maps names to lucide through its own alias table. To use the catalog:

1. **`getIcon(name)`.** Call `resolveIcon(name)` from `@octo-draw/core` first. If it returns non-null, render it. Otherwise fall back to the existing lucide lookup so every other lucide name keeps working.
2. **Rendering a `ResolvedIcon` in React.** Wrap it in `<svg viewBox={icon.viewBox} width={size} height={size} overflow="visible" {...paint}>`:
   - Get `paint` from `iconPaint(icon, color)`. It returns `fill` + `stroke: none` for brand logos, and `fill: none` + `stroke` + `stroke-width: 2` + round caps for glyphs. In JSX these are `strokeWidth`, `strokeLinecap` and `strokeLinejoin`.
   - Map `icon.nodes` to `createElement(tag, attrs)`.
   - If `icon.badge` is set, draw the pill from `badgeBox(icon.badge)`: a rect with fill = node surface and stroke = color, plus centered text, in the same 24×24 coordinates.
   - Alternatively, inject `iconInnerSvg(icon, color, surface)` with `dangerouslySetInnerHTML` inside that `<svg>`.
3. **Color.** `const color = iconColor(icon, themeIconColor, { brand: node.style?.color === 'brand', background: nodeSurface })`. A node with `color: brand` should keep the neutral surface. `resolveColor('brand')` is already undefined, so `nodeColors` handles this.
4. **Autocomplete.** Use `ICON_ALL_NAMES` for the static list, `searchIcons(prefix, 50)` for ranked suggestions, and `hit.label` as the completion detail.
5. **Bundle.** The catalog is about 210 KB raw and about 85 KB gzip, mostly brand paths. To keep it out of the main chunk, import it dynamically (`import('@octo-draw/core/src/icons')`) and reuse the existing `loadIcons()` / `useIcons` loaded flag.

## Adding icons

1. Edit `packages/core/src/icons/catalog.ts`:
   - Brand: `brand(name, simpleIconsSlug, label, fallbackGlyph, aliases, tags)`.
   - Vendor service: `aws(...)`, `gcp(...)` or `azure(...)`.
   - Generic concept: `generic(...)`.
2. Run `pnpm -F @octo-draw/core build:icons`. This rewrites `src/icons/data/*.ts` and the table below, and reports brands that fell back or carry non-CC0 licenses. Add any new non-CC0 license to NOTICE.
3. Run the core tests.

## Catalog

<!-- icons:start -->
_324 icons, generated by `pnpm -F @octo-draw/core build:icons` (simple-icons@16.33.0, lucide@1.61.0)._

| Name | Label | Aliases | Drawn from |
|---|---|---|---|
| `postgres` | PostgreSQL | `postgresql`, `pg`, `psql` | simple-icons `postgresql` |
| `mysql` | MySQL |  | simple-icons `mysql` |
| `mariadb` | MariaDB |  | simple-icons `mariadb` |
| `sqlite` | SQLite |  | simple-icons `sqlite` |
| `mongodb` | MongoDB | `mongo` | simple-icons `mongodb` |
| `redis` | Redis |  | simple-icons `redis` |
| `cassandra` | Apache Cassandra | `apache-cassandra` | simple-icons `apachecassandra` (Apache-2.0) |
| `couchbase` | Couchbase |  | simple-icons `couchbase` |
| `neo4j` | Neo4j |  | simple-icons `neo4j` |
| `elasticsearch` | Elasticsearch | `elastic-search` | simple-icons `elasticsearch` |
| `elastic` | Elastic |  | simple-icons `elastic` |
| `opensearch` | OpenSearch |  | simple-icons `opensearch` |
| `clickhouse` | ClickHouse |  | simple-icons `clickhouse` |
| `duckdb` | DuckDB |  | simple-icons `duckdb` |
| `snowflake` | Snowflake |  | simple-icons `snowflake` |
| `databricks` | Databricks |  | simple-icons `databricks` |
| `influxdb` | InfluxDB | `influx` | simple-icons `influxdb` |
| `timescale` | Timescale | `timescaledb` | simple-icons `timescale` |
| `cockroachdb` | CockroachDB | `cockroach` | simple-icons `cockroachlabs` |
| `planetscale` | PlanetScale |  | simple-icons `planetscale` |
| `supabase` | Supabase |  | simple-icons `supabase` |
| `firebase` | Firebase |  | simple-icons `firebase` |
| `neon` | Neon |  | simple-icons `neon` |
| `upstash` | Upstash |  | simple-icons `upstash` |
| `minio` | MinIO |  | simple-icons `minio` |
| `trino` | Trino | `presto` | simple-icons `trino` |
| `kafka` | Apache Kafka | `apache-kafka` | simple-icons `apachekafka` (Apache-2.0) |
| `rabbitmq` | RabbitMQ | `rabbit` | simple-icons `rabbitmq` |
| `pulsar` | Apache Pulsar | `apache-pulsar` | simple-icons `apachepulsar` (Apache-2.0) |
| `nats` | NATS |  | simple-icons `natsdotio` |
| `celery` | Celery |  | simple-icons `celery` |
| `spark` | Apache Spark | `apache-spark` | simple-icons `apachespark` (Apache-2.0) |
| `flink` | Apache Flink | `apache-flink` | simple-icons `apacheflink` (Apache-2.0) |
| `airflow` | Apache Airflow | `apache-airflow` | simple-icons `apacheairflow` (Apache-2.0) |
| `docker` | Docker |  | simple-icons `docker` |
| `kubernetes` | Kubernetes | `k8s`, `kube` | simple-icons `kubernetes` |
| `helm` | Helm |  | simple-icons `helm` |
| `istio` | Istio |  | simple-icons `istio` |
| `linkerd` | Linkerd |  | simple-icons `linkerd` |
| `envoy` | Envoy | `envoy-proxy` | simple-icons `envoyproxy` |
| `nginx` | NGINX |  | simple-icons `nginx` |
| `traefik` | Traefik |  | simple-icons `traefikproxy` |
| `caddy` | Caddy |  | simple-icons `caddy` |
| `apache` | Apache HTTP Server | `httpd` | simple-icons `apache` (Apache-2.0) |
| `kong` | Kong |  | simple-icons `kong` |
| `terraform` | Terraform |  | simple-icons `terraform` |
| `pulumi` | Pulumi |  | simple-icons `pulumi` |
| `ansible` | Ansible |  | simple-icons `ansible` |
| `vault` | HashiCorp Vault | `hashicorp-vault` | simple-icons `vault` |
| `consul` | Consul |  | simple-icons `consul` |
| `nomad` | Nomad |  | simple-icons `nomad` |
| `argo` | Argo | `argocd`, `argo-cd` | simple-icons `argo` |
| `linux` | Linux |  | simple-icons `linux` |
| `ubuntu` | Ubuntu |  | simple-icons `ubuntu` |
| `cloudflare` | Cloudflare |  | simple-icons `cloudflare` |
| `cloudflare-workers` | Cloudflare Workers |  | simple-icons `cloudflareworkers` |
| `vercel` | Vercel |  | simple-icons `vercel` |
| `netlify` | Netlify |  | simple-icons `netlify` |
| `digitalocean` | DigitalOcean | `digital-ocean` | simple-icons `digitalocean` |
| `flyio` | Fly.io | `fly` | simple-icons `flydotio` |
| `render` | Render |  | simple-icons `render` |
| `railway` | Railway |  | simple-icons `railway` |
| `gcp` | Google Cloud | `google-cloud`, `gcloud` | simple-icons `googlecloud` |
| `prometheus` | Prometheus |  | simple-icons `prometheus` |
| `grafana` | Grafana |  | simple-icons `grafana` |
| `datadog` | Datadog |  | simple-icons `datadog` |
| `sentry` | Sentry |  | simple-icons `sentry` |
| `new-relic` | New Relic | `newrelic` | simple-icons `newrelic` |
| `splunk` | Splunk |  | simple-icons `splunk` |
| `pagerduty` | PagerDuty |  | simple-icons `pagerduty` |
| `opentelemetry` | OpenTelemetry | `otel` | simple-icons `opentelemetry` (CC-BY-4.0) |
| `jaeger` | Jaeger |  | simple-icons `jaeger` |
| `github` | GitHub |  | simple-icons `github` |
| `github-actions` | GitHub Actions | `gha` | simple-icons `githubactions` |
| `gitlab` | GitLab |  | simple-icons `gitlab` |
| `bitbucket` | Bitbucket |  | simple-icons `bitbucket` |
| `jenkins` | Jenkins |  | lucide `workflow` + badge |
| `circleci` | CircleCI | `circle-ci` | simple-icons `circleci` |
| `jira` | Jira |  | simple-icons `jira` |
| `notion` | Notion |  | simple-icons `notion` |
| `figma` | Figma |  | simple-icons `figma` |
| `postman` | Postman |  | simple-icons `postman` |
| `swagger` | Swagger |  | simple-icons `swagger` |
| `openapi` | OpenAPI |  | simple-icons `openapiinitiative` |
| `graphql` | GraphQL |  | simple-icons `graphql` |
| `apollo` | Apollo GraphQL | `apollo-graphql` | simple-icons `apollographql` |
| `socketio` | Socket.IO | `socket-io`, `websocket`, `websockets`, `ws` | simple-icons `socketdotio` |
| `react` | React | `reactjs`, `react-native` | simple-icons `react` |
| `nextjs` | Next.js | `next`, `next-js` | simple-icons `nextdotjs` |
| `vue` | Vue.js | `vuejs` | lucide `app-window` + badge |
| `nuxt` | Nuxt | `nuxtjs` | simple-icons `nuxt` |
| `angular` | Angular |  | simple-icons `angular` (CC-BY-4.0) |
| `svelte` | Svelte | `sveltekit` | simple-icons `svelte` |
| `astro` | Astro |  | simple-icons `astro` |
| `tailwind` | Tailwind CSS | `tailwindcss` | simple-icons `tailwindcss` |
| `vite` | Vite |  | simple-icons `vite` |
| `electron` | Electron |  | simple-icons `electron` |
| `flutter` | Flutter |  | simple-icons `flutter` |
| `expo` | Expo |  | simple-icons `expo` |
| `android` | Android |  | simple-icons `android` (CC-BY-3.0) |
| `apple` | Apple | `ios`, `macos` | simple-icons `apple` |
| `nodejs` | Node.js | `node`, `node-js` | simple-icons `nodedotjs` |
| `deno` | Deno |  | simple-icons `deno` (MIT) |
| `bun` | Bun |  | simple-icons `bun` |
| `typescript` | TypeScript | `ts` | simple-icons `typescript` |
| `javascript` | JavaScript | `js` | simple-icons `javascript` (MIT) |
| `python` | Python | `py` | simple-icons `python` |
| `go` | Go | `golang` | simple-icons `go` |
| `rust` | Rust |  | lucide `file-code` + badge |
| `java` | Java | `openjdk`, `jvm` | simple-icons `openjdk` (BSD-3-Clause) |
| `kotlin` | Kotlin |  | simple-icons `kotlin` |
| `swift` | Swift |  | simple-icons `swift` |
| `php` | PHP |  | lucide `file-code` + badge |
| `ruby` | Ruby |  | lucide `gem` + badge |
| `rails` | Ruby on Rails | `ruby-on-rails` | simple-icons `rubyonrails` |
| `dotnet` | .NET | `csharp`, `c-sharp` | simple-icons `dotnet` (CC0-1.0) |
| `django` | Django |  | simple-icons `django` |
| `flask` | Flask |  | simple-icons `flask` |
| `fastapi` | FastAPI |  | simple-icons `fastapi` |
| `laravel` | Laravel |  | simple-icons `laravel` |
| `nestjs` | NestJS | `nest` | simple-icons `nestjs` |
| `express` | Express | `expressjs` | simple-icons `express` |
| `anthropic` | Anthropic |  | simple-icons `anthropic` |
| `claude` | Claude |  | simple-icons `claude` |
| `gemini` | Gemini | `google-gemini` | simple-icons `googlegemini` |
| `mistral` | Mistral AI | `mistral-ai` | simple-icons `mistralai` |
| `huggingface` | Hugging Face | `hugging-face`, `hf` | simple-icons `huggingface` |
| `ollama` | Ollama |  | simple-icons `ollama` |
| `langchain` | LangChain |  | simple-icons `langchain` |
| `pytorch` | PyTorch | `torch` | simple-icons `pytorch` |
| `tensorflow` | TensorFlow | `tf` | simple-icons `tensorflow` |
| `jupyter` | Jupyter | `notebook` | simple-icons `jupyter` |
| `mlflow` | MLflow |  | simple-icons `mlflow` |
| `stripe` | Stripe |  | simple-icons `stripe` |
| `paypal` | PayPal |  | simple-icons `paypal` |
| `shopify` | Shopify |  | simple-icons `shopify` |
| `auth0` | Auth0 |  | simple-icons `auth0` |
| `okta` | Okta |  | simple-icons `okta` |
| `keycloak` | Keycloak |  | lucide `key-round` + badge |
| `mailgun` | Mailgun |  | simple-icons `mailgun` |
| `discord` | Discord |  | simple-icons `discord` |
| `telegram` | Telegram |  | simple-icons `telegram` |
| `whatsapp` | WhatsApp |  | simple-icons `whatsapp` |
| `slack` | Slack |  | lucide `hash` + badge |
| `openai` | OpenAI | `chatgpt`, `gpt` | lucide `sparkles` + badge |
| `aws` | Amazon Web Services | `amazon-web-services`, `amazon` | lucide `cloud` + badge |
| `azure` | Microsoft Azure | `microsoft-azure` | lucide `cloud` + badge |
| `heroku` | Heroku |  | lucide `cloud` + badge |
| `twilio` | Twilio |  | lucide `phone` + badge |
| `sendgrid` | SendGrid |  | lucide `mail` + badge |
| `memcached` | Memcached | `memcache` | lucide `zap` + badge |
| `zookeeper` | Apache ZooKeeper |  | lucide `network` + badge |
| `grpc` | gRPC |  | lucide `arrow-left-right` + badge |
| `oracle` | Oracle Database |  | lucide `database` + badge |
| `sql-server` | SQL Server | `mssql` | lucide `database` + badge |
| `dbt` | dbt |  | lucide `workflow` + badge |
| `aws-ec2` | AWS EC2 | `ec2` | lucide `server` + badge |
| `aws-lambda` | AWS Lambda | `lambda` | lucide `square-function` + badge |
| `aws-s3` | AWS S3 | `s3` | lucide `archive` + badge |
| `aws-rds` | AWS RDS | `rds` | lucide `database` + badge |
| `aws-aurora` | AWS Aurora |  | lucide `database` + badge |
| `aws-dynamodb` | AWS DynamoDB | `dynamodb`, `dynamo` | lucide `database` + badge |
| `aws-elasticache` | AWS ElastiCache |  | lucide `database-zap` + badge |
| `aws-redshift` | AWS Redshift |  | lucide `warehouse` + badge |
| `aws-sqs` | AWS SQS | `sqs` | lucide `list-ordered` + badge |
| `aws-sns` | AWS SNS | `sns` | lucide `bell` + badge |
| `aws-eventbridge` | AWS EventBridge |  | lucide `zap` + badge |
| `aws-kinesis` | AWS Kinesis | `kinesis` | lucide `waves` + badge |
| `aws-msk` | AWS MSK |  | lucide `radio` + badge |
| `aws-step-functions` | AWS Step Functions |  | lucide `workflow` + badge |
| `aws-api-gateway` | AWS API Gateway |  | lucide `router` + badge |
| `aws-cloudfront` | AWS CloudFront | `cloudfront` | lucide `globe` + badge |
| `aws-route-53` | AWS Route 53 | `aws-route53`, `route53` | lucide `signpost` + badge |
| `aws-elb` | AWS Elastic Load Balancing | `aws-alb`, `aws-nlb`, `aws-elastic-load-balancing` | lucide `split` + badge |
| `aws-vpc` | AWS VPC |  | lucide `network` + badge |
| `aws-iam` | AWS IAM |  | lucide `shield-check` + badge |
| `aws-cognito` | AWS Cognito | `cognito` | lucide `key-round` + badge |
| `aws-kms` | AWS KMS |  | lucide `key` + badge |
| `aws-secrets-manager` | AWS Secrets Manager |  | lucide `lock` + badge |
| `aws-waf` | AWS WAF |  | lucide `shield` + badge |
| `aws-ecs` | AWS ECS |  | lucide `container` + badge |
| `aws-eks` | AWS EKS |  | lucide `ship-wheel` + badge |
| `aws-fargate` | AWS Fargate |  | lucide `container` + badge |
| `aws-ecr` | AWS ECR |  | lucide `package` + badge |
| `aws-efs` | AWS EFS |  | lucide `hard-drive` + badge |
| `aws-ebs` | AWS EBS |  | lucide `hard-drive` + badge |
| `aws-cloudwatch` | AWS CloudWatch | `cloudwatch` | lucide `activity` + badge |
| `aws-cloudtrail` | AWS CloudTrail |  | lucide `scroll-text` + badge |
| `aws-glue` | AWS Glue |  | lucide `workflow` + badge |
| `aws-athena` | AWS Athena |  | lucide `search-code` + badge |
| `aws-emr` | AWS EMR |  | lucide `cpu` + badge |
| `aws-sagemaker` | AWS SageMaker |  | lucide `brain` + badge |
| `aws-bedrock` | AWS Bedrock | `bedrock` | lucide `sparkles` + badge |
| `aws-amplify` | AWS Amplify |  | lucide `app-window` + badge |
| `aws-appsync` | AWS AppSync |  | lucide `share-2` + badge |
| `aws-batch` | AWS Batch |  | lucide `layers` + badge |
| `aws-ses` | AWS SES |  | lucide `mail` + badge |
| `aws-cloudformation` | AWS CloudFormation |  | lucide `blocks` + badge |
| `gcp-compute-engine` | Google Cloud Compute Engine | `gcp-gce`, `gcp-compute` | lucide `server` + badge |
| `gcp-cloud-run` | Google Cloud Cloud Run | `cloud-run` | lucide `container` + badge |
| `gcp-cloud-functions` | Google Cloud Cloud Functions | `gcp-functions` | lucide `square-function` + badge |
| `gcp-app-engine` | Google Cloud App Engine | `gcp-gae` | lucide `app-window` + badge |
| `gcp-gke` | Google Cloud Kubernetes Engine | `gcp-kubernetes-engine`, `gke` | lucide `ship-wheel` + badge |
| `gcp-cloud-storage` | Google Cloud Cloud Storage | `gcp-gcs`, `gcp-storage`, `gcs` | lucide `archive` + badge |
| `gcp-bigquery` | Google Cloud BigQuery | `bigquery` | lucide `warehouse` + badge |
| `gcp-pubsub` | Google Cloud Pub/Sub | `gcp-pub-sub` | lucide `radio` + badge |
| `gcp-cloud-sql` | Google Cloud Cloud SQL | `gcp-sql` | lucide `database` + badge |
| `gcp-spanner` | Google Cloud Spanner | `gcp-cloud-spanner` | lucide `database` + badge |
| `gcp-firestore` | Google Cloud Firestore | `firestore` | lucide `database` + badge |
| `gcp-bigtable` | Google Cloud Bigtable | `gcp-cloud-bigtable` | lucide `table` + badge |
| `gcp-memorystore` | Google Cloud Memorystore |  | lucide `database-zap` + badge |
| `gcp-load-balancing` | Google Cloud Cloud Load Balancing | `gcp-load-balancer`, `gcp-lb` | lucide `split` + badge |
| `gcp-cloud-cdn` | Google Cloud Cloud CDN | `gcp-cdn` | lucide `globe` + badge |
| `gcp-cloud-dns` | Google Cloud Cloud DNS | `gcp-dns` | lucide `signpost` + badge |
| `gcp-vpc` | Google Cloud VPC |  | lucide `network` + badge |
| `gcp-iam` | Google Cloud IAM |  | lucide `shield-check` + badge |
| `gcp-secret-manager` | Google Cloud Secret Manager |  | lucide `lock` + badge |
| `gcp-cloud-armor` | Google Cloud Cloud Armor |  | lucide `shield` + badge |
| `gcp-api-gateway` | Google Cloud API Gateway |  | lucide `router` + badge |
| `gcp-dataflow` | Google Cloud Dataflow |  | lucide `waves` + badge |
| `gcp-dataproc` | Google Cloud Dataproc |  | lucide `cpu` + badge |
| `gcp-composer` | Google Cloud Cloud Composer |  | lucide `workflow` + badge |
| `gcp-vertex-ai` | Google Cloud Vertex AI | `gcp-vertex`, `vertex-ai` | lucide `sparkles` + badge |
| `gcp-cloud-logging` | Google Cloud Cloud Logging | `gcp-logging` | lucide `scroll-text` + badge |
| `gcp-cloud-monitoring` | Google Cloud Cloud Monitoring | `gcp-monitoring` | lucide `activity` + badge |
| `gcp-artifact-registry` | Google Cloud Artifact Registry |  | lucide `package` + badge |
| `gcp-cloud-build` | Google Cloud Cloud Build |  | lucide `hammer` + badge |
| `gcp-cloud-scheduler` | Google Cloud Cloud Scheduler |  | lucide `calendar-clock` + badge |
| `gcp-cloud-tasks` | Google Cloud Cloud Tasks |  | lucide `list-checks` + badge |
| `azure-functions` | Azure Functions | `azure-function-apps`, `azure-function` | lucide `square-function` + badge |
| `azure-virtual-machines` | Azure Virtual Machines | `azure-vm` | lucide `server` + badge |
| `azure-app-service` | Azure App Service | `azure-app-services`, `azure-web-app` | lucide `app-window` + badge |
| `azure-aks` | Azure Kubernetes Service | `azure-kubernetes-service`, `aks` | lucide `ship-wheel` + badge |
| `azure-container-apps` | Azure Container Apps |  | lucide `container` + badge |
| `azure-container-instances` | Azure Container Instances |  | lucide `container` + badge |
| `azure-container-registry` | Azure Container Registry |  | lucide `package` + badge |
| `azure-blob-storage` | Azure Blob Storage | `azure-blob` | lucide `archive` + badge |
| `azure-storage-accounts` | Azure Storage Accounts | `azure-storage` | lucide `hard-drive` + badge |
| `azure-sql-database` | Azure SQL Database | `azure-sql` | lucide `database` + badge |
| `azure-cosmos-db` | Azure Cosmos DB | `azure-cosmosdb`, `cosmosdb` | lucide `orbit` + badge |
| `azure-cache-redis` | Azure Cache for Redis | `azure-redis`, `azure-cache-for-redis` | lucide `database-zap` + badge |
| `azure-service-bus` | Azure Service Bus | `azure-servicebus` | lucide `list-ordered` + badge |
| `azure-event-hubs` | Azure Event Hubs | `azure-eventhubs` | lucide `radio` + badge |
| `azure-event-grid` | Azure Event Grid | `azure-eventgrid` | lucide `zap` + badge |
| `azure-api-management` | Azure API Management | `azure-apim` | lucide `router` + badge |
| `azure-front-door` | Azure Front Door |  | lucide `door-open` + badge |
| `azure-cdn` | Azure CDN |  | lucide `globe` + badge |
| `azure-dns` | Azure DNS |  | lucide `signpost` + badge |
| `azure-virtual-network` | Azure Virtual Network | `azure-vnet` | lucide `network` + badge |
| `azure-load-balancer` | Azure Load Balancer | `azure-lb` | lucide `split` + badge |
| `azure-application-gateway` | Azure Application Gateway | `azure-app-gateway` | lucide `router` + badge |
| `azure-key-vault` | Azure Key Vault | `azure-keyvault` | lucide `key-round` + badge |
| `azure-entra-id` | Azure Entra ID | `azure-active-directory`, `azure-ad`, `entra-id` | lucide `shield-check` + badge |
| `azure-monitor` | Azure Monitor |  | lucide `activity` + badge |
| `azure-log-analytics` | Azure Log Analytics |  | lucide `scroll-text` + badge |
| `azure-openai` | Azure OpenAI Service | `azure-open-ai` | lucide `sparkles` + badge |
| `azure-machine-learning` | Azure Machine Learning | `azure-ml` | lucide `brain` + badge |
| `azure-data-factory` | Azure Data Factory | `azure-adf` | lucide `workflow` + badge |
| `azure-synapse` | Azure Synapse Analytics | `azure-synapse-analytics` | lucide `warehouse` + badge |
| `azure-databricks` | Azure Databricks |  | lucide `layers` + badge |
| `azure-logic-apps` | Azure Logic Apps |  | lucide `workflow` + badge |
| `azure-static-web-apps` | Azure Static Web Apps |  | lucide `globe` + badge |
| `azure-devops` | Azure DevOps | `azure-pipelines` | lucide `infinity` + badge |
| `database` | Database | `db`, `sql`, `rdbms` | lucide `database` |
| `server` | Server | `backend`, `vm`, `host` | lucide `server` |
| `cache` | Cache |  | lucide `zap` |
| `queue` | Queue | `mq`, `message-queue` | lucide `list-ordered` |
| `pubsub` | Pub/Sub | `pub-sub`, `topic`, `broker` | lucide `radio` |
| `stream` | Stream | `streaming` | lucide `waves` |
| `event` | Event | `events` | lucide `zap` |
| `user` | User | `person`, `customer`, `actor` | lucide `user` |
| `users` | Users | `people`, `team`, `clients` | lucide `users` |
| `api` | API | `rest`, `endpoint` | lucide `webhook` |
| `api-gateway` | API gateway | `gateway` | lucide `router` |
| `load-balancer` | Load balancer | `lb`, `balancer` | lucide `split` |
| `function` | Function | `serverless`, `faas` | lucide `square-function` |
| `storage` | Storage | `disk`, `volume` | lucide `hard-drive` |
| `bucket` | Bucket | `object-storage`, `blob` | lucide `archive` |
| `cdn` | CDN | `edge` | lucide `globe` |
| `browser` | Browser | `web`, `internet`, `www` | lucide `globe` |
| `mobile` | Mobile | `phone`, `mobile-app` | lucide `smartphone` |
| `desktop` | Desktop | `frontend`, `client` | lucide `monitor` |
| `email` | Email | `mail`, `smtp` | lucide `mail` |
| `auth` | Auth | `authentication`, `login`, `identity`, `sso` | lucide `key-round` |
| `security` | Security | `firewall`, `waf` | lucide `shield` |
| `lock` | Lock | `secret`, `secrets`, `encryption` | lucide `lock` |
| `monitoring` | Monitoring | `monitor`, `observability`, `health` | lucide `activity` |
| `metrics` | Metrics | `chart`, `dashboard` | lucide `chart-column` |
| `logs` | Logs | `logging`, `log`, `audit` | lucide `scroll-text` |
| `container` | Container | `pod` | lucide `container` |
| `cluster` | Cluster | `nodes` | lucide `boxes` |
| `cpu` | Worker | `worker`, `compute`, `job`, `processor` | lucide `cpu` |
| `ai` | AI | `genai` | lucide `sparkles` |
| `llm` | LLM | `ml`, `model`, `machine-learning` | lucide `brain` |
| `agent` | Agent | `bot`, `assistant` | lucide `bot` |
| `payment` | Payment | `payments`, `billing`, `checkout` | lucide `credit-card` |
| `app` | App | `application`, `webapp`, `spa` | lucide `app-window` |
| `service` | Service | `microservice`, `module` | lucide `box` |
| `network` | Network | `vpc`, `subnet`, `lan` | lucide `network` |
| `dns` | DNS | `domain` | lucide `signpost` |
| `router` | Router | `switch` | lucide `router` |
| `git` | Git | `repo`, `repository`, `scm` | lucide `git-branch` |
| `ci` | CI/CD | `cd`, `pipeline`, `ci-cd` | lucide `workflow` |
| `notification` | Notification | `notifications`, `alert`, `push` | lucide `bell` |
| `settings` | Settings | `config`, `configuration` | lucide `settings` |
| `cart` | Cart | `shop`, `store`, `ecommerce` | lucide `shopping-cart` |
| `building` | Building | `company`, `office`, `datacenter`, `on-prem` | lucide `building-2` |
| `chat` | Chat | `message`, `messages` | lucide `message-square` |
| `search` | Search | `index` | lucide `search` |
| `file` | File | `files` | lucide `file` |
| `document` | Document | `docs`, `doc`, `pdf` | lucide `file-text` |
| `cloud` | Cloud |  | lucide `cloud` |
| `scheduler` | Scheduler | `cron`, `schedule`, `timer` | lucide `calendar-clock` |
| `webhook` | Webhook | `callback` | lucide `webhook` |
| `warehouse` | Data warehouse | `data-warehouse`, `dwh`, `lake`, `data-lake` | lucide `warehouse` |
| `etl` | ETL | `pipeline-data`, `elt` | lucide `workflow` |
| `key` | Key | `api-key`, `token` | lucide `key` |
| `globe` | Globe | `world`, `region`, `public` | lucide `globe` |
| `terminal` | Terminal | `cli`, `shell`, `console` | lucide `terminal` |
| `code` | Code | `source`, `sdk`, `library` | lucide `code` |
| `package` | Package | `artifact`, `registry`, `npm` | lucide `package` |
| `layers` | Layers | `stack`, `tier` | lucide `layers` |
| `iot` | IoT device | `device`, `sensor`, `edge-device` | lucide `cpu` |
| `analytics` | Analytics | `bi`, `report`, `reports` | lucide `chart-pie` |
<!-- icons:end -->
