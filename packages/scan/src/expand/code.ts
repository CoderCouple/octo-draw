/**
 * Code expander: a `src` path in a repo → one page.
 *
 * - directory: its subdirectories and source files, import edges aggregated
 *   at that level, other parts of the repo it imports (gray references) and
 *   external systems;
 * - file: its top-level symbols (exports and internals), call/reference
 *   edges between them, imported files (gray references) and externals;
 * - class / interface / struct / trait (`file#Name`): its members with calls
 *   between them and the top-level symbols / imports they use;
 * - function / method / const (`file#name`, `file#Class.method`): callers on
 *   the left, callees on the right;
 * - `dir#uses:<System>`: the files under `dir` that use an external system.
 *
 * Pure: works on a `ScanFiles` map (paths the expander may need but did not
 * read can be present with empty text: they still resolve imports).
 */

import { printOcto } from '@octo-draw/core'
import { externalFor, type ExternalSystem } from '../analyzers/code/externals'
import { extractImports, isTestPath, packageOf, readTsPaths, resolveImport, SOURCE_EXT, type TsPaths } from '../analyzers/code/imports'
import type { Lang } from '../analyzers/code/workspaces'
import { graphToIR } from '../emit'
import { skipDir } from '../filter'
import { extractSymbols, type CodeSymbol, type FileSymbols } from '../symbols'
import type { ArchEdge, ArchGraph, ArchNode, ScanFiles } from '../types'
import { asStr, basename, dirname, isObj, join, KeyAllocator, parseJsonLoose, plural } from '../util'
import { formatSrc } from './src'
import type { ExpandedPage, SrcRef } from './types'

export interface CodeExpandOptions {
	/** Max nodes on the page (default 30). */
	maxNodes?: number
	/** Scheme for child `src` values (default `local`). */
	scheme?: string
}

export const CODE_ICONS: Record<string, string> = {
	dir: 'box',
	file: 'file-code',
	class: 'boxes',
	struct: 'boxes',
	impl: 'boxes',
	function: 'function',
	method: 'square-function',
	constructor: 'square-function',
	getter: 'square-function',
	setter: 'square-function',
	interface: 'blocks',
	trait: 'blocks',
	type: 'blocks',
	enum: 'layers',
	namespace: 'package',
	const: 'hash',
	variable: 'hash',
	property: 'hash',
}

const KIND_COLOR: Record<string, string> = { class: 'blue', struct: 'blue', impl: 'blue', interface: 'purple', trait: 'purple', type: 'purple', enum: 'purple', function: 'green', method: 'green', constructor: 'green', getter: 'green', setter: 'green' }

const ALL_SOURCE = /\.(m|c)?(t|j)sx?$|\.go$|\.py$|\.rs$/

export function langOfPath(path: string): Lang | null {
	for (const [lang, re] of Object.entries(SOURCE_EXT) as [Lang, RegExp][]) if (re.test(path)) return lang
	return null
}

/** Source files the expander shows (no tests, declaration files or skipped dirs). */
export function isSourcePath(p: string): boolean {
	if (!ALL_SOURCE.test(p) || /\.d\.[cm]?ts$/.test(p)) return false
	const parts = p.split('/')
	parts.pop()
	return parts.every((s) => !skipDir(s))
}

const under = (p: string, dir: string) => dir === '' || p.startsWith(dir + '/')

/** Nearest directory at or above `path`'s directory holding a manifest. */
function packageDir(files: ScanFiles, path: string): string {
	let d = dirname(path)
	for (;;) {
		for (const m of ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'setup.py']) if (files.has(join(d, m))) return d
		if (d === '') return ''
		d = dirname(d)
	}
}

interface Resolver {
	resolve(from: string, spec: string): { file?: string; pkg?: string; workspace?: string }
}

/** Import resolution with tsconfig paths / go module per package, and workspace package names → dirs. */
export function makeResolver(files: ScanFiles): Resolver {
	const pkgDirs = new Map<string, string>()
	for (const [p, text] of files) {
		if (basename(p) !== 'package.json' || !text) continue
		const v = parseJsonLoose(text)
		const name = isObj(v) ? asStr(v.name) : undefined
		if (name && !pkgDirs.has(name)) pkgDirs.set(name, dirname(p))
	}
	const ctxCache = new Map<string, { tsPaths: TsPaths | null; goModule?: string; dir: string }>()
	const ctxOf = (from: string) => {
		const dir = packageDir(files, from)
		let c = ctxCache.get(dir)
		if (!c) {
			const gomod = files.get(join(dir, 'go.mod'))
			c = { dir, tsPaths: readTsPaths(files, dir), goModule: gomod ? /^module\s+(\S+)/m.exec(gomod)?.[1] : undefined }
			ctxCache.set(dir, c)
		}
		return c
	}
	return {
		resolve(from, spec) {
			const lang = langOfPath(from)
			if (!lang) return {}
			const r = resolveImport(files, from, spec, lang, ctxOf(from))
			if (r.pkg && pkgDirs.has(r.pkg)) return { workspace: r.pkg }
			if (lang === 'js' && !r.file && !r.pkg) {
				const pkg = packageOf(spec)
				if (pkg && pkgDirs.has(pkg)) return { workspace: pkg }
			}
			return r
		},
		...{ pkgDirs },
	} as Resolver & { pkgDirs: Map<string, string> }
}

function workspaceDir(r: Resolver, name: string): string | undefined {
	return (r as Resolver & { pkgDirs: Map<string, string> }).pkgDirs.get(name)
}

function externalOf(pkg: string): ExternalSystem | null {
	return externalFor(pkg) ?? externalFor(pkg.replace(/_/g, '-'))
}

/** What a src path points at. */
export function codeTarget(files: ScanFiles, path: string): 'file' | 'dir' | null {
	if (path !== '' && files.has(path)) return 'file'
	for (const p of files.keys()) if (under(p, path)) return 'dir'
	return null
}

function finish(g: ArchGraph, children: string[], notes: string[], warnings: string[] = []): ExpandedPage {
	const body = printOcto(graphToIR(g))
	return { body, children, findings: [{ analyzer: 'code', confidence: 0.8, notes }], warnings }
}

/** Keeps the `budget` best items (by score, then name); returns kept and folded. */
function cap<T>(items: T[], budget: number, score: (t: T) => number, name: (t: T) => string): { kept: T[]; folded: T[] } {
	if (items.length <= budget) return { kept: items, folded: [] }
	const sorted = [...items].sort((a, b) => score(b) - score(a) || name(a).localeCompare(name(b)))
	const keep = new Set(sorted.slice(0, Math.max(1, budget - 1)))
	return { kept: items.filter((t) => keep.has(t)), folded: items.filter((t) => !keep.has(t)) }
}

// ---------------------------------------------------------------------------

export function expandCode(files: ScanFiles, src: SrcRef, opts: CodeExpandOptions = {}): ExpandedPage | null {
	const max = Math.max(6, opts.maxNodes ?? 30)
	const scheme = opts.scheme ?? (src.scheme || 'local')
	const frag = src.fragment
	if (frag?.startsWith('uses:')) return expandUses(files, src.path, frag.slice(5), max, scheme)
	const target = codeTarget(files, src.path)
	if (!target) return null
	if (target === 'dir') return frag ? null : expandDir(files, src.path, max, scheme)
	if (frag) return expandSymbol(files, src.path, frag, max, scheme)
	return expandFile(files, src.path, max, scheme)
}

// ---------------------------------------------------------------------------
// directory

interface Entry {
	name: string
	path: string
	dir: boolean
	files: number
}

function dirEntries(files: ScanFiles, dir: string): Entry[] {
	const byName = new Map<string, Entry>()
	for (const p of files.keys()) {
		if (!under(p, dir) || !isSourcePath(p) || isTestPath(dir ? p.slice(dir.length + 1) : p)) continue
		const rest = dir ? p.slice(dir.length + 1) : p
		const slash = rest.indexOf('/')
		const name = slash < 0 ? rest : rest.slice(0, slash)
		const e = byName.get(name) ?? { name, path: join(dir, name), dir: slash >= 0, files: 0 }
		e.files++
		byName.set(name, e)
	}
	return [...byName.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
}

function expandDir(files: ScanFiles, dir0: string, max: number, scheme: string): ExpandedPage | null {
	let dir = dir0
	let entries = dirEntries(files, dir)
	// a lone `src/` (or any single folder) is not a useful page: show its contents
	const skipped: string[] = []
	for (let i = 0; i < 4 && entries.length === 1 && entries[0].dir; i++) {
		skipped.push(entries[0].name)
		dir = entries[0].path
		entries = dirEntries(files, dir)
	}
	if (!entries.length) return null
	const resolver = makeResolver(files)
	const entryOf = (p: string) => {
		const rest = dir ? p.slice(dir.length + 1) : p
		const name = rest.split('/')[0]
		return entries.find((e) => e.name === name)
	}
	const parent = dirname(dir)
	const outsideUnit = (p: string): string => {
		// `../dsl` for siblings of this dir, otherwise the two leading segments
		if (dir !== '' && under(p, parent)) {
			const rest = parent ? p.slice(parent.length + 1) : p
			return join(parent, rest.split('/')[0])
		}
		return p.split('/').slice(0, 2).join('/')
	}
	const edges = new Map<string, number>()
	const outside = new Map<string, Set<string>>() // unit path → entry names
	const workspaces = new Map<string, Set<string>>()
	const externals = new Map<string, { sys: ExternalSystem; from: Set<string> }>()
	let read = 0
	for (const [p, text] of files) {
		if (!text || !under(p, dir) || !isSourcePath(p) || isTestPath(p)) continue
		const from = entryOf(p)
		const lang = langOfPath(p)
		if (!from || !lang) continue
		read++
		for (const spec of extractImports(text, lang)) {
			const r = resolver.resolve(p, spec)
			if (r.file) {
				if (under(r.file, dir)) {
					const to = entryOf(r.file)
					if (to && to !== from) edges.set(`${from.name}\u0000${to.name}`, (edges.get(`${from.name}\u0000${to.name}`) ?? 0) + 1)
				} else {
					const u = outsideUnit(r.file)
					outside.set(u, new Set([...(outside.get(u) ?? []), from.name]))
				}
			} else if (r.workspace) {
				workspaces.set(r.workspace, new Set([...(workspaces.get(r.workspace) ?? []), from.name]))
			} else if (r.pkg) {
				const sys = externalOf(r.pkg)
				if (!sys) continue
				const e = externals.get(sys.system) ?? { sys, from: new Set<string>() }
				e.from.add(from.name)
				externals.set(sys.system, e)
			}
		}
	}
	const refBudget = Math.min(10, Math.max(2, Math.floor(max / 3)))
	const refs = [
		...[...externals.values()].map((e) => ({ kind: 'ext' as const, id: e.sys.system, from: e.from, sys: e.sys })),
		...[...workspaces].map(([name, from]) => ({ kind: 'ws' as const, id: name, from, sys: undefined })),
		...[...outside].map(([unit, from]) => ({ kind: 'dir' as const, id: unit, from, sys: undefined })),
	]
	const refCap = cap(refs, refBudget + 1, (r) => r.from.size * 2 + (r.kind === 'ext' ? 1 : 0), (r) => r.id)
	const keptRefs = refCap.folded.length ? refCap.kept.slice(0, refBudget) : refCap.kept
	const degree = new Map<string, number>(entries.map((e) => [e.name, e.files]))
	for (const k of edges.keys()) for (const n of k.split('\u0000')) degree.set(n, (degree.get(n) ?? 0) + 3)
	const entryCap = cap(entries, max - keptRefs.length, (e) => degree.get(e.name) ?? 0, (e) => e.name)

	const keys = new KeyAllocator()
	const nodes: ArchNode[] = []
	const keyOf = new Map<string, string>()
	for (const e of entryCap.kept) {
		const k = keys.take(e.name)
		keyOf.set(e.name, k)
		nodes.push({ key: k, label: e.dir ? `${e.name}/` : undefined, icon: e.dir ? CODE_ICONS.dir : CODE_ICONS.file, role: 'library', src: formatSrc(scheme, e.path), facts: e.dir ? [plural(e.files, 'file')] : [] })
	}
	if (entryCap.folded.length) {
		const k = keys.take('more')
		for (const e of entryCap.folded) keyOf.set(e.name, k)
		nodes.push({ key: k, label: `${entryCap.folded.length} more: ${entryCap.folded.slice(0, 4).map((e) => e.name).join(', ')}${entryCap.folded.length > 4 ? ', …' : ''}`, icon: 'layers', role: 'library' })
	}
	const children = entryCap.kept.map((e) => keyOf.get(e.name)!)
	const out: ArchEdge[] = []
	const seen = new Set<string>()
	for (const [k, n] of edges) {
		const [a, b] = k.split('\u0000').map((x) => keyOf.get(x)!)
		if (a === b || seen.has(`${a}\u0000${b}`)) continue
		seen.add(`${a}\u0000${b}`)
		out.push({ from: a, to: b, label: n >= 3 ? `${n} imports` : undefined })
	}
	for (const r of keptRefs) {
		let k: string
		if (r.kind === 'ext') {
			k = keys.take(r.id)
			nodes.push({ key: k, icon: r.sys!.icon, shape: r.sys!.shape, role: r.sys!.kind, src: formatSrc(scheme, dir, `uses:${r.id}`) })
		} else if (r.kind === 'ws') {
			const wsDir = workspaceDir(resolver, r.id)
			k = keys.take(r.id.replace(/^@[^/]+\//, ''))
			nodes.push({ key: k, label: k !== r.id ? r.id : undefined, icon: 'package', role: 'library', color: 'gray', src: wsDir !== undefined ? formatSrc(scheme, wsDir) : undefined })
		} else {
			const rel = dir !== '' && under(r.id, parent) ? `../${basename(r.id)}` : r.id
			k = keys.take(rel)
			nodes.push({ key: k, label: codeTarget(files, r.id) === 'dir' ? `${rel}/` : undefined, icon: codeTarget(files, r.id) === 'dir' ? CODE_ICONS.dir : CODE_ICONS.file, role: 'library', color: 'gray', src: formatSrc(scheme, r.id) })
		}
		for (const f of new Set([...r.from].map((x) => keyOf.get(x)!))) out.push({ from: f, to: k, dotted: r.kind !== 'ext' })
	}
	const notes = [`${dir || '(root)'}: ${plural(entries.length, 'entry', 'entries')}${entryCap.folded.length ? ` (${entryCap.folded.length} folded)` : ''}, ${plural(out.length, 'edge')}, ${plural(read, 'file')} read`]
	if (skipped.length) notes.push(`showing ${dir}/ (single folder ${skipped.join('/')})`)
	return finish({ nodes, edges: out }, children, notes)
}

// ---------------------------------------------------------------------------
// file

function symbolsOf(files: ScanFiles, path: string): FileSymbols | null {
	const text = files.get(path)
	if (text === undefined) return null
	return extractSymbols(path, text)
}

const isContainerSym = (s: CodeSymbol) => !!s.members?.length

/** Nodes for the files / workspaces / externals an import binding points at (shared by file and symbol pages). */
function importNodes(files: ScanFiles, path: string, fs: FileSymbols, keys: KeyAllocator, scheme: string, resolver: Resolver) {
	const byLocal = new Map<string, { target: string; node: () => ArchNode; imported: string }>()
	const made = new Map<string, ArchNode>()
	const dir = dirname(path)
	for (const b of fs.imports) {
		const r = resolver.resolve(path, b.spec)
		let id: string
		let make: () => ArchNode
		if (r.file) {
			id = `file:${r.file}`
			const rel = relPath(dir, r.file)
			make = () => ({ key: keys.take(rel), icon: CODE_ICONS.file, role: 'library', color: 'gray', src: formatSrc(scheme, r.file!) })
		} else if (r.workspace) {
			id = `ws:${r.workspace}`
			const wsDir = workspaceDir(resolver, r.workspace)
			make = () => {
				const k = keys.take(r.workspace!)
				return { key: k, icon: 'package', role: 'library', color: 'gray', src: wsDir !== undefined ? formatSrc(scheme, wsDir) : undefined }
			}
		} else if (r.pkg) {
			const sys = externalOf(r.pkg)
			if (!sys) continue
			id = `ext:${sys.system}`
			make = () => ({ key: keys.take(sys.system), icon: sys.icon, shape: sys.shape, role: sys.kind, src: formatSrc(scheme, packageDir(files, path), `uses:${sys.system}`) })
		} else continue
		byLocal.set(b.local, { target: id, imported: b.imported === 'default' || b.imported === '*' ? b.local : b.imported, node: () => {
			let n = made.get(id)
			if (!n) {
				n = make()
				made.set(id, n)
			}
			return n
		} })
	}
	return byLocal
}

function relPath(fromDir: string, to: string): string {
	const a = fromDir ? fromDir.split('/') : []
	const b = to.split('/')
	let i = 0
	while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
	const up = a.length - i
	return (up ? '../'.repeat(up) : './') + b.slice(i).join('/')
}

function symNode(s: CodeSymbol, key: string, scheme: string, path: string, fragment: string): ArchNode {
	return { key, icon: CODE_ICONS[s.kind] ?? 'code', color: KIND_COLOR[s.kind], role: 'library', src: formatSrc(scheme, path, fragment), facts: [s.kind] }
}

function expandFile(files: ScanFiles, path: string, max: number, scheme: string): ExpandedPage | null {
	const fs = symbolsOf(files, path)
	if (!fs) return null
	const resolver = makeResolver(files)
	const syms = fs.symbols
	if (!syms.length && !fs.imports.length) return null
	const keys = new KeyAllocator()
	const imports = importNodes(files, path, fs, keys, scheme, resolver)
	// importance: references in + out, members, exported
	const inDeg = new Map<string, number>()
	for (const s of syms) for (const r of s.refs) inDeg.set(r, (inDeg.get(r) ?? 0) + 1)
	const score = (s: CodeSymbol) => (inDeg.get(s.name) ?? 0) * 2 + s.refs.length + (s.members?.length ? 3 : 0) + (s.exported ? 2 : 0)
	const usedImports = new Set(syms.flatMap((s) => [...s.importRefs, ...(s.members ?? []).flatMap((m) => m.importRefs)]).filter((l) => imports.has(l)))
	const importTargets = [...new Set([...usedImports].map((l) => imports.get(l)!.target))]
	const refBudget = Math.min(10, Math.max(2, Math.floor(max / 3)))
	const keptTargets = new Set(importTargets.slice(0, refBudget))
	const symCap = cap(syms, max - keptTargets.size - 2, score, (s) => s.name)
	const exported = symCap.kept.filter((s) => s.exported)
	const internal = symCap.kept.filter((s) => !s.exported)
	const grouped = exported.length > 0 && internal.length > 0
	const nodes: ArchNode[] = []
	const keyOf = new Map<string, string>()
	if (grouped) {
		const ek = keys.take('exports')
		const ik = keys.take('internal')
		nodes.push({ key: ek, isContainer: true, role: 'group', color: 'blue' }, { key: ik, isContainer: true, role: 'group', color: 'gray' })
		for (const s of symCap.kept) {
			const k = keys.take(s.name)
			keyOf.set(s.name, k)
			nodes.push({ ...symNode(s, k, scheme, path, s.name), parent: s.exported ? ek : ik })
		}
	} else {
		for (const s of symCap.kept) {
			const k = keys.take(s.name)
			keyOf.set(s.name, k)
			nodes.push(symNode(s, k, scheme, path, s.name))
		}
	}
	if (symCap.folded.length) {
		const k = keys.take('more symbols')
		nodes.push({ key: k, label: `${symCap.folded.length} more: ${symCap.folded.slice(0, 4).map((s) => s.name).join(', ')}${symCap.folded.length > 4 ? ', …' : ''}`, icon: 'layers', role: 'library' })
	}
	const edges: ArchEdge[] = []
	for (const s of symCap.kept) {
		const from = keyOf.get(s.name)!
		const allRefs = new Set([...s.refs, ...(s.members ?? []).flatMap((m) => m.refs)])
		const calls = new Set([...s.calls, ...(s.members ?? []).flatMap((m) => m.calls)])
		for (const r of allRefs) {
			const to = keyOf.get(r)
			if (!to || to === from) continue
			edges.push({ from, to, dotted: !calls.has(r) })
		}
		for (const h of s.heritage ?? []) {
			const to = keyOf.get(h)
			if (to && to !== from) edges.push({ from, to, label: 'extends', dotted: true })
		}
		const names = new Map<string, string[]>()
		for (const l of new Set([...s.importRefs, ...(s.members ?? []).flatMap((m) => m.importRefs)])) {
			const imp = imports.get(l)
			if (!imp || !keptTargets.has(imp.target)) continue
			names.set(imp.target, [...(names.get(imp.target) ?? []), imp.imported])
		}
		for (const [target, ns] of names) {
			const imp = [...imports.values()].find((x) => x.target === target)!
			const node = imp.node()
			if (!nodes.includes(node)) nodes.push(node)
			edges.push({ from, to: node.key, dotted: true, label: ns.length <= 2 ? ns.join(', ') : `${ns.length} imports` })
		}
	}
	const children = symCap.kept.filter((s) => isContainerSym(s) || s.kind === 'function' || s.kind === 'method').map((s) => keyOf.get(s.name)!)
	const notes = [`${path}: ${plural(syms.length, 'symbol')} (${syms.filter((s) => s.exported).length} exported)${symCap.folded.length ? `, ${symCap.folded.length} folded` : ''}, ${plural(fs.imports.length, 'import')}`]
	return finish({ nodes, edges }, children, notes)
}

// ---------------------------------------------------------------------------
// symbol

function findSymbol(fs: FileSymbols, fragment: string): { sym: CodeSymbol; parent?: CodeSymbol } | null {
	const parts = fragment.split('.')
	let list = fs.symbols
	let parent: CodeSymbol | undefined
	let sym: CodeSymbol | undefined
	for (let i = 0; i < parts.length; i++) {
		// member names may contain dots (`[Symbol.iterator]`): try the longest join first
		let hit: CodeSymbol | undefined
		let used = 1
		for (let j = parts.length; j > i; j--) {
			const name = parts.slice(i, j).join('.')
			hit = list.find((s) => s.name === name)
			if (hit) {
				used = j - i
				break
			}
		}
		if (!hit) return null
		parent = sym
		sym = hit
		i += used - 1
		list = hit.members ?? []
	}
	return sym ? { sym, parent } : null
}

function expandSymbol(files: ScanFiles, path: string, fragment: string, max: number, scheme: string): ExpandedPage | null {
	const fs = symbolsOf(files, path)
	if (!fs) return null
	const hit = findSymbol(fs, fragment)
	if (!hit) return null
	const { sym, parent } = hit
	const resolver = makeResolver(files)
	const keys = new KeyAllocator()
	const imports = importNodes(files, path, fs, keys, scheme, resolver)
	const nodes: ArchNode[] = []
	const edges: ArchEdge[] = []
	const topNode = new Map<string, string>()
	const added = new Set<string>()
	const refBudget = Math.min(10, Math.max(3, Math.floor(max / 3)))
	let refCount = 0
	/** Gray reference to another top-level symbol of the file. */
	const topRef = (name: string): string | undefined => {
		if (name === sym.name && !parent) return undefined
		const have = topNode.get(name)
		if (have) return have
		const s = fs.symbols.find((x) => x.name === name)
		if (!s || refCount >= refBudget) return undefined
		refCount++
		const k = keys.take(name)
		topNode.set(name, k)
		nodes.push({ ...symNode(s, k, scheme, path, name), color: 'gray' })
		return k
	}
	const importRef = (local: string): { key: string; imported: string } | undefined => {
		const imp = imports.get(local)
		if (!imp) return undefined
		if (!added.has(imp.target)) {
			if (refCount >= refBudget) return undefined
			refCount++
			added.add(imp.target)
			nodes.push(imp.node())
		}
		return { key: imp.node().key, imported: imp.imported }
	}
	const linkImports = (from: string, locals: string[]) => {
		const names = new Map<string, string[]>()
		for (const l of locals) {
			const r = importRef(l)
			if (r) names.set(r.key, [...(names.get(r.key) ?? []), r.imported])
		}
		for (const [to, ns] of names) edges.push({ from, to, dotted: true, label: ns.length <= 2 ? ns.join(', ') : `${ns.length} imports` })
	}
	const base = parent ? `${fragment.slice(0, fragment.length - sym.name.length - 1)}` : ''
	if (sym.members?.length) {
		// container: members with calls between them
		const members = sym.members
		const inDeg = new Map<string, number>()
		for (const m of members) for (const r of m.memberRefs ?? []) inDeg.set(r, (inDeg.get(r) ?? 0) + 1)
		const memberCap = cap(members, max - Math.min(refBudget, 6) - 1, (m) => (inDeg.get(m.name) ?? 0) * 2 + (m.memberRefs?.length ?? 0) + (m.kind === 'property' ? 0 : 1), (m) => m.name)
		const keyOf = new Map<string, string>()
		for (const m of memberCap.kept) {
			const k = keys.take(m.name)
			keyOf.set(m.name, k)
			nodes.push(symNode(m, k, scheme, path, `${fragment}.${m.name}`))
		}
		if (memberCap.folded.length) {
			const k = keys.take('more members')
			nodes.push({ key: k, label: `${memberCap.folded.length} more: ${memberCap.folded.slice(0, 4).map((s) => s.name).join(', ')}${memberCap.folded.length > 4 ? ', …' : ''}`, icon: 'layers', role: 'library' })
		}
		for (const m of memberCap.kept) {
			const from = keyOf.get(m.name)!
			for (const r of m.memberRefs ?? []) {
				const to = keyOf.get(r)
				if (!to || to === from) continue
				const target = members.find((x) => x.name === r)
				edges.push({ from, to, dotted: target?.kind === 'property' })
			}
		}
		for (const m of memberCap.kept) {
			const from = keyOf.get(m.name)!
			for (const r of m.refs) {
				const to = topRef(r)
				if (to) edges.push({ from, to, dotted: !m.calls.includes(r) })
			}
			linkImports(from, m.importRefs)
		}
		for (const h of sym.heritage ?? []) {
			const k = topRef(h) ?? (imports.has(h) ? importRef(h)?.key : undefined)
			if (!k && refCount < refBudget) {
				refCount++
				nodes.push({ key: keys.take(h), label: `extends ${h}`, icon: CODE_ICONS.class, role: 'library', color: 'gray' })
			}
		}
		const children = memberCap.kept.filter((m) => m.kind !== 'property' || m.members?.length).map((m) => keyOf.get(m.name)!)
		const notes = [`${path}#${fragment}: ${sym.kind} with ${plural(members.length, 'member')}${memberCap.folded.length ? ` (${memberCap.folded.length} folded)` : ''}`]
		return finish({ nodes, edges }, children, notes)
	}

	// leaf symbol: callers ← symbol → callees
	const self = keys.take(sym.name)
	nodes.push({ ...symNode(sym, self, scheme, path, fragment) })
	const siblings = parent?.members ?? []
	if (parent) {
		for (const r of sym.memberRefs ?? []) {
			const m = siblings.find((x) => x.name === r)
			if (!m || m === sym || refCount >= refBudget) continue
			refCount++
			const k = keys.take(r)
			nodes.push({ ...symNode(m, k, scheme, path, `${base}.${r}`), color: 'gray' })
			edges.push({ from: self, to: k, dotted: m.kind === 'property' })
		}
		for (const m of siblings) {
			if (m === sym || !(m.memberRefs ?? []).includes(sym.name) || refCount >= refBudget) continue
			refCount++
			const k = keys.take(m.name)
			nodes.push({ ...symNode(m, k, scheme, path, `${base}.${m.name}`), color: 'gray' })
			edges.push({ from: k, to: self })
		}
	}
	for (const r of sym.refs) {
		const to = topRef(r)
		if (to) edges.push({ from: self, to, dotted: !sym.calls.includes(r) })
	}
	linkImports(self, sym.importRefs)
	// callers among top-level symbols (and their members)
	for (const s of fs.symbols) {
		if (s === sym || s === parent) continue
		const uses = s.refs.includes(parent ? parent.name : sym.name) || (s.members ?? []).some((m) => m.refs.includes(parent ? parent.name : sym.name))
		if (!uses || parent) continue
		const k = topRef(s.name)
		if (k) edges.push({ from: k, to: self, dotted: !(s.calls.includes(sym.name) || (s.members ?? []).some((m) => m.calls.includes(sym.name))) })
	}
	const notes = [`${path}#${fragment}: ${sym.kind}, ${plural(sym.refs.length + (sym.memberRefs?.length ?? 0), 'reference')}, ${plural(sym.importRefs.length, 'imported name')}`]
	return finish({ nodes, edges }, [], notes)
}

// ---------------------------------------------------------------------------
// users of an external system

function expandUses(files: ScanFiles, dir: string, system: string, max: number, scheme: string): ExpandedPage | null {
	const resolver = makeResolver(files)
	const users: string[] = []
	let sys: ExternalSystem | null = null
	for (const [p, text] of files) {
		if (!text || !under(p, dir) || !isSourcePath(p) || isTestPath(p)) continue
		const lang = langOfPath(p)
		if (!lang) continue
		for (const spec of extractImports(text, lang)) {
			const r = resolver.resolve(p, spec)
			const s = r.pkg ? externalOf(r.pkg) : null
			if (s && s.system.toLowerCase() === system.toLowerCase()) {
				sys = s
				users.push(p)
				break
			}
		}
	}
	if (!sys || !users.length) return null
	const keys = new KeyAllocator()
	const sk = keys.take(sys.system)
	const nodes: ArchNode[] = [{ key: sk, icon: sys.icon, shape: sys.shape, role: sys.kind }]
	const edges: ArchEdge[] = []
	const c = cap(users, max - 1, () => 0, (p) => p)
	for (const p of c.kept) {
		const k = keys.take(dir ? p.slice(dir.length + 1) : p)
		nodes.push({ key: k, icon: CODE_ICONS.file, role: 'library', src: formatSrc(scheme, p) })
		edges.push({ from: k, to: sk })
	}
	if (c.folded.length) {
		const k = keys.take('more files')
		nodes.push({ key: k, label: `${c.folded.length} more files`, icon: 'layers', role: 'library' })
		edges.push({ from: k, to: sk })
	}
	return finish({ nodes, edges }, [], [`${sys.system}: used by ${plural(users.length, 'file')} under ${dir || '(root)'}`])
}

