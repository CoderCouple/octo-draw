/**
 * Code repo / monorepo analyzer.
 *
 * Root page: one node per workspace (service, frontend, CLI or library), edges
 * from internal workspace dependencies and from `localhost:<port>` references
 * to a server's port, plus the external systems inferred from dependencies.
 * Each workspace gets a page with its internal module graph (top-level dirs /
 * files under `src`, import edges aggregated, capped) and the externals each
 * module imports.
 */

import { emptyResult, type AnalyzerResult, type ArchEdge, type ArchNode, type ArchPage, type NodeRole, type ScanFiles } from '../../types'
import { asObj, asStr, basename, dirname, join, KeyAllocator, plural, uniq, within } from '../../util'
import { externalFor, type ExternalSystem } from './externals'
import { extractImports, isTestPath, readTsPaths, resolveImport, SOURCE_EXT } from './imports'
import { findWorkspaces, type Lang, type Workspace } from './workspaces'

export { findWorkspaces, type Workspace } from './workspaces'
export { externalFor, EXTERNALS } from './externals'

export interface CodeMeta {
	workspaces: { key: string; name: string; dir: string; page?: string }[]
}

interface Profile {
	ws: Workspace
	key: string
	role: NodeRole
	icon: string
	label?: string
	ports: string[]
	facts: string[]
	/** Ports this workspace talks to on localhost (`http://localhost:8787`). */
	calls: string[]
	files: string[]
	externals: Map<string, ExternalSystem>
	/** Workspace names this one depends on. */
	internal: Set<string>
}

const FRONTEND: [string, string][] = [
	['next', 'nextjs'],
	['nuxt', 'nuxt'],
	['@sveltejs/kit', 'svelte'],
	['astro', 'astro'],
	['@remix-run/react', 'react'],
	['@angular/core', 'angular'],
	['vue', 'vue'],
	['svelte', 'svelte'],
	['react-native', 'react'],
	['expo', 'expo'],
	['react', 'react'],
	['solid-js', 'app'],
]

const SERVER_DEPS: [string, string][] = [
	['@nestjs/core', 'nestjs'],
	['express', 'express'],
	['fastify', 'nodejs'],
	['hono', 'nodejs'],
	['koa', 'nodejs'],
	['@hapi/hapi', 'nodejs'],
	['elysia', 'bun'],
	['@trpc/server', 'nodejs'],
	['ws', 'nodejs'],
	['socket.io', 'socketio'],
	['fastapi', 'fastapi'],
	['flask', 'flask'],
	['django', 'django'],
	['starlette', 'python'],
	['aiohttp', 'python'],
	['uvicorn', 'python'],
	['github.com/gin-gonic/gin', 'go'],
	['github.com/labstack/echo/v4', 'go'],
	['github.com/gofiber/fiber/v2', 'go'],
	['github.com/go-chi/chi/v5', 'go'],
	['github.com/gorilla/mux', 'go'],
	['axum', 'rust'],
	['actix-web', 'rust'],
	['rocket', 'rust'],
	['warp', 'rust'],
]

const SERVER_CODE = /\b(?:http|https|http2)\.createServer\s*\(|\bcreateServer\s*\(|\bBun\.serve\s*\(|\bDeno\.serve\s*\(|\bapp\.listen\s*\(|\bserver\.listen\s*\(|\bhttp\.ListenAndServe(TLS)?\s*\(|\buvicorn\.run\s*\(|\bapp\.run\s*\(|HttpServer:{2}new|axum:{2}serve/
const PORT_CODE = [/\.listen\(\s*(\d{2,5})\b/g, /\bPORT\b[^\n]{0,40}?(?:\?\?|\|\||,|=)\s*['"]?(\d{4,5})\b/g, /ListenAndServe\(\s*"[^"]*:(\d{2,5})"/g, /port\s*[=:]\s*(\d{4,5})\b/gi]
const LOCAL_URL = /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/g
const LANG_ICON: Record<Lang, string> = { js: 'nodejs', go: 'go', python: 'python', rust: 'rust' }

/** Drops comments so examples in docs (`// listens on http://localhost:3000`) don't count. */
function stripComments(t: string, lang: Lang): string {
	if (lang === 'python') return t.replace(/^\s*#.*$/gm, '').replace(/^\s*("""|''')[\s\S]*?\1/gm, '')
	return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1')
}

const low = (s: string) => s.toLowerCase()

function shortName(name: string): string {
	const base = name.replace(/^@[^/]+\//, '')
	return base.includes('/') ? basename(base) : base
}

function sourceFiles(files: ScanFiles, ws: Workspace, nested: string[]): string[] {
	const ext = SOURCE_EXT[ws.lang]
	return [...files.keys()].filter((p) => within(p, ws.dir) && ext.test(p) && !nested.some((n) => within(p, n)) && !isTestPath(p.slice(ws.dir ? ws.dir.length + 1 : 0)))
}

function profile(files: ScanFiles, ws: Workspace, nested: string[]): Omit<Profile, 'key'> {
	const deps = new Set(ws.deps)
	const allDeps = new Set([...ws.deps, ...ws.devDeps])
	const src = sourceFiles(files, ws, nested)
	const facts: string[] = []
	const ports = new Set<string>()
	const calls = new Set<string>()
	let role: NodeRole = 'library'
	let icon = ws.lang === 'js' ? 'package' : LANG_ICON[ws.lang]
	const fe = FRONTEND.find(([d]) => allDeps.has(d))
	const srv = SERVER_DEPS.find(([d]) => deps.has(d))
	let serverCode = false
	for (const f of src) {
		const t = stripComments(files.get(f) ?? '', ws.lang)
		if (SERVER_CODE.test(t)) serverCode = true
		for (const re of PORT_CODE) for (const m of t.matchAll(re)) if (SERVER_CODE.test(t)) ports.add(m[1])
		for (const m of t.matchAll(LOCAL_URL)) calls.add(m[1])
	}
	// configs next to the package (vite proxy, next rewrites, .env.example is never read)
	for (const p of files.keys()) {
		if (dirname(p) !== ws.dir || !/^(vite|next|nuxt|astro|svelte|webpack)\.config\.[cm]?[jt]s$/.test(basename(p))) continue
		for (const m of (files.get(p) ?? '').matchAll(LOCAL_URL)) calls.add(m[1])
	}
	const docker = files.get(join(ws.dir, 'Dockerfile'))
	if (docker) {
		facts.push('Dockerfile')
		for (const m of docker.matchAll(/^\s*EXPOSE\s+([\d\s/a-z]+)/gim)) for (const p of m[1].split(/\s+/)) if (/^\d+/.test(p)) ports.add(p.replace(/\/.*/, ''))
	}
	const pkg = ws.pkg ?? {}
	const bin = typeof pkg.bin === 'string' ? [pkg.bin] : Object.keys(asObj(pkg.bin))
	const scripts = asObj(pkg.scripts)
	const strongFe = fe && ['next', 'nuxt', '@sveltejs/kit', 'astro', '@remix-run/react', '@angular/core', 'react-native', 'expo'].includes(fe[0])
	const bundled = ['vite', 'webpack', 'parcel', '@rsbuild/core', 'react-scripts'].some((d) => allDeps.has(d)) || files.has(join(ws.dir, 'index.html'))
	if (fe && !srv && (strongFe || bundled)) {
		role = 'frontend'
		icon = fe[1]
		facts.push(`${fe[0]} app`)
	} else if (srv) {
		role = 'service'
		icon = srv[1]
		facts.push(`${srv[0]} server`)
	} else if (bin.length) {
		role = 'service'
		icon = 'terminal'
		facts.push(`CLI (${bin.join(', ')})`)
	} else if (serverCode) {
		role = 'service'
		icon = LANG_ICON[ws.lang]
		facts.push('HTTP server')
	} else if (ws.lang === 'go' && src.some((f) => /^package main\b/m.test(files.get(f) ?? ''))) {
		role = 'service'
		icon = 'go'
		facts.push('Go main package')
	} else if (ws.lang === 'python' && src.some((f) => basename(f) === '__main__.py' || /if __name__ == ['"]__main__['"]/.test(files.get(f) ?? ''))) {
		role = 'service'
		facts.push('Python entrypoint')
	} else if (asStr(scripts.start)) role = 'service'
	else if (fe) {
		icon = fe[1]
		facts.push(`${fe[0]} components`)
	}
	if (allDeps.has('electron')) {
		role = 'frontend'
		icon = 'electron'
	}
	if (deps.has('@modelcontextprotocol/sdk')) facts.push('MCP server')
	if (asStr(scripts.start)) facts.push(`start: ${asStr(scripts.start)}`)
	if (ports.size) facts.push(`port ${[...ports].join(', ')}`)
	const externals = new Map<string, ExternalSystem>()
	for (const d of ws.deps) {
		const e = externalFor(d)
		if (e && !externals.has(e.system)) externals.set(e.system, e)
	}
	return { ws, role, icon, ports: [...ports], facts, calls: [...calls], files: src, externals, internal: new Set() }
}

// ---------------------------------------------------------------------------
// Module graph of one workspace

interface ModuleGraph {
	page: ArchPage
	notes: string[]
}

function moduleRoot(files: string[], ws: Workspace): string {
	for (const d of ['src', 'lib', 'app', 'pkg', 'internal']) {
		const r = join(ws.dir, d)
		if (files.filter((f) => within(f, r)).length >= Math.max(1, files.length * 0.5)) return r
	}
	if (ws.lang === 'python') {
		const name = join(ws.dir, ws.name.replace(/-/g, '_'))
		if (files.some((f) => within(f, name))) return name
		// a single top-level package (`ml/__init__.py`)
		const pkgs = uniq(files.filter((f) => basename(f) === '__init__.py' && dirname(dirname(f)) === ws.dir).map(dirname))
		if (pkgs.length === 1) return pkgs[0]
	}
	return ws.dir
}

function unitOf(rel: string, expanded: Set<string>): string {
	const parts = rel.split('/')
	let i = 1
	while (i < parts.length && expanded.has(parts.slice(0, i).join('/'))) i++
	const unit = parts.slice(0, i).join('/')
	return i === parts.length ? unit.replace(/\.[a-z]+$/i, '').replace(/\/(index|mod|__init__)$/, '') : unit
}

function moduleGraph(files: ScanFiles, p: Profile, byName: Map<string, Profile>, byDir: [string, Profile][], pageName: string, max: number): ModuleGraph {
	const ws = p.ws
	const root = moduleRoot(p.files, ws)
	const inRoot = p.files.filter((f) => within(f, root) && (files.get(f) ?? '').trim() !== '')
	const rel = (f: string) => (root ? f.slice(root.length + 1) : f)
	const tsPaths = ws.lang === 'js' ? readTsPaths(files, ws.dir) : null
	const goModule = ws.goModule

	// raw import facts per file
	const fileEdges: { from: string; toFile?: string; pkg?: string }[] = []
	for (const f of inRoot) {
		for (const spec of extractImports(files.get(f) ?? '', ws.lang)) {
			const r = resolveImport(files, f, spec, ws.lang, { tsPaths, goModule, dir: ws.dir })
			if (r.file) fileEdges.push({ from: f, toFile: r.file })
			else if (r.pkg) fileEdges.push({ from: f, pkg: r.pkg })
		}
	}

	// adaptive depth: expand the biggest directory while the page stays small
	const expanded = new Set<string>()
	const units = () => new Set(inRoot.map((f) => unitOf(rel(f), expanded)))
	for (let guard = 0; guard < 20; guard++) {
		const u = units()
		if (u.size >= 6) break
		const counts = new Map<string, number>()
		for (const f of inRoot) {
			const unit = unitOf(rel(f), expanded)
			if (rel(f).length > unit.length && rel(f).startsWith(unit + '/')) counts.set(unit, (counts.get(unit) ?? 0) + 1)
		}
		const best = [...counts].sort((a, b) => b[1] - a[1])[0]
		if (!best || best[1] < 2) break
		const trial = new Set(expanded).add(best[0])
		const next = new Set(inRoot.map((f) => unitOf(rel(f), trial)))
		if (next.size > max) break
		expanded.add(best[0])
	}

	const unitFiles = new Map<string, number>()
	const isDir = new Set<string>()
	const unitFile = new Map<string, string>()
	for (const f of inRoot) {
		const u = unitOf(rel(f), expanded)
		unitFiles.set(u, (unitFiles.get(u) ?? 0) + 1)
		if (rel(f).replace(/\.[a-z]+$/i, '') !== u && !/\/(index|mod|__init__)\.[a-z]+$/.test(rel(f))) isDir.add(u)
		if (!unitFile.has(u)) unitFile.set(u, f)
	}
	/** Repo-relative path a unit stands for: its directory, or its single file. */
	const unitSrc = (u: string) => {
		if (isDir.has(u)) return join(root, u)
		const f = unitFile.get(u)!
		// `routes/index.ts` stands for the `routes` folder when that folder holds only it
		return unitFiles.get(u)! > 1 ? dirname(f) : f
	}

	// aggregate edges to unit level
	const modEdges = new Map<string, number>()
	const extUse = new Map<string, Set<string>>() // external system -> units
	const wsUse = new Map<string, Set<string>>() // workspace key -> units
	const extSys = new Map<string, ExternalSystem>()
	for (const e of fileEdges) {
		const from = unitOf(rel(e.from), expanded)
		if (e.toFile) {
			if (within(e.toFile, root) && inRoot.includes(e.toFile)) {
				const to = unitOf(rel(e.toFile), expanded)
				if (to !== from) modEdges.set(`${from}\u0000${to}`, (modEdges.get(`${from}\u0000${to}`) ?? 0) + 1)
			} else {
				const other = byDir.find(([d]) => d !== ws.dir && within(e.toFile!, d))?.[1]
				if (other && other !== p) wsUse.set(other.key, new Set([...(wsUse.get(other.key) ?? []), from]))
			}
			continue
		}
		const pkg = e.pkg!
		const other = byName.get(pkg) ?? (ws.lang === 'go' ? [...byName.values()].find((o) => o.ws.goModule && (pkg === o.ws.goModule || pkg.startsWith(o.ws.goModule + '/'))) : undefined)
		if (other && other !== p) {
			wsUse.set(other.key, new Set([...(wsUse.get(other.key) ?? []), from]))
			p.internal.add(other.ws.name)
			continue
		}
		const sys = externalFor(pkg) ?? (ws.lang === 'python' ? externalFor(pkg.replace(/_/g, '-')) : null) ?? (ws.lang === 'go' ? externalForGo(pkg, ws.deps) : null)
		if (sys) {
			extSys.set(sys.system, sys)
			extUse.set(sys.system, new Set([...(extUse.get(sys.system) ?? []), from]))
		}
	}

	// cap: keep the most connected units, fold the rest into one node
	let kept = [...unitFiles.keys()]
	let folded: string[] = []
	const budget = Math.max(3, max - extSys.size - wsUse.size)
	if (kept.length > budget) {
		const degree = new Map<string, number>(kept.map((u) => [u, unitFiles.get(u)!]))
		for (const k of modEdges.keys()) {
			const [a, b] = k.split('\u0000')
			degree.set(a, degree.get(a)! + 2)
			degree.set(b, degree.get(b)! + 2)
		}
		kept.sort((a, b) => degree.get(b)! - degree.get(a)! || a.localeCompare(b))
		folded = kept.slice(budget - 1)
		kept = kept.slice(0, budget - 1)
	}
	const keys = new KeyAllocator()
	const unitKey = new Map<string, string>()
	const nodes: ArchNode[] = []
	const entry = entryUnits(p, root, expanded)
	for (const u of kept.sort()) {
		const k = keys.take(u)
		unitKey.set(u, k)
		const dir = isDir.has(u)
		const n = unitFiles.get(u)!
		nodes.push({
			key: k,
			label: dir ? `${u}/` : undefined,
			icon: entry.has(u) && p.role !== 'library' ? p.icon : dir ? 'box' : 'file-code',
			role: 'library',
			facts: dir ? [plural(n, 'file')] : [],
			src: unitSrc(u),
		})
	}
	if (folded.length) {
		const k = keys.take('other modules')
		for (const u of folded) unitKey.set(u, k)
		nodes.push({ key: k, label: `${folded.length} more modules`, icon: 'layers', role: 'library', facts: folded })
	}
	const edges: ArchEdge[] = []
	const seen = new Set<string>()
	for (const [k, n] of modEdges) {
		const [a, b] = k.split('\u0000').map((u) => unitKey.get(u)!)
		if (a === b || seen.has(`${a}\u0000${b}`)) continue
		seen.add(`${a}\u0000${b}`)
		edges.push({ from: a, to: b, label: n >= 5 ? `${n} imports` : undefined })
	}
	for (const [wsKey, us] of wsUse) {
		const other = [...byName.values()].find((o) => o.key === wsKey)!
		const k = keys.take(wsKey)
		nodes.push({ key: k, label: other.ws.name, icon: other.icon, role: other.role, color: 'gray', facts: ['workspace package'], src: other.ws.dir || '.' })
		for (const u of uniq([...us].map((x) => unitKey.get(x)!))) edges.push({ from: u, to: k, dotted: true })
	}
	for (const [sys, us] of extUse) {
		const e = extSys.get(sys)!
		const k = keys.take(sys)
		nodes.push({ key: k, icon: e.icon, shape: e.shape, role: e.kind, tech: e.tech, src: `${ws.dir}#uses:${sys}` })
		for (const u of uniq([...us].map((x) => unitKey.get(x)!))) edges.push({ from: u, to: k })
	}
	// externals declared but not seen in imports (config-only use) are still shown on the root page only
	const notes = [`${ws.name}: ${plural(kept.length + folded.length, 'module')}${folded.length ? ` (${folded.length} folded)` : ''}, ${plural(edges.length, 'edge')}`]
	return { page: { name: pageName, analyzer: 'code', nodes, edges }, notes }
}

function externalForGo(path: string, deps: string[]): ExternalSystem | null {
	const dep = deps.filter((d) => path === d || path.startsWith(d + '/')).sort((a, b) => b.length - a.length)[0]
	return dep ? externalFor(path) ?? externalFor(dep) : externalFor(path)
}

/** Units holding the package entrypoints (main, bin, index, cmd). */
function entryUnits(p: Profile, root: string, expanded: Set<string>): Set<string> {
	const out = new Set<string>()
	const pkg = p.ws.pkg ?? {}
	const cands = [asStr(pkg.main), asStr(pkg.module), ...(typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(asObj(pkg.bin)).map(String))].filter((x): x is string => !!x)
	for (const c of cands) {
		const f = join(p.ws.dir, c)
		if (within(f, root) && root) out.add(unitOf(f.slice(root.length + 1), expanded))
	}
	for (const name of ['index', 'main', 'server', 'app', '__main__', 'cmd']) {
		for (const f of p.files) if (within(f, root) && dirname(f) === root && basename(f).replace(/\.[a-z]+$/i, '') === name) out.add(unitOf(root ? f.slice(root.length + 1) : f, expanded))
	}
	return out
}

// ---------------------------------------------------------------------------

export function analyzeCode(files: ScanFiles, opts: { maxModuleNodes?: number } = {}): AnalyzerResult {
	const r = emptyResult('code')
	const { sources, workspaces } = findWorkspaces(files)
	if (!workspaces.length) return r
	const max = opts.maxModuleNodes ?? 25
	const dirs = workspaces.map((w) => w.dir)
	const keys = new KeyAllocator(['Users', 'Internet'])
	const shortCounts = new Map<string, number>()
	for (const w of workspaces) shortCounts.set(shortName(w.name).toLowerCase(), (shortCounts.get(shortName(w.name).toLowerCase()) ?? 0) + 1)
	const profiles: Profile[] = workspaces.map((ws) => {
		const nested = dirs.filter((d) => d !== ws.dir && within(d, ws.dir))
		const base = profile(files, ws, nested)
		const short = shortName(ws.name)
		const key = keys.take(workspaces.length === 1 || shortCounts.get(short.toLowerCase())! > 1 ? (shortCounts.get(short.toLowerCase())! > 1 ? ws.name : short) : short)
		return { ...base, key, label: key !== ws.name ? ws.name : undefined }
	})
	const byName = new Map(profiles.map((p) => [p.ws.name, p]))
	const byDir: [string, Profile][] = profiles.map((p) => [p.ws.dir, p] as [string, Profile]).sort((a, b) => b[0].length - a[0].length)

	// internal dependencies from manifests
	for (const p of profiles) for (const d of [...p.ws.deps, ...p.ws.devDeps]) if (byName.has(d) && d !== p.ws.name) p.internal.add(d)
	if (profiles.some((p) => p.ws.lang === 'go')) {
		for (const p of profiles) for (const d of p.ws.deps) for (const o of profiles) if (o !== p && o.ws.goModule && d === o.ws.goModule) p.internal.add(o.ws.name)
	}

	// module pages
	const pages: ArchPage[] = []
	const pageOf = new Map<Profile, string>()
	for (const p of profiles) {
		if (p.files.length < 2) continue
		const name = `${p.key} modules`
		const g = moduleGraph(files, p, byName, byDir, name, max)
		if (g.page.nodes.length < 2) continue
		pages.push(g.page)
		pageOf.set(p, name)
		r.notes.push(...g.notes)
	}

	// root nodes; group by top-level dir in larger monorepos
	const nodes: ArchNode[] = []
	const edges: ArchEdge[] = []
	const top = (d: string) => d.split('/')[0]
	const groupDirs = uniq(profiles.map((p) => p.ws.dir).filter(Boolean).map(top))
	const useGroups = profiles.length >= 5 && groupDirs.length >= 2 && profiles.every((p) => p.ws.dir.includes('/'))
	const groupKey = new Map<string, string>()
	if (useGroups) for (const g of groupDirs) {
		const k = keys.take(g)
		groupKey.set(g, k)
		nodes.push({ key: k, label: `${g}/`, role: 'group', isContainer: true, src: g })
	}
	for (const p of profiles) {
		nodes.push({
			key: p.key,
			label: p.label,
			icon: p.icon,
			role: p.role,
			parent: useGroups ? groupKey.get(top(p.ws.dir)) : undefined,
			drill: pageOf.get(p),
			aliases: uniq([p.ws.name, shortName(p.ws.name), p.ws.dir, basename(p.ws.dir)].filter(Boolean)),
			dir: p.ws.dir,
			facts: [`${p.ws.lang} package at ${p.ws.dir || '.'}`, ...p.facts],
			src: p.ws.dir || '.',
		})
	}
	for (const p of profiles) for (const d of p.internal) edges.push({ from: p.key, to: byName.get(d)!.key })

	// localhost:<port> references → the server listening there
	const portOwner = new Map<string, Profile>()
	for (const p of profiles) for (const port of p.ports) if (p.role === 'service') portOwner.set(port, p)
	const called = new Set<Profile>()
	for (const p of profiles) {
		for (const port of p.calls) {
			const s = portOwner.get(port)
			if (!s || s === p) continue
			called.add(s)
			if (!edges.some((e) => e.from === p.key && e.to === s.key && e.label)) edges.push({ from: p.key, to: s.key, label: `HTTP :${port}` })
		}
	}
	// `<name>-client` / `<name>-sdk` packages talk to the `<name>` service
	for (const p of profiles) {
		const m = /^(.+?)[-_](client|sdk)$/.exec(shortName(p.ws.name))
		const s = m && profiles.find((o) => o !== p && o.role === 'service' && low(shortName(o.ws.name)) === low(m[1]))
		if (s && !edges.some((e) => e.from === p.key && e.to === s.key)) {
			edges.push({ from: p.key, to: s.key, label: 'HTTP', dotted: true })
			called.add(s)
		}
	}
	const frontends = profiles.filter((p) => p.role === 'frontend')
	const servers = profiles.filter((p) => p.role === 'service' && p.facts.some((f) => /server$/.test(f)))
	const entryTargets = frontends.length ? frontends : servers.filter((s) => !called.has(s))
	if (entryTargets.length) {
		nodes.unshift({ key: 'Users', icon: 'users', shape: 'oval', role: 'client' })
		for (const t of entryTargets) edges.push({ from: 'Users', to: t.key, label: t.role === 'service' && t.ports.length ? `HTTP :${t.ports[0]}` : undefined })
	}

	// external systems (shared nodes)
	const extKey = new Map<string, string>()
	for (const p of profiles) {
		for (const e of p.externals.values()) {
			if (!extKey.has(e.system)) {
				const k = keys.take(e.system)
				extKey.set(e.system, k)
				nodes.push({ key: k, icon: e.icon, shape: e.shape, role: e.kind, tech: e.tech, aliases: [e.system], src: `#uses:${e.system}` })
			}
			edges.push({ from: p.key, to: extKey.get(e.system)! })
		}
	}

	r.root = { nodes, edges }
	r.pages = pages
	r.confidence = sources.length ? 0.8 : profiles.length === 1 ? 0.6 : 0.5
	r.notes.unshift(`${plural(profiles.length, 'package')}${sources.length ? ` from ${sources.join(', ')}` : ''}: ${profiles.map((p) => `${p.key} (${p.role})`).join(', ')}`)
	if (extKey.size) r.notes.push(`external systems from dependencies: ${[...extKey.keys()].join(', ')}`)
	r.meta = { workspaces: profiles.map((p) => ({ key: p.key, name: p.ws.name, dir: p.ws.dir, page: pageOf.get(p) })) } satisfies CodeMeta
	return r
}
