/**
 * `scanSource`: runs the analyzers on a file map and merges their graphs into
 * one octo document — a `direction right` root page plus drill-down pages.
 *
 * Merging rules:
 * - compose services match code workspaces by build context dir or name, so
 *   one node carries both (code icon/drill, compose ports/volumes/deps);
 * - a data store inferred from code dependencies (Postgres via `pg`) merges
 *   into the compose / k8s service running that technology (`image: postgres`);
 * - Kubernetes and Terraform go to their own pages when the root already has
 *   a code or compose view (otherwise they are the root);
 * - OpenAPI specs hang off the service whose directory holds them.
 */

import { analyzeActions } from './analyzers/actions'
import { analyzeCode, type CodeMeta } from './analyzers/code'
import { analyzeCompose } from './analyzers/compose'
import { analyzeK8s } from './analyzers/k8s'
import { analyzeOpenApi, type OpenApiSpec } from './analyzers/openapi'
import { analyzeTerraform } from './analyzers/terraform'
import { emitOcto, graphToIR, type EmittedPage } from './emit'
import { ANALYZERS, emptyResult, type AnalyzerName, type AnalyzerResult, type ArchEdge, type ArchGraph, type ArchNode, type ArchPage, type Finding, type ScanFiles, type ScanOptions } from './types'
import { asStr, isObj, KeyAllocator, parseJsonLoose, uniq, within } from './util'

export interface ScanResult {
	code: string
	/** Root page IR. */
	ir: EmittedPage['ir']
	pages: EmittedPage[]
	findings: Finding[]
	warnings: string[]
	/** The merged graphs before IR conversion (for explain / refinement). */
	graph: { root: ArchGraph; pages: ArchPage[]; title: string }
}

/** Page names must survive `page <Name>` and `drill: <Name>` without quoting surprises. */
export const safePageName = (s: string) => s.replace(/["[\]{},:#\n\r]/g, ' ').replace(/\/\//g, '/').replace(/\s+/g, ' ').trim() || 'page'

function runAnalyzer(name: AnalyzerName, files: ScanFiles, opts: ScanOptions): AnalyzerResult {
	switch (name) {
		case 'code':
			return analyzeCode(files, { maxModuleNodes: opts.maxModuleNodes })
		case 'compose':
			return analyzeCompose(files)
		case 'k8s':
			return analyzeK8s(files)
		case 'terraform':
			return analyzeTerraform(files)
		case 'openapi':
			return analyzeOpenApi(files)
		case 'actions':
			return emptyResult('actions')
	}
}

const low = (s: string) => s.toLowerCase()

/** Renames node keys in a graph (edges and parents follow). */
function remap(g: ArchGraph, map: Map<string, string>) {
	if (!map.size) return
	for (const n of g.nodes) if (n.parent && map.has(n.parent)) n.parent = map.get(n.parent)
	for (const e of g.edges) {
		e.from = map.get(e.from) ?? e.from
		e.to = map.get(e.to) ?? e.to
	}
}

/** Adds `other` into `base`: nodes with an existing key are merged field by field (base wins on conflicts). */
function absorb(base: ArchGraph, other: ArchGraph) {
	const byKey = new Map(base.nodes.map((n) => [n.key, n]))
	for (const n of other.nodes) {
		const b = byKey.get(n.key)
		if (!b) {
			base.nodes.push(n)
			byKey.set(n.key, n)
			continue
		}
		b.icon ??= n.icon
		b.shape ??= n.shape
		b.label ??= n.label
		b.tech ??= n.tech
		b.drill ??= n.drill
		b.parent ??= n.parent
		b.aliases = uniq([...(b.aliases ?? []), ...(n.aliases ?? [])])
		b.facts = uniq([...(b.facts ?? []), ...(n.facts ?? [])])
	}
	base.edges.push(...other.edges)
}

/** Drops self loops and duplicate edges (keeps the first label). */
function tidy(g: ArchGraph) {
	const keys = new Set(g.nodes.map((n) => n.key))
	const seen = new Map<string, ArchEdge>()
	const out: ArchEdge[] = []
	for (const e of g.edges) {
		if (e.from === e.to || !keys.has(e.from) || !keys.has(e.to)) continue
		const id = `${e.from}\u0000${e.to}`
		const prev = seen.get(id)
		if (prev) {
			if (!prev.label && e.label) prev.label = e.label
			if (!e.dotted) prev.dotted = undefined
			continue
		}
		seen.set(id, e)
		out.push(e)
	}
	g.edges = out
	// containers must have children
	const parents = new Set(g.nodes.map((n) => n.parent).filter(Boolean))
	g.nodes = g.nodes.filter((n) => n.role !== 'group' || !n.isContainer || parents.has(n.key))
}

function defaultTitle(files: ScanFiles, opts: ScanOptions): string {
	if (opts.title) return opts.title
	const pkg = parseJsonLoose(files.get('package.json') ?? '')
	const name = (isObj(pkg) && asStr(pkg.name)) || opts.rootName
	return name ? `${name} architecture` : 'Architecture'
}

export function scanSource(input: ScanFiles, opts: ScanOptions = {}): ScanResult {
	// a stable order makes the output independent of how the files were collected
	const files: ScanFiles = new Map([...input].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
	const enabled = opts.only?.length ? ANALYZERS.filter((a) => opts.only!.includes(a)) : ANALYZERS
	const results = new Map<AnalyzerName, AnalyzerResult>()
	const warnings: string[] = []
	for (const name of enabled) {
		try {
			const r = runAnalyzer(name, files, opts)
			results.set(name, r)
			warnings.push(...r.warnings.map((w) => `${name}: ${w}`))
		} catch (err) {
			warnings.push(`${name}: analyzer failed: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	const found = (n: AnalyzerName) => {
		const r = results.get(n)
		return r && r.confidence > 0 ? r : undefined
	}
	for (const r of results.values()) for (const p of r.pages) p.name = safePageName(p.name)
	for (const r of results.values()) for (const n of r.root.nodes) if (n.drill) n.drill = safePageName(n.drill)

	const root: ArchGraph = { nodes: [], edges: [] }
	const pages: ArchPage[] = []
	const code = found('code')
	const compose = found('compose')
	const k8s = found('k8s')
	const tf = found('terraform')
	const openapi = found('openapi')
	const mergeNotes: string[] = []
	const ciNotes: string[] = []

	if (code) {
		absorb(root, code.root)
		pages.push(...code.pages)
	}
	if (compose) {
		const g = compose.root
		const map = new Map<string, string>()
		const taken = new KeyAllocator(root.nodes.map((n) => n.key))
		const codeNodes = root.nodes.filter((n) => n.role !== 'client' && n.role !== 'store' && n.role !== 'queue' && n.role !== 'external')
		for (const n of g.nodes) {
			if (n.key === 'Internet' || n.role === 'group') continue
			// 1) build context = workspace dir, 2) same name as a workspace
			const byDir = n.dir !== undefined ? codeNodes.find((c) => c.dir !== undefined && c.dir === n.dir) : undefined
			const byName = codeNodes.find((c) => (c.aliases ?? []).some((a) => (n.aliases ?? []).some((b) => low(a) === low(b))))
			const hit = byDir ?? byName
			if (hit) {
				// the compose service name is what operators use: prefer it as the key when the package name differs
				const composeName = n.key
				if (byDir && low(composeName) !== low(hit.key) && !root.nodes.some((x) => low(x.key) === low(composeName))) {
					const old = hit.key
					remap(root, new Map([[old, composeName]]))
					hit.key = composeName
					hit.label = undefined
					hit.facts = [...(hit.facts ?? []), `package ${old}`]
					if (hit.drill === safePageName(`${old} modules`)) {
						const page = pages.find((p) => p.name === hit.drill)
						const renamed = safePageName(`${composeName} modules`)
						if (page && !pages.some((p) => p.name === renamed)) {
							page.name = renamed
							hit.drill = renamed
						}
					}
					if (code?.meta) for (const w of (code.meta as unknown as CodeMeta).workspaces) if (w.key === old) {
						w.key = composeName
						w.page = hit.drill
					}
				}
				map.set(n.key, hit.key)
				mergeNotes.push(`compose service "${composeName}" = workspace "${hit.aliases?.[0] ?? hit.key}"`)
				continue
			}
			// data stores: same technology as a dependency-inferred external
			if (n.tech) {
				const ext = root.nodes.filter((c) => (c.role === 'store' || c.role === 'queue' || c.role === 'external') && c.tech === n.tech && !c.dir)
				if (ext.length === 1 && g.nodes.filter((x) => x.tech === n.tech).length === 1) {
					const e = ext[0]
					// keep the compose name (what operators see), point code edges at it
					const newKey = taken.has(n.key) && n.key.toLowerCase() !== e.key.toLowerCase() ? taken.take(n.key) : n.key
					remap(root, new Map([[e.key, newKey]]))
					root.nodes = root.nodes.filter((x) => x !== e)
					if (newKey !== n.key) map.set(n.key, newKey)
					mergeNotes.push(`"${e.key}" (from dependencies) = compose service "${n.key}"`)
					continue
				}
			}
			if (taken.has(n.key)) map.set(n.key, taken.take(n.key))
			else taken.take(n.key)
		}
		for (const n of g.nodes) n.key = map.get(n.key) ?? n.key
		remap(g, map)
		// code's Users and compose's Internet are the same outside world
		if (root.nodes.some((n) => n.key === 'Users') && g.nodes.some((n) => n.key === 'Internet')) {
			remap(root, new Map([['Users', 'Internet']]))
			root.nodes = root.nodes.filter((n) => n.key !== 'Users')
		}
		absorb(root, g)
	}

	const sidePage = (r: AnalyzerResult, pageName: string, nodeKey: string, icon: string, label: string) => {
		if (!root.nodes.length) {
			absorb(root, r.root)
			return
		}
		const name = safePageName(pageName)
		pages.push({ name, analyzer: r.analyzer, nodes: r.root.nodes, edges: r.root.edges })
		const keys = new KeyAllocator(root.nodes.map((n) => n.key))
		root.nodes.push({ key: keys.take(nodeKey), label, icon, role: 'infra', drill: name, facts: r.notes })
	}
	if (k8s) sidePage(k8s, 'Kubernetes', 'Kubernetes', 'kubernetes', 'Kubernetes manifests')
	if (tf) sidePage(tf, 'Terraform infrastructure', 'Infrastructure', 'terraform', 'Terraform infrastructure')

	if (openapi) {
		const specs = (openapi.meta?.specs ?? []) as OpenApiSpec[]
		const wsMeta = ((code?.meta as CodeMeta | undefined)?.workspaces ?? []).slice().sort((a, b) => b.dir.length - a.dir.length)
		const keys = new KeyAllocator(root.nodes.map((n) => n.key))
		for (const spec of specs) {
			pages.push(openapi.pages.find((p) => p.name === safePageName(spec.page))!)
			const owner = wsMeta.find((w) => within(spec.dir, w.dir) && (w.dir !== '' || wsMeta.length === 1))
			const ownerNode = owner && root.nodes.find((n) => n.key === owner.key)
			const pageName = safePageName(spec.page)
			if (ownerNode && !ownerNode.drill) {
				ownerNode.drill = pageName
				mergeNotes.push(`OpenAPI "${spec.title}" linked from "${ownerNode.key}"`)
			} else if (ownerNode && owner?.page) {
				const modPage = pages.find((p) => p.name === owner.page)!
				const k = new KeyAllocator(modPage.nodes.map((n) => n.key)).take(spec.nodeKey)
				modPage.nodes.unshift({ key: k, icon: 'openapi', role: 'api', drill: pageName })
				mergeNotes.push(`OpenAPI "${spec.title}" linked from the "${ownerNode.key}" module page`)
			} else {
				const k = keys.take(spec.nodeKey)
				root.nodes.push({ key: k, icon: 'openapi', role: 'api', drill: pageName })
				if (ownerNode) root.edges.push({ from: ownerNode.key, to: k, dotted: true })
			}
		}
	}

	if (opts.ci) {
		const ci = analyzeActions(files, 'CI/CD')
		if (ci) {
			pages.push(ci.page)
			const keys = new KeyAllocator(root.nodes.map((n) => n.key))
			root.nodes.push({ key: keys.take('CI/CD'), icon: 'github-actions', role: 'infra', drill: ci.page.name, facts: ci.notes })
			ciNotes.push(...ci.notes)
		}
	}

	tidy(root)
	for (const p of pages) tidy(p)
	const title = defaultTitle(files, opts)
	if (!root.nodes.length) warnings.push(files.size ? 'no architecture found (no workspaces, compose, Kubernetes, Terraform or OpenAPI files recognised)' : 'no files to scan')

	const findings: Finding[] = []
	for (const r of results.values()) if (r.confidence > 0) findings.push({ analyzer: r.analyzer, confidence: r.confidence, notes: r.notes })
	if (ciNotes.length) findings.push({ analyzer: 'actions', confidence: 0.9, notes: ciNotes })
	if (mergeNotes.length) {
		const f = findings.find((x) => x.analyzer === 'compose') ?? findings[0]
		f?.notes.push(...mergeNotes)
	}

	// keep only pages something drills into (or that are reachable from a drillable page)
	const reachable = new Set<string>()
	const visit = (g: ArchGraph) => {
		for (const n of g.nodes) if (n.drill && !reachable.has(n.drill)) {
			reachable.add(n.drill)
			const p = pages.find((x) => x.name === n.drill)
			if (p) visit(p)
		}
	}
	visit(root)
	const outPages = uniq(pages.filter((p) => reachable.has(p.name)))
	const rootIR = graphToIR(root, { title })
	const emitted = outPages.map((p) => ({ name: p.name, ir: graphToIR(p) }))
	const header = findings.length ? [`scanned by octo-draw: ${findings.map((f) => `${f.analyzer} ${Math.round(f.confidence * 100)}%`).join(', ')}`] : []
	return {
		code: emitOcto({ name: '', ir: rootIR }, emitted, header),
		ir: rootIR,
		pages: emitted,
		findings,
		warnings,
		graph: { root, pages: outPages, title },
	}
}

/** Re-emits a (possibly refined) graph. */
export function emitGraph(graph: ScanResult['graph'], header: string[] = []): string {
	return emitOcto({ name: '', ir: graphToIR(graph.root, { title: graph.title }) }, graph.pages.map((p) => ({ name: p.name, ir: graphToIR(p) })), header)
}

