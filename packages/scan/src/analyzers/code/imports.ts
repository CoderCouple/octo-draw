/**
 * Import extraction and resolution. TS/JS is handled well (relative paths,
 * `.js` → `.ts`, index files, tsconfig `paths`, bare package names); Go and
 * Python are best-effort.
 */

import type { ScanFiles } from '../../types'
import { asObj, dirname, isObj, join, normalizeOrNull, parseJsonLoose } from '../../util'
import type { Lang } from './workspaces'

export const SOURCE_EXT: Record<Lang, RegExp> = {
	js: /\.(m|c)?(t|j)sx?$/,
	go: /\.go$/,
	python: /\.py$/,
	rust: /\.rs$/,
}

const TEST_FILE = /(\.|_)(test|spec|stories|bench)\.[a-z]+$|_test\.go$|(^|\/)(test_[^/]*\.py|conftest\.py)$|\.d\.ts$/
const TEST_DIR = /(^|\/)(__tests__|__mocks__|tests?|testdata|fixtures?|e2e|mocks?)(\/|$)/

export function isTestPath(p: string): boolean {
	return TEST_FILE.test(p) || TEST_DIR.test(p)
}

/** Import specifiers in one source file. */
export function extractImports(text: string, lang: Lang): string[] {
	const out: string[] = []
	if (lang === 'js') {
		const t = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
		for (const m of t.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"\n]+)['"]/g)) out.push(m[1])
		for (const m of t.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.push(m[1])
	} else if (lang === 'go') {
		for (const m of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1])
		for (const b of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) for (const m of b[1].matchAll(/^\s*(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1])
	} else if (lang === 'python') {
		for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm)) {
			// `from . import a, b` → `.a`, `.b`
			if (/^\.+$/.test(m[1])) for (const n of m[2].replace(/[()\n]/g, ' ').split(',')) out.push(m[1] + n.trim().split(/\s+/)[0])
			else out.push(m[1])
		}
		for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w., \t]+)/gm)) for (const n of m[1].split(',')) out.push(n.trim().split(/\s+/)[0])
	} else if (lang === 'rust') {
		for (const m of text.matchAll(/^\s*(?:pub(?:\([\w ]+\))?\s+)?use\s+([\w:]+)/gm)) out.push(m[1])
		for (const m of text.matchAll(/^\s*(?:pub(?:\([\w ]+\))?\s+)?mod\s+(\w+)\s*;/gm)) out.push(`crate::${m[1]}`)
	}
	return out.filter(Boolean)
}

/** npm package name of a bare specifier (`@scope/pkg/sub` → `@scope/pkg`); null for relative / node: / URLs. */
export function packageOf(spec: string): string | null {
	if (/^(\.|\/|node:|bun:|https?:|data:|virtual:|~|#|\$)/.test(spec)) return null
	const parts = spec.split('/')
	return spec.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null) : parts[0]
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.vue', '.svelte']

/** Resolves a JS/TS relative path to a file in `files`, or null. */
export function resolveJsPath(files: ScanFiles, target: string): string | null {
	const base = normalizeOrNull(target)
	if (base === null) return null
	const cands = [base]
	const stripped = base.replace(/\.(m|c)?jsx?$/, '')
	for (const e of JS_EXTS) cands.push(stripped + e)
	for (const e of JS_EXTS) cands.push(`${base}/index${e}`)
	return cands.find((c) => files.has(c)) ?? null
}

export interface TsPaths {
	baseDir: string
	paths: [prefix: string, targets: string[]][]
}

/** tsconfig `compilerOptions.paths` of a package (follows one level of `extends` within the repo). */
export function readTsPaths(files: ScanFiles, dir: string): TsPaths | null {
	for (const name of ['tsconfig.json', 'jsconfig.json']) {
		const path = join(dir, name)
		const cfg = parseJsonLoose(files.get(path) ?? '')
		if (!isObj(cfg)) continue
		let co = asObj(cfg.compilerOptions)
		let cfgDir = dir
		if (!co.paths && typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
			const p = join(dir, cfg.extends)
			const parent = parseJsonLoose(files.get(p) ?? files.get(p + '.json') ?? '')
			if (isObj(parent)) {
				co = asObj(parent.compilerOptions)
				cfgDir = dirname(p)
			}
		}
		const paths = asObj(co.paths)
		if (!Object.keys(paths).length) continue
		const baseDir = join(cfgDir, typeof co.baseUrl === 'string' ? co.baseUrl : '.')
		return { baseDir, paths: Object.entries(paths).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]) }
	}
	return null
}

/**
 * Resolves an import to a repo file (internal) or a package name (external).
 * `workspacePkgs` maps package names to workspace dirs, so `@octo-draw/core`
 * becomes a cross-workspace dependency rather than an external.
 */
export function resolveImport(
	files: ScanFiles,
	from: string,
	spec: string,
	lang: Lang,
	ctx: { tsPaths?: TsPaths | null; goModule?: string; dir: string },
): { file?: string; pkg?: string } {
	if (lang === 'js') {
		if (spec.startsWith('.')) {
			const f = resolveJsPath(files, join(dirname(from), spec))
			return f ? { file: f } : {}
		}
		if (ctx.tsPaths) {
			for (const [pattern, targets] of ctx.tsPaths.paths) {
				const star = pattern.endsWith('*')
				const prefix = star ? pattern.slice(0, -1) : pattern
				if (star ? !spec.startsWith(prefix) : spec !== pattern) continue
				for (const t of targets) {
					const f = resolveJsPath(files, join(ctx.tsPaths.baseDir, star ? t.replace('*', spec.slice(prefix.length)) : t))
					if (f) return { file: f }
				}
			}
		}
		const pkg = packageOf(spec)
		return pkg ? { pkg } : {}
	}
	if (lang === 'go') {
		if (ctx.goModule && (spec === ctx.goModule || spec.startsWith(ctx.goModule + '/'))) {
			const sub = spec.slice(ctx.goModule.length + 1)
			const d = join(ctx.dir, sub)
			const f = [...files.keys()].find((p) => dirname(p) === d && p.endsWith('.go'))
			return f ? { file: f } : {}
		}
		// module path of an external import: the longest dependency prefix is decided by the caller
		return /\./.test(spec.split('/')[0]) ? { pkg: spec } : {}
	}
	if (lang === 'python') {
		const dots = spec.match(/^\.*/)![0].length
		const rest = spec.slice(dots).split('.').filter(Boolean)
		const bases: string[] = []
		if (dots) {
			let d = dirname(from)
			for (let i = 1; i < dots; i++) d = dirname(d)
			bases.push(d)
		} else bases.push(ctx.dir, join(ctx.dir, 'src'), join(ctx.dir, 'app'))
		for (const b of bases) {
			for (let n = rest.length; n >= (dots ? 0 : 1); n--) {
				const p = join(b, ...rest.slice(0, n))
				const f = files.has(p + '.py') ? p + '.py' : files.has(join(p, '__init__.py')) ? join(p, '__init__.py') : null
				if (f && f !== from) return { file: f }
			}
		}
		return dots ? {} : { pkg: rest[0]?.toLowerCase() }
	}
	if (lang === 'rust') {
		const parts = spec.split('::')
		if (parts[0] === 'crate' || parts[0] === 'super' || parts[0] === 'self') {
			const src = join(ctx.dir, 'src')
			const name = parts[1]
			const f = name && (files.has(join(src, `${name}.rs`)) ? join(src, `${name}.rs`) : files.has(join(src, name, 'mod.rs')) ? join(src, name, 'mod.rs') : null)
			return f ? { file: f } : {}
		}
		return { pkg: parts[0].replace(/_/g, '-') }
	}
	return {}
}
