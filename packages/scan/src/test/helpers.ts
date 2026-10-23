import { join } from 'node:path'
import { parseOcto } from '@octo-draw/core'
import { walkDir } from '../node'
import type { ScanFiles } from '../types'

export const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures')

export async function fixture(name: string): Promise<ScanFiles> {
	return (await walkDir(join(FIXTURES, name))).files
}

export const files = (o: Record<string, string>): ScanFiles => new Map(Object.entries(o))

/** Splits octo code into pages (root first) and parses each body. */
export function pagesOf(code: string): { name: string; body: string; errors: string[]; ir: ReturnType<typeof parseOcto>['ir'] }[] {
	const out: { name: string; body: string }[] = []
	const re = /^page[ \t]+(.+?)[ \t]*$/gm
	let last = 0
	let name = ''
	for (const m of code.matchAll(re)) {
		out.push({ name, body: code.slice(last, m.index) })
		name = m[1].replace(/^"(.*)"$/, '$1')
		last = m.index! + m[0].length
	}
	out.push({ name, body: code.slice(last) })
	return out.map((p) => {
		const r = parseOcto(p.body)
		return { ...p, ir: r.ir, errors: r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message) }
	})
}

/** Every page parses cleanly and every `drill:` target exists. */
export function checkDocument(code: string) {
	const pages = pagesOf(code)
	const names = new Set(pages.map((p) => p.name))
	const problems: string[] = []
	for (const p of pages) {
		for (const e of p.errors) problems.push(`${p.name || 'root'}: ${e}`)
		for (const n of p.ir.nodes) if (n.ext?.drill && !names.has(n.ext.drill)) problems.push(`${p.name || 'root'}: ${n.key} drills into missing page "${n.ext.drill}"`)
	}
	return { pages, problems }
}
