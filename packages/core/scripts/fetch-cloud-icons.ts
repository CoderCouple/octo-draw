/**
 * Downloads the official AWS, Google Cloud and Azure architecture icon packs
 * into a local cache OUTSIDE the repo and writes a manifest that maps
 * Eraser-style names (`aws-ec2`, `gcp-cloud-run`, `azure-function-apps`, …) to
 * the extracted SVGs. The server, the CLI and the headless renderer load that
 * manifest at startup (docs/ICONS.md).
 *
 * Why not vendor them? None of the three vendors grants a license to
 * redistribute their icon files in an open-source repository (see TERMS
 * below), so octo-draw never commits them. Each user downloads them from the
 * vendor for their own diagramming use.
 *
 *   pnpm icons:fetch --accept-terms                 # all vendors
 *   pnpm icons:fetch --accept-terms --vendor aws    # one vendor
 *   OCTO_ACCEPT_ICON_TERMS=1 pnpm icons:fetch
 *
 * Options:
 *   --accept-terms          accept the vendor terms printed below (or OCTO_ACCEPT_ICON_TERMS=1)
 *   --vendor aws,gcp,azure  vendors to fetch (default: all)
 *   --dir <path>            cache root (default: $OCTO_ICONS_DIR or ~/.cache/octo-draw/icons)
 *   --latest                scrape the vendor pages for the newest release instead of the pinned one
 *   --force                 re-download even if the zip is cached
 *   --allow-hash-mismatch   accept a zip whose SHA-256 differs from the pinned one (vendor re-published it)
 *   --list                  print every mapped name
 *   --json                  print a JSON summary
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { CATALOG } from '../src/icons/catalog.ts'
import { defaultIconsDir, manifestPath, readIconCacheManifest } from '../node/iconCache.ts'
import type { IconCacheManifest, IconPackIcon, IconPackKind, IconPackManifest, IconVendor } from '../src/icons/packs.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

// ---------------------------------------------------------------------------
// Sources and terms

interface Source {
	id: string
	url: string
	sha256?: string
}

interface VendorSpec {
	vendor: IconVendor
	label: string
	version: string
	page: string
	terms: string
	summary: string[]
	sources: Source[]
	/** Find the newest release on the vendor page (--latest). */
	latest?: (html: string) => { version: string; sources: Source[] } | null
}

const VENDORS: VendorSpec[] = [
	{
		vendor: 'aws',
		label: 'AWS Architecture Icons',
		version: '2026.07.31',
		page: 'https://aws.amazon.com/architecture/icons/',
		terms: 'https://aws.amazon.com/architecture/icons/ and https://aws.amazon.com/terms/',
		summary: [
			'"We allow customers and partners to use these toolkits and assets to create architecture diagrams."',
			'"You can also put icons in materials like whitepapers, presentations, data sheets, and posters."',
			'AWS Site Terms: "AWS\'s trademarks and trade dress may not be used in connection with any product or service that is not AWS\'s".',
			'No license to redistribute the icon files. Use them only in your own diagrams.',
		],
		sources: [
			{
				id: 'icon-package',
				url: 'https://d1.awsstatic.com/onedam/marketing-channels/website/public/shared/architecture-icon-release/Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip',
				sha256: 'd2d166c453526471749d520e0db022c459abef759d2946cf2dd1d1c992dc6526',
			},
		],
		latest(html) {
			const m = /https:\/\/d1\.awsstatic\.com\/[^"'\s]*?Icon-package_(\d{2})(\d{2})(\d{4})[^"'\s]*?\.zip/.exec(html)
			return m ? { version: `${m[3]}.${m[1]}.${m[2]}`, sources: [{ id: 'icon-package', url: m[0] }] } : null
		},
	},
	{
		vendor: 'gcp',
		label: 'Google Cloud icons',
		version: '2025.1',
		page: 'https://cloud.google.com/icons',
		terms: 'https://cloud.google.com/icons and https://policies.google.com/terms',
		summary: [
			'"Here you can find the Google Cloud product icons you need for your diagrams, technical documentation, and more."',
			'The page grants no license for redistributing or modifying the icons; Google\'s general terms and brand rules apply.',
			'Use them only in your own diagrams and documentation.',
		],
		sources: [
			{ id: 'core-products', url: 'https://services.google.com/fh/files/misc/core-products-icons.zip', sha256: '6531a10f58bc599c24d9a455d81dd757c1a03c3c43da9cddf639b859c1c1eece' },
			{ id: 'categories', url: 'https://services.google.com/fh/files/misc/category-icons.zip', sha256: 'e5bc3abd3527dc2500e9bff7f15870783e2c764129c49b7cd4c1b4e105345002' },
			{ id: 'legacy', url: 'https://services.google.com/fh/files/misc/google-cloud-legacy-icons.zip', sha256: 'a6d9d7921758042538b462f03cf64614c2cebd96743b3ed63580a769fc7de3e9' },
		],
	},
	{
		vendor: 'azure',
		label: 'Azure architecture icons',
		version: 'v24',
		page: 'https://learn.microsoft.com/en-us/azure/architecture/icons/',
		terms: 'https://learn.microsoft.com/en-us/azure/architecture/icons/#icon-terms',
		summary: [
			'"Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation."',
			'"You can copy, distribute, and display the icons only for the permitted use unless granted explicit permission by Microsoft. Microsoft reserves all other rights."',
			'"Don\'t crop, flip, or rotate icons." "Don\'t distort or change icon shape in any way."',
		],
		sources: [{ id: 'service-icons', url: 'https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V24.zip', sha256: '921594ccd1bf3d9c0a1bd7b6d924e050551a59342f2b353bb74bdcf761c35141' }],
		latest(html) {
			const m = /https:\/\/arch-center\.azureedge\.net\/icons\/Azure_Public_Service_Icons_V(\d+)\.zip/.exec(html)
			return m ? { version: `v${m[1]}`, sources: [{ id: 'service-icons', url: m[0] }] } : null
		},
	},
]

// ---------------------------------------------------------------------------
// Eraser-style aliases that don't follow from the vendor file names.
// key: catalog / Eraser name, value: canonical pack name

const MANUAL: Record<IconVendor, Record<string, string>> = {
	aws: {
		'aws-s3': 'aws-simple-storage-service',
		'aws-sqs': 'aws-simple-queue-service',
		'aws-sns': 'aws-simple-notification-service',
		'aws-ses': 'aws-simple-email-service',
		'aws-elb': 'aws-elastic-load-balancing',
		'aws-alb': 'aws-elastic-load-balancing-application-load-balancer',
		'aws-nlb': 'aws-elastic-load-balancing-network-load-balancer',
		'aws-ecs': 'aws-elastic-container-service',
		'aws-eks': 'aws-elastic-kubernetes-service',
		'aws-ecr': 'aws-elastic-container-registry',
		'aws-ebs': 'aws-elastic-block-store',
		'aws-efs': 'aws-efs',
		'aws-iam': 'aws-identity-and-access-management',
		'aws-kms': 'aws-key-management-service',
		'aws-msk': 'aws-managed-streaming-for-apache-kafka',
		'aws-vpc': 'aws-virtual-private-cloud',
		'aws-sagemaker': 'aws-sagemaker-ai',
		'aws-opensearch': 'aws-opensearch-service',
		'aws-elasticsearch': 'aws-opensearch-service',
		'aws-sfn': 'aws-step-functions',
		'aws-cdk': 'aws-cloud-development-kit',
		'aws-cli': 'aws-command-line-interface',
		'aws-acm': 'aws-certificate-manager',
		'aws-ssm': 'aws-systems-manager',
		'aws-dms': 'aws-database-migration-service',
		'aws-mq': 'aws-mq',
		'aws-elastic-beanstalk': 'aws-elastic-beanstalk',
		'aws-beanstalk': 'aws-elastic-beanstalk',
		'aws-xray': 'aws-x-ray',
		'aws-guardduty': 'aws-guardduty',
		'aws-users': 'aws-users',
		'aws-user': 'aws-user',
	},
	gcp: {
		'gcp-gke': 'gcp-gke',
		'gcp-kubernetes-engine': 'gcp-gke',
		'gcp-load-balancing': 'gcp-cloud-load-balancing',
		'gcp-spanner': 'gcp-cloud-spanner',
		'gcp-composer': 'gcp-cloud-composer',
		'gcp-iam': 'gcp-identity-and-access-management',
		'gcp-vpc': 'gcp-virtual-private-cloud',
		'gcp-api-gateway': 'gcp-cloud-api-gateway',
		'gcp-gce': 'gcp-compute-engine',
		'gcp-gcs': 'gcp-cloud-storage',
		'gcp-gcf': 'gcp-cloud-functions',
		'gcp-functions': 'gcp-cloud-functions',
		'gcp-gae': 'gcp-app-engine',
		'gcp-pub-sub': 'gcp-pubsub',
		'gcp-kms': 'gcp-key-management-service',
		'gcp-firewall': 'gcp-cloud-firewall-rules',
		'gcp-nat': 'gcp-cloud-nat',
		'gcp-vpn': 'gcp-cloud-vpn',
		'gcp-run': 'gcp-cloud-run',
		'gcp-sql': 'gcp-cloud-sql',
		'gcp-storage': 'gcp-cloud-storage',
		'gcp-bigtable': 'gcp-bigtable',
		'gcp-cloud-bigtable': 'gcp-bigtable',
		'gcp-gpu': 'gcp-cloud-gpu',
		'gcp-tpu': 'gcp-cloud-tpu',
		'gcp-logging': 'gcp-cloud-logging',
		'gcp-monitoring': 'gcp-cloud-monitoring',
		'gcp-vertex': 'gcp-vertex-ai',
		'gcp-gemini': 'gcp-vertex-ai',
	},
	azure: {
		'azure-functions': 'azure-function-apps',
		'azure-function': 'azure-function-apps',
		'azure-virtual-machines': 'azure-virtual-machine',
		'azure-vm': 'azure-virtual-machine',
		'azure-aks': 'azure-kubernetes-services',
		'azure-kubernetes-service': 'azure-kubernetes-services',
		'azure-app-service': 'azure-app-services',
		'azure-web-app': 'azure-app-services',
		'azure-blob-storage': 'azure-storage-accounts',
		'azure-blob': 'azure-storage-accounts',
		'azure-storage': 'azure-storage-accounts',
		'azure-cache-redis': 'azure-cache-redis',
		'azure-redis': 'azure-cache-redis',
		'azure-cosmosdb': 'azure-cosmos-db',
		'azure-sql': 'azure-sql-database',
		'azure-servicebus': 'azure-service-bus',
		'azure-event-hubs': 'azure-event-hubs',
		'azure-eventhubs': 'azure-event-hubs',
		'azure-event-grid': 'azure-event-grid-topics',
		'azure-eventgrid': 'azure-event-grid-topics',
		'azure-apim': 'azure-api-management-services',
		'azure-api-management': 'azure-api-management-services',
		'azure-front-door': 'azure-front-door-and-cdn-profiles',
		'azure-cdn': 'azure-front-door-and-cdn-profiles',
		'azure-dns': 'azure-dns-zones',
		'azure-vnet': 'azure-virtual-networks',
		'azure-virtual-network': 'azure-virtual-networks',
		'azure-lb': 'azure-load-balancers',
		'azure-load-balancer': 'azure-load-balancers',
		'azure-application-gateway': 'azure-application-gateways',
		'azure-app-gateway': 'azure-application-gateways',
		'azure-key-vault': 'azure-key-vaults',
		'azure-keyvault': 'azure-key-vaults',
		'azure-log-analytics': 'azure-log-analytics-workspaces',
		'azure-openai': 'azure-openai',
		'azure-open-ai': 'azure-openai',
		'azure-ml': 'azure-machine-learning',
		'azure-adf': 'azure-data-factories',
		'azure-data-factory': 'azure-data-factories',
		'azure-synapse': 'azure-synapse-analytics',
		'azure-databricks': 'azure-databricks',
		'azure-static-web-apps': 'azure-static-apps',
		'azure-devops': 'azure-devops',
		'azure-pipelines': 'azure-devops',
		'azure-container-registry': 'azure-container-registries',
		'azure-acr': 'azure-container-registries',
		'azure-aci': 'azure-container-instances',
		'azure-aca': 'azure-container-apps-environments',
		'azure-container-apps': 'azure-container-apps-environments',
		'azure-vm-scale-sets': 'azure-vm-scale-sets',
		'azure-monitor': 'azure-monitor',
		'azure-firewall': 'azure-firewalls',
		'azure-nsg': 'azure-network-security-groups',
	},
}

// ---------------------------------------------------------------------------
// CLI

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string) => {
	const i = argv.indexOf(`--${name}`)
	if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
	const eq = argv.find((a) => a.startsWith(`--${name}=`))
	return eq?.slice(name.length + 3)
}

if (flag('help') || flag('h')) {
	console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''))
	process.exit(0)
}

const dir = resolve(opt('dir') ?? defaultIconsDir())
const wanted = (opt('vendor') ?? 'aws,gcp,azure').split(',').map((s) => s.trim()) as IconVendor[]
const accepted = flag('accept-terms') || process.env.OCTO_ACCEPT_ICON_TERMS === '1'
const json = flag('json')
const log = (...a: unknown[]) => {
	if (!json) console.log(...a)
}

for (const v of wanted) if (!VENDORS.some((s) => s.vendor === v)) fail(`unknown vendor "${v}" (use aws, gcp, azure)`)
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + sep)
if (inside(dir, repoRoot) && !flag('allow-in-repo')) fail(`refusing to write vendor icons inside the repo (${dir}). The vendors' terms don't allow redistributing them; use a directory outside ${repoRoot}.`)

const specs = VENDORS.filter((s) => wanted.includes(s.vendor))
log('Official cloud icon packs: terms of use\n')
for (const s of specs) {
	log(`  ${s.label}  (${s.terms})`)
	for (const line of s.summary) log(`    - ${line}`)
	log('')
}
log(`  octo-draw does not redistribute these files. They are downloaded from the vendor to\n  ${dir}\n  for your own use under the terms above. Trademarks belong to their owners.\n`)
if (!accepted) fail('Re-run with --accept-terms (or OCTO_ACCEPT_ICON_TERMS=1) to accept these terms and download.', 2)

function fail(msg: string, code = 1): never {
	console.error(`icons:fetch: ${msg}`)
	process.exit(code)
}

// ---------------------------------------------------------------------------
// Download + verify

async function download(vendor: IconVendor, src: Source, version: string): Promise<{ data: Buffer; sha256: string; bytes: number; cached: boolean }> {
	const file = join(dir, '_downloads', vendor, version, `${src.id}.zip`)
	let data: Buffer | null = null
	let cached = false
	if (!flag('force') && existsSync(file)) {
		data = readFileSync(file)
		cached = true
	} else {
		log(`  downloading ${src.url}`)
		const res = await fetch(src.url, { redirect: 'follow', headers: { 'User-Agent': 'octo-draw icons:fetch' } })
		if (!res.ok) throw new Error(`${src.url}: HTTP ${res.status}`)
		data = Buffer.from(await res.arrayBuffer())
	}
	if (data.length < 10_000 || data.length > 300_000_000) throw new Error(`${src.url}: unexpected size ${data.length} bytes`)
	if (data.readUInt32LE(0) !== 0x04034b50) throw new Error(`${src.url}: not a zip file`)
	const sha256 = createHash('sha256').update(data).digest('hex')
	if (src.sha256 && sha256 !== src.sha256) {
		const msg = `${src.url}: SHA-256 ${sha256} does not match the pinned ${src.sha256}`
		if (!flag('allow-hash-mismatch')) throw new Error(`${msg}. The vendor may have re-published the pack; re-run with --allow-hash-mismatch to accept it.`)
		log(`  warning: ${msg} (accepted)`)
	}
	if (!cached) {
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, data)
	}
	return { data, sha256, bytes: data.length, cached }
}

// Minimal zip reader (store + deflate), enough for the vendor packs.
function* unzip(buf: Buffer): Generator<{ path: string; data: () => Buffer }> {
	let eocd = -1
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new Error('zip: end of central directory not found')
	const count = buf.readUInt16LE(eocd + 10)
	let p = buf.readUInt32LE(eocd + 16)
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry')
		const flags = buf.readUInt16LE(p + 8)
		const method = buf.readUInt16LE(p + 10)
		const compSize = buf.readUInt32LE(p + 20)
		const size = buf.readUInt32LE(p + 24)
		const nameLen = buf.readUInt16LE(p + 28)
		const extraLen = buf.readUInt16LE(p + 30)
		const commentLen = buf.readUInt16LE(p + 32)
		const local = buf.readUInt32LE(p + 42)
		const path = buf.toString('utf8', p + 46, p + 46 + nameLen)
		p += 46 + nameLen + extraLen + commentLen
		if (flags & 1 || path.endsWith('/')) continue
		yield {
			path,
			data: () => {
				if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip: bad local header for ${path}`)
				const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
				const raw = buf.subarray(start, start + compSize)
				const out = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null
				if (!out) throw new Error(`zip: unsupported compression ${method} for ${path}`)
				if (out.length !== size) throw new Error(`zip: size mismatch for ${path}`)
				return out
			},
		}
	}
}

// ---------------------------------------------------------------------------
// Name mapping

interface Candidate {
	name: string
	label: string
	kind: IconPackKind
	category?: string
	source: string
	/** Higher wins when two files map to the same name (bigger sizes, newer sets). */
	rank: number
	aliases: string[]
	data: () => Buffer
}

const slug = (s: string) =>
	s
		.replace(/&/g, ' and ')
		.replace(/\+/g, ' plus ')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
const words = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
const isJunk = (path: string) => path.includes('__MACOSX/') || basename(path).startsWith('._') || basename(path).startsWith('.')

function mapAws(entries: { path: string; data: () => Buffer }[]): Candidate[] {
	const out: Candidate[] = []
	const strip = (s: string) => s.replace(/^(Amazon|AWS)-/, '')
	for (const e of entries) {
		const file = basename(e.path)
		const parts = e.path.split('/')
		let m: RegExpExecArray | null
		if (parts[0].startsWith('Architecture-Service-Icons') && (m = /^Arch_(.+?)(?:_(Light|Dark))?_(16|32|48|64)(?:_(Light|Dark))?\.svg$/.exec(file))) {
			const raw = m[1]
			const dark = (m[2] ?? m[4]) === 'Dark'
			const base = `aws-${slug(strip(raw))}`
			const full = `aws-${slug(raw)}`
			const cat = parts.find((x) => x.startsWith('Arch_'))?.slice(5)
			out.push({ name: dark ? `${base}-dark` : base, label: words(raw), kind: 'service', category: cat && words(cat), source: file, rank: 1000 + Number(m[3]), aliases: full !== base ? [dark ? `${full}-dark` : full] : [], data: e.data })
		} else if (parts[0].startsWith('Resource-Icons') && (m = /^Res_(.+?)_(48|32|16)(?:_(Light|Dark))?\.svg$/.exec(file))) {
			const segs = m[1].split('_')
			const base = `aws-${[strip(segs[0]), ...segs.slice(1)].map(slug).join('-')}`
			const full = `aws-${segs.map(slug).join('-')}`
			const dark = m[3] === 'Dark'
			const cat = parts.find((x) => x.startsWith('Res_') && !x.endsWith('.svg') && !/^Res_\d/.test(x))?.slice(4)
			out.push({ name: dark ? `${base}-dark` : base, label: words(m[1]), kind: 'resource', category: cat && words(cat), source: file, rank: 500 + Number(m[2]), aliases: full !== base ? [dark ? `${full}-dark` : full] : [], data: e.data })
		} else if (parts[0].startsWith('Category-Icons') && (m = /^Arch-Category_(.+?)_(16|32|48|64)\.svg$/.exec(file))) {
			out.push({ name: `aws-category-${slug(m[1])}`, label: `${words(m[1])} (category)`, kind: 'category', source: file, rank: 200 + Number(m[2]), aliases: [], data: e.data })
		} else if (parts[0].startsWith('Architecture-Group-Icons') && (m = /^(.+?)_32(_Dark)?\.svg$/.exec(file))) {
			const base = `aws-group-${slug(strip(m[1]))}`
			out.push({ name: m[2] ? `${base}-dark` : base, label: `${words(m[1])} (group)`, kind: 'group', source: file, rank: 100, aliases: [], data: e.data })
		}
	}
	return out
}

function mapAzure(entries: { path: string; data: () => Buffer }[]): Candidate[] {
	const out: Candidate[] = []
	for (const e of entries) {
		const m = /^(\d+)-icon-service-(.+)\.svg$/.exec(basename(e.path))
		if (!m) continue
		const raw = m[2]
		const base = `azure-${slug(raw.replace(/^(Azure|Microsoft)-/i, ''))}`
		const full = `azure-${slug(raw)}`
		const cat = e.path.split('/').at(-2)
		// lower file ids are the original icon; later duplicates in other folders share the id
		out.push({ name: base, label: words(raw), kind: 'service', category: cat, source: basename(e.path), rank: 100_000 - Number(m[1]), aliases: full !== base ? [full] : [], data: e.data })
	}
	return out
}

/** Core (2025) icons that supersede a differently named legacy icon. */
const GCP_REPLACES: Record<string, string> = {
	'gcp-gke': 'gcp-google-kubernetes-engine',
	'gcp-vertex-ai': 'gcp-vertexai',
	'gcp-apigee': 'gcp-apigee-api-platform',
	'gcp-security-operations': 'gcp-chronicle',
}

function mapGcp(bySource: Record<string, { path: string; data: () => Buffer }[]>): Candidate[] {
	const out: Candidate[] = []
	const core = new Set<string>()
	for (const e of bySource['core-products'] ?? []) {
		const parts = e.path.split('/')
		if (parts[0] !== 'Unique Icons' || parts[2] !== 'SVG') continue
		const name = `gcp-${slug(parts[1])}`
		core.add(name)
		out.push({ name, label: parts[1], kind: 'service', source: basename(e.path), rank: 2000, aliases: GCP_REPLACES[name] ? [GCP_REPLACES[name]] : [], data: e.data })
	}
	for (const e of bySource.categories ?? []) {
		const parts = e.path.split('/')
		if (parts[0] !== 'Category Icons' || parts[2] !== 'SVG') continue
		out.push({ name: `gcp-category-${slug(parts[1].replace(/_/g, ' '))}`, label: `${parts[1].replace(/ _ /g, ' & ')} (category)`, kind: 'category', source: basename(e.path), rank: 1000, aliases: [], data: e.data })
	}
	const replaced = new Set(Object.values(GCP_REPLACES))
	for (const e of bySource.legacy ?? []) {
		const parts = e.path.split('/')
		if (parts.length !== 2 || basename(e.path, '.svg') !== parts[0]) continue
		let name = `gcp-${slug(parts[0])}`
		// a newer core icon takes the name; the legacy one stays reachable as `<name>-legacy`
		if (core.has(name) || replaced.has(name)) name = `${name}-legacy`
		out.push({ name, label: words(parts[0]).replace(/\b[a-z]/g, (c) => c.toUpperCase()), kind: 'service', source: e.path, rank: 500, aliases: [], data: e.data })
	}
	return out
}

// ---------------------------------------------------------------------------
// Run

interface Report {
	vendor: IconVendor
	version: string
	icons: number
	aliases: number
	byKind: Record<string, number>
	skipped: number
	duplicates: number
	sources: { url: string; sha256: string; bytes: number; cached: boolean }[]
	catalogMapped: number
	catalogUnmapped: string[]
	samples: string[]
	dir: string
}

async function run(spec: VendorSpec): Promise<Report> {
	let version = spec.version
	let sources = spec.sources
	if (flag('latest') && spec.latest) {
		const res = await fetch(spec.page, { headers: { 'User-Agent': 'octo-draw icons:fetch' } })
		const found = res.ok ? spec.latest(await res.text()) : null
		if (found && found.version !== version) {
			log(`  ${spec.vendor}: newest release on ${spec.page} is ${found.version} (pinned ${version})`)
			version = found.version
			sources = found.sources
		}
	}
	log(`${spec.label} ${version}`)
	const downloaded: Report['sources'] = []
	const bySource: Record<string, { path: string; data: () => Buffer }[]> = {}
	for (const src of sources) {
		const d = await download(spec.vendor, src, version)
		downloaded.push({ url: src.url, sha256: d.sha256, bytes: d.bytes, cached: d.cached })
		bySource[src.id] = [...unzip(d.data)].filter((e) => e.path.toLowerCase().endsWith('.svg') && !isJunk(e.path))
	}
	const all = Object.values(bySource).flat()
	const cands = spec.vendor === 'aws' ? mapAws(all) : spec.vendor === 'azure' ? mapAzure(all) : mapGcp(bySource)

	// pick one file per name
	const best = new Map<string, Candidate>()
	let duplicates = 0
	for (const c of cands) {
		const prev = best.get(c.name)
		if (prev) duplicates++
		if (!prev || c.rank > prev.rank) best.set(c.name, c)
	}
	// AWS: a resource that collides with a service name gets a suffix instead of being dropped
	if (spec.vendor === 'aws') {
		for (const c of cands) {
			const winner = best.get(c.name)
			if (winner && winner !== c && winner.kind !== c.kind && c.kind === 'resource' && !best.has(`${c.name}-resource`)) {
				best.set(`${c.name}-resource`, { ...c, name: `${c.name}-resource` })
				duplicates--
			}
		}
	}

	const packDir = join(spec.vendor, version)
	const abs = join(dir, packDir)
	if (!inside(abs, dir)) fail(`bad pack directory ${abs}`)
	rmSync(abs, { recursive: true, force: true })
	mkdirSync(abs, { recursive: true })

	const icons: Record<string, IconPackIcon> = {}
	const aliases: Record<string, string> = {}
	let skipped = 0
	for (const c of [...best.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		const data = c.data()
		const text = data.toString('utf8')
		if (data.length > 2_000_000 || !/<svg\b/i.test(text)) {
			skipped++
			continue
		}
		const file = `${c.name}.svg`
		writeFileSync(join(abs, file), data)
		icons[c.name] = { label: c.label, file, kind: c.kind, category: c.category, source: c.source }
	}
	for (const c of best.values()) for (const a of c.aliases) if (icons[c.name] && !icons[a] && !aliases[a]) aliases[a] = c.name

	// Eraser-style names: manual table + every catalog name/alias for this vendor
	const manual = MANUAL[spec.vendor]
	for (const [a, target] of Object.entries(manual)) if (icons[target] && !icons[a]) aliases[a] = target
	const resolveName = (n: string) => (icons[n] ? n : aliases[n])
	let catalogMapped = 0
	const catalogUnmapped: string[] = []
	for (const e of CATALOG) {
		if (e.vendor !== spec.vendor) continue
		const names = [e.name, ...(e.aliases ?? [])].filter((n) => n.startsWith(`${spec.vendor}-`))
		if (!names.length) continue // the vendor's own logo (`aws`, `azure`) stays a brand icon
		const target = names.map(resolveName).find(Boolean)
		if (!target) {
			catalogUnmapped.push(e.name)
			continue
		}
		catalogMapped++
		for (const n of names) if (!icons[n] && !aliases[n]) aliases[n] = target
	}

	const pack: IconPackManifest = { vendor: spec.vendor, version, label: spec.label, dir: packDir.split(sep).join('/'), terms: spec.terms, icons, aliases }
	writeFileSync(join(abs, 'manifest.json'), JSON.stringify({ ...pack, dir: '.', sources: downloaded, generatedAt: new Date().toISOString() }, null, '\t') + '\n')

	const byKind: Record<string, number> = {}
	for (const i of Object.values(icons)) byKind[i.kind ?? 'service'] = (byKind[i.kind ?? 'service'] ?? 0) + 1
	const sampleWanted: Record<IconVendor, string[]> = {
		aws: ['aws-ec2', 'aws-lambda', 'aws-s3', 'aws-dynamodb', 'aws-api-gateway', 'aws-sqs', 'aws-eks', 'aws-cloudfront', 'aws-rds', 'aws-ec2-instance'],
		gcp: ['gcp-pubsub', 'gcp-bigquery', 'gcp-cloud-run', 'gcp-gke', 'gcp-cloud-storage', 'gcp-compute-engine', 'gcp-cloud-functions', 'gcp-cloud-sql', 'gcp-vertex-ai', 'gcp-category-databases'],
		azure: ['azure-functions', 'azure-cosmos-db', 'azure-function-apps', 'azure-virtual-machine', 'azure-kubernetes-services', 'azure-storage-accounts', 'azure-sql-database', 'azure-key-vaults', 'azure-service-bus', 'azure-app-services'],
	}
	const samples = sampleWanted[spec.vendor].map((n) => (resolveName(n) ? (n === resolveName(n) ? n : `${n} → ${resolveName(n)}`) : `${n} (missing)`))
	return { vendor: spec.vendor, version, icons: Object.keys(icons).length, aliases: Object.keys(aliases).length, byKind, skipped, duplicates, sources: downloaded, catalogMapped, catalogUnmapped, samples, dir: abs }

}

const reports: Report[] = []
const root: IconCacheManifest = readIconCacheManifest(dir) ?? { schema: 1, packs: {} }
for (const spec of specs) {
	try {
		const r = await run(spec)
		reports.push(r)
		const packManifest = JSON.parse(readFileSync(join(r.dir, 'manifest.json'), 'utf8')) as IconPackManifest & { sources?: unknown; generatedAt?: unknown }
		const { sources: _s, generatedAt: _g, ...rest } = packManifest
		root.packs[spec.vendor] = { ...rest, dir: relative(dir, r.dir).split(sep).join('/') }
		root.generatedAt = new Date().toISOString()
		mkdirSync(dir, { recursive: true })
		writeFileSync(manifestPath(dir), JSON.stringify(root, null, '\t') + '\n')
		log(`  ${r.icons} icons (${Object.entries(r.byKind).map(([k, v]) => `${v} ${k}`).join(', ')}), ${r.aliases} aliases, ${r.skipped} skipped, ${r.duplicates} duplicate files merged`)
		log(`  catalog names mapped: ${r.catalogMapped}${r.catalogUnmapped.length ? `, unmapped: ${r.catalogUnmapped.join(', ')}` : ''}`)
		log(`  samples: ${r.samples.join(', ')}`)
		if (flag('list')) log(Object.keys(root.packs[spec.vendor]!.icons).join('\n'))
		log('')
	} catch (err) {
		console.error(`icons:fetch: ${spec.vendor}: ${(err as Error).message}`)
		process.exitCode = 1
	}
}
if (json) console.log(JSON.stringify({ dir, manifest: manifestPath(dir), reports }, null, '\t'))
else if (reports.length) log(`Manifest: ${manifestPath(dir)}\nRestart the octo-draw server to load the packs. The CLI picks them up automatically.`)
