/**
 * OpenAPI / Swagger analyzer: one page per spec with tag groups holding their
 * endpoints. The spec's location tells the combiner which service it belongs to.
 */

import { emptyResult, type AnalyzerResult, type ArchNode, type ScanFiles } from '../types'
import { asObj, asStr, basename, dirname, isObj, KeyAllocator, parseJsonLoose, parseYaml, plural } from '../util'

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
const MAX_ENDPOINTS = 60

export interface OpenApiSpec {
	path: string
	dir: string
	title: string
	page: string
	/** Root-page node for specs that no service claims. */
	nodeKey: string
}

const NAME_HINT = /(openapi|swagger|api)[^/]*\.(ya?ml|json)$/i

export function analyzeOpenApi(files: ScanFiles): AnalyzerResult {
	const r = emptyResult('openapi')
	const specs: OpenApiSpec[] = []
	const pageNames = new KeyAllocator()
	for (const [path, text] of files) {
		if (!/\.(ya?ml|json)$/i.test(path)) continue
		// cheap pre-check: the version key must appear near the top
		const head = text.slice(0, 2000)
		if (!/["']?(openapi|swagger)["']?\s*:\s*["']?[23]\./.test(head)) continue
		if (!NAME_HINT.test(path) && !/^\s*\{?\s*["']?(openapi|swagger)["']?\s*:/m.test(head)) continue
		const doc = path.endsWith('.json') ? parseJsonLoose(text) : parseYaml(text)
		if (!isObj(doc) || !(doc.openapi || doc.swagger) || !isObj(doc.paths)) continue
		const info = asObj(doc.info)
		const title = asStr(info.title) ?? basename(path)
		const page = pageNames.take(`API ${title}`)
		const groups = new Map<string, { method: string; path: string; summary?: string }[]>()
		let total = 0
		for (const [p, ops] of Object.entries(asObj(doc.paths))) {
			for (const m of METHODS) {
				const op = asObj(asObj(ops)[m])
				if (!Object.keys(op).length && !(m in asObj(ops))) continue
				total++
				const tag = asStr((Array.isArray(op.tags) ? op.tags : [])[0]) ?? (p.split('/').filter((s) => s && !s.startsWith('{'))[0] ?? 'default')
				groups.set(tag, [...(groups.get(tag) ?? []), { method: m.toUpperCase(), path: p, summary: asStr(op.summary) ?? asStr(op.operationId) }])
			}
		}
		const keys = new KeyAllocator()
		const nodes: ArchNode[] = []
		let shown = 0
		const apiKey = keys.take(title)
		nodes.push({ key: apiKey, icon: 'openapi', role: 'api', facts: [`${doc.openapi ? 'OpenAPI' : 'Swagger'} ${asStr(doc.openapi) ?? asStr(doc.swagger)}`, asStr(info.version) ? `version ${asStr(info.version)}` : ''].filter(Boolean) })
		const edges = []
		for (const [tag, eps] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
			const g = keys.take(`${tag} endpoints`)
			nodes.push({ key: g, label: tag, role: 'group', isContainer: true, icon: 'api' })
			edges.push({ from: apiKey, to: g })
			for (const ep of eps) {
				if (shown >= MAX_ENDPOINTS) break
				shown++
				nodes.push({ key: keys.take(`${ep.method} ${ep.path}`), parent: g, role: 'api', icon: 'webhook', facts: ep.summary ? [ep.summary] : [] })
			}
		}
		if (shown < total) nodes.push({ key: keys.take('more endpoints'), label: `${total - shown} more endpoints`, role: 'api', icon: 'layers' })
		r.pages.push({ name: page, analyzer: 'openapi', nodes, edges })
		specs.push({ path, dir: dirname(path), title, page, nodeKey: /\bapi$/i.test(title) ? title : `${title} API` })
		r.notes.push(`${path}: ${title}, ${plural(total, 'endpoint')} in ${plural(groups.size, 'tag')}`)
	}
	if (!specs.length) return r
	r.confidence = 0.9
	r.meta = { specs }
	return r
}
