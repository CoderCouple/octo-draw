/**
 * Node-only file walker: reads a directory into the `ScanFiles` map the pure
 * analyzers take. Skips dependency / build / VCS directories, secrets
 * (`.env*`, keys, tfvars), binary and oversized files; caps file count and
 * total bytes; follows symlinks only when they resolve inside the root.
 *
 * Also registers the `local` connector (a folder path).
 */

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename as pathBase, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { registerConnector, type Connector } from './connectors'
import { isScannable, isScannablePath, skipDir } from './filter'
import { registerFileSource } from './expand'
import { scanSource } from './scan'
import type { ScanFiles, ScanOptions } from './types'

export interface WalkOptions {
	/** Max files read (default 4000). */
	maxFiles?: number
	/** Max bytes per file (default 512 KB). */
	maxFileBytes?: number
	/** Max total bytes (default 24 MB). */
	maxTotalBytes?: number
	/** Max directory depth below the root (default 12). */
	maxDepth?: number
}

export interface WalkResult {
	files: ScanFiles
	root: string
	skipped: { large: number; binary: number; capped: boolean; symlinksOutside: number }
	warnings: string[]
}

/** Reads a directory tree into a `ScanFiles` map (breadth-first, so manifests near the root win the caps). */
export async function walkDir(dir: string, opts: WalkOptions = {}): Promise<WalkResult> {
	const maxFiles = opts.maxFiles ?? 4000
	const maxFileBytes = opts.maxFileBytes ?? 512 * 1024
	const maxTotal = opts.maxTotalBytes ?? 24 * 1024 * 1024
	const maxDepth = opts.maxDepth ?? 12
	const root = await realpath(resolve(dir))
	if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${dir}`)
	const files: ScanFiles = new Map()
	const skipped = { large: 0, binary: 0, capped: false, symlinksOutside: 0 }
	const warnings: string[] = []
	const visited = new Set<string>([root])
	let total = 0
	const inside = (p: string) => p === root || p.startsWith(root + sep)
	const queue: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }]
	while (queue.length) {
		const { abs, depth } = queue.shift()!
		let entries
		try {
			entries = await readdir(abs, { withFileTypes: true })
		} catch {
			continue
		}
		entries.sort((a, b) => a.name.localeCompare(b.name))
		// files first, then subdirectories (BFS)
		for (const e of entries) {
			let full = join(abs, e.name)
			let isDir = e.isDirectory()
			let isFile = e.isFile()
			if (e.isSymbolicLink()) {
				let target: string
				try {
					target = await realpath(full)
				} catch {
					continue
				}
				if (!inside(target)) {
					skipped.symlinksOutside++
					continue
				}
				const st = await lstat(target).catch(() => null)
				if (!st) continue
				isDir = st.isDirectory()
				isFile = st.isFile()
				full = target
			}
			if (isDir) {
				if (skipDir(e.name) || depth >= maxDepth || visited.has(full)) continue
				visited.add(full)
				queue.push({ abs: full, depth: depth + 1 })
				continue
			}
			if (!isFile || !isScannable(e.name)) continue
			if (files.size >= maxFiles || total >= maxTotal) {
				skipped.capped = true
				continue
			}
			const st = await stat(full).catch(() => null)
			if (!st) continue
			if (st.size > maxFileBytes) {
				skipped.large++
				continue
			}
			const buf = await readFile(full).catch(() => null)
			if (!buf) continue
			if (buf.subarray(0, 8000).includes(0)) {
				skipped.binary++
				continue
			}
			total += buf.length
			const rel = relative(root, join(abs, e.name)).split(sep).join('/')
			files.set(rel, buf.toString('utf8'))
		}
	}
	if (skipped.capped) warnings.push(`file cap reached (${maxFiles} files / ${Math.round(maxTotal / 1024 / 1024)} MB): the scan is partial`)
	if (skipped.symlinksOutside) warnings.push(`${skipped.symlinksOutside} symlink(s) pointing outside the root were not followed`)
	return { files, root, skipped, warnings }
}

/** Walks and scans a local directory. The root page gets `source <real path>` and nodes `src: local:<path>`. */
export async function scanDir(dir: string, opts: ScanOptions & { walk?: WalkOptions } = {}) {
	const w = await walkDir(dir, opts.walk)
	const r = scanSource(w.files, { rootName: pathBase(w.root), source: w.root, ...opts })
	return { ...r, warnings: [...w.warnings, ...r.warnings], fileCount: w.files.size, root: w.root, files: w.files }
}

/** `local` connector: absolute, `./relative`, `~/` or `file://` paths (and `local:<path>`). */
export const localConnector: Connector = {
	kind: 'local',
	parse(input) {
		const s = input.trim()
		const m = /^(?:local:|file:\/\/)(.+)$/.exec(s)
		if (m) return { kind: 'local', id: m[1] }
		if (isAbsolute(s) || /^\.{1,2}(\/|$)|^~(\/|$)/.test(s)) return { kind: 'local', id: s }
		return null
	},
	async scan(ref, ctx) {
		const home = ctx.env.HOME ?? ''
		const path = ref.id.startsWith('~') ? join(home, ref.id.slice(1)) : ref.id
		const r = await scanDir(path, ref.options as ScanOptions | undefined)
		return { code: r.code, findings: r.findings, warnings: r.warnings, source: { ...ref, id: r.root }, files: r.files }
	},
}
registerConnector(localConnector)

/**
 * Lists the scannable files under `root` (names only, same skip rules as
 * `walkDir`), breadth-first, capped.
 */
export async function listFiles(root: string, opts: { maxFiles?: number; maxDepth?: number } = {}): Promise<string[]> {
	const maxFiles = opts.maxFiles ?? 20000
	const maxDepth = opts.maxDepth ?? 12
	const real = await realpath(resolve(root))
	const out: string[] = []
	const visited = new Set<string>([real])
	const queue: { abs: string; depth: number }[] = [{ abs: real, depth: 0 }]
	const inside = (p: string) => p === real || p.startsWith(real + sep)
	while (queue.length && out.length < maxFiles) {
		const { abs, depth } = queue.shift()!
		let entries
		try {
			entries = await readdir(abs, { withFileTypes: true })
		} catch {
			continue
		}
		entries.sort((a, b) => a.name.localeCompare(b.name))
		for (const e of entries) {
			let full = join(abs, e.name)
			let isDir = e.isDirectory()
			let isFile = e.isFile()
			if (e.isSymbolicLink()) {
				const target = await realpath(full).catch(() => null)
				if (!target || !inside(target)) continue
				const st = await lstat(target).catch(() => null)
				if (!st) continue
				isDir = st.isDirectory()
				isFile = st.isFile()
				full = target
			}
			if (isDir) {
				if (skipDir(e.name) || depth >= maxDepth || visited.has(full)) continue
				visited.add(full)
				queue.push({ abs: full, depth: depth + 1 })
			} else if (isFile && isScannable(e.name) && out.length < maxFiles) out.push(relative(real, join(abs, e.name)).split(sep).join('/'))
		}
	}
	return out
}

/**
 * Reads files of a local source for on-demand expansion. Paths are
 * repo-relative; `..`, absolute paths, skipped / secret files and anything
 * whose real path leaves the root are refused (null).
 */
export function localFileSource(root: string, opts: { maxFileBytes?: number } = {}) {
	const maxFileBytes = opts.maxFileBytes ?? 512 * 1024
	let realRoot: Promise<string> | null = null
	const rootReal = () => (realRoot ??= realpath(resolve(root)))
	return {
		list: async () => listFiles(await rootReal()),
		read: async (path: string): Promise<string | null> => {
			if (!path || isAbsolute(path) || path.split('/').some((s) => s === '..' || s === '') || !isScannablePath(path)) return null
			const base = await rootReal()
			const full = await realpath(join(base, ...path.split('/'))).catch(() => null)
			if (!full || !full.startsWith(base + sep)) return null
			const st = await stat(full).catch(() => null)
			if (!st || !st.isFile() || st.size > maxFileBytes) return null
			const buf = await readFile(full).catch(() => null)
			if (!buf || buf.subarray(0, 8000).includes(0)) return null
			return buf.toString('utf8')
		},
	}
}

registerFileSource('local', (ref, ctx) => {
	const home = ctx.env.HOME ?? ''
	return localFileSource(ref.id.startsWith('~') ? join(home, ref.id.slice(1)) : ref.id)
})
