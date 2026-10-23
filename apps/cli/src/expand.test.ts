import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePage } from '@octo-draw/core'
import { run, type IO } from './cli'

const DEEP = resolve(import.meta.dirname, '../../../packages/scan/fixtures/deep-repo')

function memIO(files: Record<string, string> = {}) {
	const out: string[] = []
	const err: string[] = []
	const written: Record<string, string> = {}
	const io: IO = {
		readFile: async (p) => {
			if (p in files) return files[p]
			throw new Error(`ENOENT: ${p}`)
		},
		writeFile: async (p, d) => {
			written[p] = d
		},
		readStdin: async () => '',
		stdout: (t) => out.push(t),
		stderr: (t) => err.push(t),
		fetch,
		env: { OCTO_ICONS_DIR: join(import.meta.dirname, '..', 'fixtures', 'no-icon-cache') },
	}
	return { io, written, out: () => out.join(''), err: () => err.join('') }
}

describe('octo-draw scan --depth / expand', () => {
	it('scan --depth 3 pre-generates directory, file and symbol pages', async () => {
		const m = memIO()
		expect(await run(['scan', DEEP, '--depth', '3', '-o', 'a.octo'], m.io)).toBe(0)
		expect(m.written['a.octo']).toContain('page api modules / routes/users / listUsers')
		expect(await run(['scan', DEEP, '--depth', 'x'], memIO().io)).toBe(2)
	})

	it('expand turns a node into a page from its src (source mode only)', async () => {
		const code = `title Shop\nsource ${DEEP}\nserver [src: local:packages/api/src/server.ts]\nnosrc\n`
		const m = memIO({ 'doc.octo': code })
		expect(await run(['expand', 'doc.octo', '--node', 'server', '--depth', '2', '-o', 'out.octo'], m.io)).toBe(0)
		const out = m.written['out.octo']
		expect(parsePage(out, '')!.ir.nodes[0].ext?.drill).toBe('server')
		expect(parsePage(out, 'server / Server')!.ir.nodes.map((n) => n.key)).toContain('start')
		const bad = memIO({ 'doc.octo': code })
		expect(await run(['expand', 'doc.octo', '--node', 'nosrc'], bad.io)).toBe(2)
		expect(bad.err()).toMatch(/no src/)
		expect(await run(['expand', 'doc.octo', '--node', 'missing'], memIO({ 'doc.octo': code }).io)).toBe(2)
		expect(await run(['expand', 'doc.octo'], memIO({ 'doc.octo': code }).io)).toBe(2)
	})
})
