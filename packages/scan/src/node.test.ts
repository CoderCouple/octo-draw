import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { localConnector, scanDir, walkDir } from './node'
import { FIXTURES } from './test/helpers'

// scratch trees live inside the package (never outside the repo) and are removed afterwards
const TMP = join(import.meta.dirname, '..', '.tmp-walk-test')
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('walkDir', () => {
	it('skips dependency/build dirs, secrets and lockfiles', async () => {
		const { files } = await walkDir(join(FIXTURES, 'monorepo'))
		const paths = [...files.keys()]
		expect(paths).toContain('apps/api/src/index.ts')
		expect(paths).toContain('.github/workflows/deploy.yml')
		expect(paths.some((p) => p.startsWith('node_modules/') || p.startsWith('dist/'))).toBe(false)
		expect(paths).not.toContain('.env')
	})

	it('caps file count, file size and never follows symlinks out of the root', async () => {
		rmSync(TMP, { recursive: true, force: true })
		const root = join(TMP, 'root')
		mkdirSync(join(root, 'src', 'vendor'), { recursive: true })
		mkdirSync(join(TMP, 'outside'), { recursive: true })
		writeFileSync(join(TMP, 'outside', 'secret.ts'), 'export const leaked = 1')
		for (let i = 0; i < 5; i++) writeFileSync(join(root, 'src', `f${i}.ts`), `export const x${i} = ${i}`)
		writeFileSync(join(root, 'src', 'vendor', 'v.ts'), '')
		writeFileSync(join(root, 'big.json'), 'x'.repeat(2000))
		writeFileSync(join(root, 'bin.ts'), Buffer.from([0x61, 0, 0x62]))
		writeFileSync(join(root, 'logo.png'), 'not text')
		symlinkSync(join(TMP, 'outside'), join(root, 'escape'))
		symlinkSync(join(TMP, 'outside', 'secret.ts'), join(root, 'escape.ts'))
		symlinkSync(join(root, 'src', 'f0.ts'), join(root, 'inside.ts'))
		const r = await walkDir(root, { maxFileBytes: 1000 })
		const paths = [...r.files.keys()].sort()
		expect(paths).toEqual(['inside.ts', 'src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts'])
		expect(r.skipped).toMatchObject({ large: 1, binary: 1, symlinksOutside: 2 })
		expect(JSON.stringify([...r.files.values()])).not.toContain('leaked')
		const capped = await walkDir(root, { maxFiles: 2 })
		expect(capped.files.size).toBe(2)
		expect(capped.warnings.join(' ')).toMatch(/partial/)
	})
})

describe('scanDir and the local connector', () => {
	it('scans a folder and parses local inputs', async () => {
		const r = await scanDir(join(FIXTURES, 'compose'))
		expect(r.code).toMatch(/^title compose architecture/)
		expect(localConnector.parse('/abs/path')).toEqual({ kind: 'local', id: '/abs/path' })
		expect(localConnector.parse('./rel')).toEqual({ kind: 'local', id: './rel' })
		expect(localConnector.parse('github.com/a/b')).toBeNull()
		const viaConnector = await localConnector.scan({ kind: 'local', id: join(FIXTURES, 'openapi') }, { fetch, env: {} })
		expect(viaConnector.code).toContain('page API Petstore')
	})
})
