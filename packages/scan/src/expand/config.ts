/**
 * Config expander: YAML / JSON (compose services, Kubernetes objects,
 * workflow jobs, OpenAPI operations) and Terraform blocks.
 *
 * `file#a.b.c` navigates the parsed document (keys may contain dots: the
 * longest matching key wins; Kubernetes objects are addressed `Kind/name`).
 * Object / array children become nodes (expandable again), scalar facts go
 * into one note node. Values are only shown for keys that can't hold
 * secrets: anything under env / environment / data / stringData / secrets,
 * any key that looks secret, and all of a Kubernetes Secret are keys only.
 */

import { printOcto } from '@octo-draw/core'
import { attributes, scanBlocks } from '../analyzers/hcl'
import { graphToIR } from '../emit'
import type { ArchEdge, ArchNode, ScanFiles } from '../types'
import { dirname, isObj, KeyAllocator, parseJsonLoose, parseYamlAll, plural } from '../util'
import { formatSrc } from './src'
import type { ExpandedPage } from './types'

const SECRETISH = /secret|token|password|passwd|pwd|key|credential|private|auth|cert|salt|dsn|conn(ection)?_?str/i
const KEYS_ONLY = /^(env|environment|envFrom|data|stringData|secrets?|binaryData|variables|vars|args|command)$/i

export function isConfigPath(path: string): boolean {
	return /\.(ya?ml|json|tf)$/i.test(path)
}

function short(v: string, n = 48): string {
	const s = v.replace(/\s+/g, ' ').trim()
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Walks `segments` (dot-split fragment) with longest-key matching. */
function navigate(root: unknown, segments: string[]): { value: unknown; path: string[] } | null {
	let cur = root
	const path: string[] = []
	for (let i = 0; i < segments.length; ) {
		if (Array.isArray(cur)) {
			const n = Number(segments[i])
			if (!Number.isInteger(n) || n < 0 || n >= cur.length) return null
			cur = cur[n]
			path.push(segments[i])
			i++
			continue
		}
		if (!isObj(cur)) return null
		let hit: string | undefined
		let used = 0
		for (let j = segments.length; j > i; j--) {
			const k = segments.slice(i, j).join('.')
			if (Object.prototype.hasOwnProperty.call(cur, k)) {
				hit = k
				used = j - i
				break
			}
		}
		if (hit === undefined) return null
		cur = cur[hit]
		path.push(hit)
		i += used
	}
	return { value: cur, path }
}

function docsOf(path: string, text: string): unknown[] {
	if (/\.json$/i.test(path)) {
		const v = parseJsonLoose(text)
		return v === undefined ? [] : [v]
	}
	return parseYamlAll(text).docs
}

export function expandConfig(files: ScanFiles, path: string, fragment: string | undefined, opts: { maxNodes?: number; scheme?: string } = {}): ExpandedPage | null {
	const text = files.get(path)
	if (!text) return null
	const scheme = opts.scheme ?? 'local'
	const max = Math.max(6, opts.maxNodes ?? 30)
	if (/\.tf$/i.test(path)) return expandTerraform(files, path, text, fragment, max, scheme)
	const docs = docsOf(path, text)
	if (!docs.length) return null
	let root: unknown = docs.length === 1 ? docs[0] : docs
	let secretDoc = false
	let segs = fragment ? fragment.split('.') : []
	// Kubernetes `Kind/name` (first segment)
	const k8s = segs.length ? /^([A-Z][A-Za-z]+)\/(.+)$/.exec(segs[0]) : null
	if (k8s) {
		const doc = docs.find((d) => isObj(d) && d.kind === k8s[1] && isObj(d.metadata) && d.metadata.name === k8s[2])
		if (!doc) return null
		root = doc
		secretDoc = k8s[1] === 'Secret'
		segs = segs.slice(1)
	} else if (docs.length > 1 && !segs.length) {
		// multi-document file: one node per object
		const keys = new KeyAllocator()
		const nodes: ArchNode[] = []
		for (const d of docs.slice(0, max)) {
			if (!isObj(d)) continue
			const kind = typeof d.kind === 'string' ? d.kind : 'document'
			const name = isObj(d.metadata) && typeof d.metadata.name === 'string' ? d.metadata.name : undefined
			const k = keys.take(name ? `${kind} ${name}` : kind)
			nodes.push({ key: k, icon: 'file', role: 'config', src: name ? formatSrc(scheme, path, `${kind}/${name}`) : undefined })
		}
		return page(nodes, [], nodes.filter((n) => n.src).map((n) => n.key), [`${path}: ${plural(docs.length, 'document')}`])
	}
	const hit = navigate(root, segs)
	if (!hit) return null
	secretDoc ||= isObj(root) && root.kind === 'Secret'
	const keysOnlyHere = secretDoc || hit.path.some((p) => KEYS_ONLY.test(p) || SECRETISH.test(p))
	const value = hit.value
	if (!isObj(value) && !Array.isArray(value)) {
		const label = keysOnlyHere || SECRETISH.test(hit.path[hit.path.length - 1] ?? '') ? hit.path.join('.') : `${hit.path.join('.')}: ${short(String(value))}`
		return page([{ key: 'value', label, icon: 'file', role: 'config', shape: 'document' }], [], [], [`${path}#${fragment}`])
	}
	const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value)
	const keys = new KeyAllocator()
	const nodes: ArchNode[] = []
	const facts: string[] = []
	const base = fragment ? `${fragment}.` : ''
	const children: string[] = []
	let folded = 0
	for (const [k, v] of entries) {
		const nested = isObj(v) || Array.isArray(v)
		if (!nested) {
			const hide = keysOnlyHere || SECRETISH.test(k) || KEYS_ONLY.test(k)
			facts.push(hide ? k : Array.isArray(value) ? short(String(v)) : `${k}: ${short(String(v), 40)}`)
			continue
		}
		if (nodes.length >= max - 2) {
			folded++
			continue
		}
		const label = Array.isArray(value) ? itemLabel(v, k) : k
		const key = keys.take(label)
		const size = Array.isArray(v) ? plural(v.length, 'item') : plural(Object.keys(v as object).length, 'key')
		nodes.push({ key, label: key === label ? undefined : label, icon: Array.isArray(v) ? 'layers' : 'file', role: 'config', src: formatSrc(scheme, path, `${base}${k}`), facts: [size] })
		children.push(key)
	}
	if (folded) nodes.push({ key: keys.take('more'), label: `${folded} more entries`, icon: 'layers', role: 'config' })
	if (facts.length) {
		const shown = facts.slice(0, 12)
		nodes.unshift({ key: keys.take('details'), label: shown.join(' · ') + (facts.length > shown.length ? ` · +${facts.length - shown.length}` : ''), shape: 'document', icon: 'file', role: 'config' })
	}
	if (!nodes.length) return null
	const notes = [`${path}${fragment ? `#${fragment}` : ''}: ${plural(entries.length, 'entry', 'entries')}${keysOnlyHere ? ' (values hidden)' : ''}`]
	return page(nodes, [], children, notes)
}

function itemLabel(v: unknown, i: string): string {
	if (isObj(v)) for (const k of ['name', 'id', 'key', 'path', 'containerPort', 'port', 'uses', 'run']) if (typeof v[k] === 'string' || typeof v[k] === 'number') return short(String(v[k]), 32)
	return `#${i}`
}

function page(nodes: ArchNode[], edges: ArchEdge[], children: string[], notes: string[]): ExpandedPage {
	return { body: printOcto(graphToIR({ nodes, edges })), children, findings: [{ analyzer: 'config', confidence: 0.7, notes }] }
}

const REF = /\b((?:aws|google|azurerm|kubernetes|helm|random|null|cloudflare|github|datadog|tls)_[a-z0-9_]+)\.([A-Za-z0-9_-]+)\b|\bmodule\.([A-Za-z0-9_-]+)\b|\bdata\.([a-z0-9_]+)\.([A-Za-z0-9_-]+)\b/g

function expandTerraform(files: ScanFiles, path: string, text: string, fragment: string | undefined, max: number, scheme: string): ExpandedPage | null {
	const blocks = scanBlocks(text)
	const addrOf = (b: { type: string; labels: string[] }) => (b.type === 'resource' && b.labels.length >= 2 ? `${b.labels[0]}.${b.labels[1]}` : b.type === 'module' && b.labels.length ? `module.${b.labels[0]}` : b.type === 'data' && b.labels.length >= 2 ? `data.${b.labels[0]}.${b.labels[1]}` : `${b.type}${b.labels.length ? ` ${b.labels.join(' ')}` : ''}`)
	const keys = new KeyAllocator()
	if (!fragment) {
		const nodes: ArchNode[] = []
		for (const b of blocks.slice(0, max)) nodes.push({ key: keys.take(addrOf(b)), icon: 'terraform', role: 'infra', src: formatSrc(scheme, path, addrOf(b)) })
		if (!nodes.length) return null
		return page(nodes, [], nodes.map((n) => n.key), [`${path}: ${plural(blocks.length, 'block')}`])
	}
	const b = blocks.find((x) => addrOf(x) === fragment)
	if (!b) return null
	// all addresses in the same directory, for reference nodes
	const dir = dirname(path)
	const known = new Map<string, string>()
	for (const [p, t] of files) {
		if (!p.endsWith('.tf') || dirname(p) !== dir || !t) continue
		for (const x of scanBlocks(t)) known.set(addrOf(x), p)
	}
	const attrs = attributes(b.body)
	const nodes: ArchNode[] = []
	const edges: ArchEdge[] = []
	const self = keys.take(fragment)
	nodes.push({ key: self, icon: 'terraform', role: 'infra', src: formatSrc(scheme, path, fragment) })
	const facts: string[] = []
	for (const [k, v] of Object.entries(attrs)) {
		if (REF.test(v)) {
			REF.lastIndex = 0
			continue
		}
		REF.lastIndex = 0
		facts.push(SECRETISH.test(k) || /^(environment|variables|tags)$/.test(k) ? k : `${k} = ${short(v, 40)}`)
	}
	if (facts.length) {
		const d = keys.take('details')
		nodes.push({ key: d, label: facts.slice(0, 12).join(' · ') + (facts.length > 12 ? ` · +${facts.length - 12}` : ''), shape: 'document', icon: 'file', role: 'config' })
		edges.push({ from: self, to: d, plain: true, dotted: true })
	}
	const refs = new Set<string>()
	for (const m of b.body.matchAll(REF)) {
		const addr = m[3] ? `module.${m[3]}` : m[4] ? `data.${m[4]}.${m[5]}` : `${m[1]}.${m[2]}`
		if (addr !== fragment) refs.add(addr)
	}
	for (const addr of [...refs].slice(0, max - nodes.length)) {
		const k = keys.take(addr)
		const file = known.get(addr)
		nodes.push({ key: k, icon: 'terraform', role: 'infra', color: 'gray', src: file ? formatSrc(scheme, file, addr) : undefined })
		edges.push({ from: self, to: k, dotted: true })
	}
	// nested blocks (vpc_config { ... })
	for (const nb of scanBlocks(b.body).slice(0, Math.max(0, max - nodes.length))) {
		const k = keys.take(nb.type)
		nodes.push({ key: k, label: `${nb.type} {}`, icon: 'file', role: 'config', parent: undefined })
		edges.push({ from: self, to: k, plain: true })
	}
	return page(nodes, edges, [], [`${path}#${fragment}: ${plural(Object.keys(attrs).length, 'attribute')}, ${plural(refs.size, 'reference')}`])
}
