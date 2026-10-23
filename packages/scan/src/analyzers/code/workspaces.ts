/**
 * Workspace discovery: pnpm-workspace.yaml, package.json `workspaces`,
 * go.work, Cargo `[workspace] members`, and Python projects (pyproject.toml /
 * setup.py / requirements.txt) in subdirectories. Falls back to the root as a
 * single package.
 */

import type { ScanFiles } from '../../types'
import { allDirs, asArr, asObj, asStr, basename, isObj, join, matchDirs, parseJsonLoose, parseYaml, uniq } from '../../util'

export type Lang = 'js' | 'go' | 'python' | 'rust'

export interface Workspace {
	/** Package name (`@octo-draw/server`, Go module path, crate / project name). */
	name: string
	dir: string
	lang: Lang
	/** Runtime dependencies (names). */
	deps: string[]
	/** Dev-only dependencies (used for internal edges, not external systems). */
	devDeps: string[]
	/** package.json, if any. */
	pkg?: Record<string, unknown>
	/** Go module path, for import resolution. */
	goModule?: string
}

export interface WorkspaceScan {
	/** Which manifest(s) defined the workspace (`pnpm-workspace.yaml`, `go.work`, ...); empty for a single package. */
	sources: string[]
	workspaces: Workspace[]
}

function readPkg(files: ScanFiles, dir: string): Record<string, unknown> | null {
	const v = parseJsonLoose(files.get(join(dir, 'package.json')) ?? '')
	return isObj(v) ? v : null
}

function jsWorkspace(files: ScanFiles, dir: string): Workspace | null {
	const pkg = readPkg(files, dir)
	if (!pkg) return null
	const keys = (o: unknown) => Object.keys(asObj(o))
	return {
		name: asStr(pkg.name) ?? (basename(dir) || 'root'),
		dir,
		lang: 'js',
		deps: uniq([...keys(pkg.dependencies), ...keys(pkg.peerDependencies), ...keys(pkg.optionalDependencies)]),
		devDeps: keys(pkg.devDependencies),
		pkg,
	}
}

function goWorkspace(files: ScanFiles, dir: string): Workspace | null {
	const mod = files.get(join(dir, 'go.mod'))
	if (mod === undefined) return null
	const module = /^module\s+(\S+)/m.exec(mod)?.[1] ?? basename(dir)
	const deps: string[] = []
	for (const m of mod.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[\w.+-]+(\s*\/\/\s*indirect)?/gm)) if (!m[2]) deps.push(m[1])
	return { name: module, dir, lang: 'go', deps: uniq(deps), devDeps: [], goModule: module }
}

/** Requirement name from a PEP 508 string (`fastapi[all]>=0.110` → `fastapi`). */
const reqName = (s: string) => s.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1]?.toLowerCase()

function pyWorkspace(files: ScanFiles, dir: string): Workspace | null {
	const py = files.get(join(dir, 'pyproject.toml'))
	const req = files.get(join(dir, 'requirements.txt'))
	const setup = files.get(join(dir, 'setup.py'))
	if (py === undefined && req === undefined && setup === undefined) return null
	const deps: string[] = []
	let name = basename(dir) || 'root'
	if (py) {
		name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(py)?.[1] ?? name
		// PEP 621 `dependencies = [ ... ]`
		const arr = /^\s*dependencies\s*=\s*\[((?:\s*(?:"[^"]*"|'[^']*'|#[^\n]*)\s*,?)*)\s*\]/m.exec(py)?.[1]
		if (arr) for (const m of arr.matchAll(/["']([^"']+)["']/g)) deps.push(reqName(m[1]) ?? '')
		// Poetry `[tool.poetry.dependencies]`
		const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/.exec(py)?.[1]
		if (poetry) for (const m of poetry.matchAll(/^\s*([A-Za-z0-9._-]+)\s*=/gm)) if (m[1] !== 'python') deps.push(m[1].toLowerCase())
	}
	if (req) for (const line of req.split('\n')) if (line.trim() && !/^\s*[#-]/.test(line)) deps.push(reqName(line) ?? '')
	if (setup) {
		name = /name\s*=\s*["']([^"']+)["']/.exec(setup)?.[1] ?? name
		const arr = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(setup)?.[1]
		if (arr) for (const m of arr.matchAll(/["']([^"']+)["']/g)) deps.push(reqName(m[1]) ?? '')
	}
	return { name, dir, lang: 'python', deps: uniq(deps.filter(Boolean)), devDeps: [] }
}

function rustWorkspace(files: ScanFiles, dir: string): Workspace | null {
	const toml = files.get(join(dir, 'Cargo.toml'))
	if (toml === undefined || !/^\[package\]/m.test(toml)) return null
	const name = /\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? basename(dir)
	const section = (h: string) => new RegExp(`^\\[${h}\\]([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(toml)?.[1] ?? ''
	const names = (s: string) => [...s.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1])
	return { name, dir, lang: 'rust', deps: names(section('dependencies')), devDeps: names(section('dev-dependencies')) }
}

function anyWorkspace(files: ScanFiles, dir: string): Workspace | null {
	return jsWorkspace(files, dir) ?? goWorkspace(files, dir) ?? rustWorkspace(files, dir) ?? pyWorkspace(files, dir)
}

/** Lines of a TOML array value: `members = ["a", "b/*"]`. */
function tomlArray(text: string, key: string): string[] {
	const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(text)
	return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []
}

const SKIP_PY_DIRS = /(^|\/)(tests?|docs?|examples?|scripts?|fixtures?|\.[^/]+)(\/|$)/

export function findWorkspaces(files: ScanFiles): WorkspaceScan {
	const dirs = allDirs(files.keys())
	const sources: string[] = []
	const found = new Map<string, Workspace>()
	const addDirs = (ds: string[], fn: (d: string) => Workspace | null = (d) => anyWorkspace(files, d)) => {
		for (const d of ds) {
			if (found.has(d)) continue
			const w = fn(d)
			if (w) found.set(d, w)
		}
	}

	const pnpm = files.get('pnpm-workspace.yaml')
	if (pnpm !== undefined) {
		const globs = asArr(asObj(parseYaml(pnpm)).packages).map(String)
		if (globs.length) {
			sources.push('pnpm-workspace.yaml')
			addDirs(matchDirs(globs, dirs), (d) => jsWorkspace(files, d))
		}
	}
	const rootPkg = readPkg(files, '')
	const ws = rootPkg ? (Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : asArr(asObj(rootPkg.workspaces).packages)) : []
	if (ws.length) {
		sources.push('package.json workspaces')
		addDirs(matchDirs(ws.map(String), dirs), (d) => jsWorkspace(files, d))
	}
	const gowork = files.get('go.work')
	if (gowork !== undefined) {
		const uses = [...gowork.matchAll(/^\s*(?:use\s+)?(\.{1,2}\/[^\s)]*|\.)\s*$/gm)].map((m) => join(m[1]))
		const block = /use\s*\(([\s\S]*?)\)/.exec(gowork)?.[1]
		if (block) for (const l of block.split('\n')) if (l.trim() && !l.trim().startsWith('//')) uses.push(join(l.trim()))
		const single = [...gowork.matchAll(/^use\s+(\S+)\s*$/gm)].map((m) => join(m[1]))
		sources.push('go.work')
		addDirs(uniq([...uses, ...single]), (d) => goWorkspace(files, d))
	}
	const cargo = files.get('Cargo.toml')
	if (cargo !== undefined && /^\[workspace\]/m.test(cargo)) {
		sources.push('Cargo workspace')
		addDirs(matchDirs(tomlArray(cargo, 'members'), dirs), (d) => rustWorkspace(files, d))
	}
	// Python projects in subdirectories (monorepos of services)
	const pyDirs = [...dirs].filter((d) => d && !SKIP_PY_DIRS.test(d) && (files.has(join(d, 'pyproject.toml')) || files.has(join(d, 'setup.py'))))
	const topPy = pyDirs.filter((d) => !pyDirs.some((o) => o !== d && d.startsWith(o + '/')) && ![...found.keys()].some((f) => f && d.startsWith(f + '/')))
	if (topPy.length >= 1 && (topPy.length >= 2 || found.size > 0)) {
		sources.push('Python projects')
		addDirs(topPy, (d) => pyWorkspace(files, d))
	}

	// Without a workspace manifest: the repo root as one package, or several unrelated projects in subdirs.
	if (!found.size) {
		const root = anyWorkspace(files, '')
		if (root) found.set('', root)
		else {
			const manifests = [...dirs].filter((d) => d && !/(^|\/)(node_modules|examples?|test|tests|fixtures?)(\/|$)/.test(d) && (files.has(join(d, 'package.json')) || files.has(join(d, 'go.mod')) || files.has(join(d, 'Cargo.toml')) || files.has(join(d, 'pyproject.toml'))))
			const top = manifests.filter((d) => !manifests.some((o) => o !== d && d.startsWith(o + '/')))
			if (top.length) sources.push('project manifests')
			addDirs(top)
		}
	}
	return { sources, workspaces: [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir)) }
}
