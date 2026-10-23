/** Small pure helpers: POSIX paths, globs, unique keys, tolerant JSON. */

import { parse as parseYamlDoc, parseAllDocuments } from 'yaml'

export function dirname(p: string): string {
	const i = p.lastIndexOf('/')
	return i < 0 ? '' : p.slice(0, i)
}

export function basename(p: string): string {
	return p.slice(p.lastIndexOf('/') + 1)
}

export function join(...parts: string[]): string {
	return normalize(parts.filter(Boolean).join('/'))
}

/** Resolves `.` and `..`; never climbs above the root (returns null if it would). */
export function normalizeOrNull(p: string): string | null {
	const out: string[] = []
	for (const seg of p.split('/')) {
		if (seg === '' || seg === '.') continue
		if (seg === '..') {
			if (!out.length) return null
			out.pop()
		} else out.push(seg)
	}
	return out.join('/')
}

export function normalize(p: string): string {
	return normalizeOrNull(p) ?? ''
}

/** Is `p` inside directory `dir` (or equal)? `''` is the repo root. */
export function within(p: string, dir: string): boolean {
	return dir === '' || p === dir || p.startsWith(dir + '/')
}

/** Workspace-style glob (`packages/*`, `apps/**`, `libs/foo`) → RegExp over directory paths. */
export function globToRegExp(glob: string): RegExp {
	let g = normalize(glob.replace(/^\.\//, '').replace(/\/+$/, ''))
	let re = ''
	for (let i = 0; i < g.length; i++) {
		const c = g[i]
		if (c === '*') {
			if (g[i + 1] === '*') {
				re += '.*'
				i++
				if (g[i + 1] === '/') i++
			} else re += '[^/]*'
		} else if (c === '?') re += '[^/]'
		else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
	}
	return new RegExp(`^${re}$`)
}

/** Directories (repo-relative) that contain at least one file. */
export function allDirs(files: Iterable<string>): Set<string> {
	const dirs = new Set<string>([''])
	for (const f of files) {
		let d = dirname(f)
		while (d && !dirs.has(d)) {
			dirs.add(d)
			d = dirname(d)
		}
	}
	return dirs
}

/** Directories matching workspace globs (with `!negations`). */
export function matchDirs(globs: string[], dirs: Iterable<string>): string[] {
	const inc = globs.filter((g) => !g.startsWith('!')).map(globToRegExp)
	const exc = globs.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)))
	const out: string[] = []
	for (const d of dirs) if (inc.some((r) => r.test(d)) && !exc.some((r) => r.test(d))) out.push(d)
	return out.sort()
}

/** JSON with comments and trailing commas (tsconfig.json). Returns null on failure. */
export function parseJsonLoose(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		// strip comments outside strings, then trailing commas
		let out = ''
		for (let i = 0; i < text.length; i++) {
			const c = text[i]
			if (c === '"') {
				let j = i + 1
				while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
				out += text.slice(i, j + 1)
				i = j
			} else if (c === '/' && text[i + 1] === '/') {
				while (i < text.length && text[i] !== '\n') i++
				out += '\n'
			} else if (c === '/' && text[i + 1] === '*') {
				const end = text.indexOf('*/', i + 2)
				i = end < 0 ? text.length : end + 1
			} else out += c
		}
		try {
			return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
		} catch {
			return null
		}
	}
}

export function parseYaml(text: string): unknown {
	try {
		return parseYamlDoc(text, { uniqueKeys: false, logLevel: 'silent' })
	} catch {
		return undefined
	}
}

/** Multi-document YAML; documents that fail to parse are skipped (counted in `errors`). */
export function parseYamlAll(text: string): { docs: unknown[]; errors: number } {
	const docs: unknown[] = []
	let errors = 0
	try {
		for (const d of parseAllDocuments(text, { uniqueKeys: false, logLevel: 'silent' })) {
			if ('errors' in d && d.errors.length) {
				errors++
				continue
			}
			const v = d.toJS({ maxAliasCount: 50 })
			if (v !== null && v !== undefined) docs.push(v)
		}
	} catch {
		errors++
	}
	return { docs, errors }
}

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const asObj = (v: unknown): Obj => (isObj(v) ? v : {})
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined)

/** Allocates unique, readable keys: `api`, then `api 2`, ... (case-insensitive). */
export class KeyAllocator {
	private used = new Set<string>()
	constructor(taken: Iterable<string> = []) {
		for (const k of taken) this.used.add(k.toLowerCase())
	}
	take(want: string): string {
		const base = cleanKey(want) || 'node'
		let k = base
		for (let n = 2; this.used.has(k.toLowerCase()); n++) k = `${base} ${n}`
		this.used.add(k.toLowerCase())
		return k
	}
	has(k: string) {
		return this.used.has(k.toLowerCase())
	}
}

/** Keys are names in the DSL: keep them single-line and free of quotes. */
export function cleanKey(s: string): string {
	return s.replace(/["\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function uniq<T>(xs: Iterable<T>): T[] {
	return [...new Set(xs)]
}

export function plural(n: number, word: string, many = `${word}s`): string {
	return `${n} ${n === 1 ? word : many}`
}
