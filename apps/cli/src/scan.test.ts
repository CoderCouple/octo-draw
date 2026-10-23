import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run, type IO } from './cli'
import { rootPage } from './scan'

const FIXTURES = resolve(import.meta.dirname, '../../../packages/scan/fixtures')

function memIO(fetchFn: typeof fetch = fetch, env: Record<string, string> = { OCTO_ICONS_DIR: join(import.meta.dirname, '..', 'fixtures', 'no-icon-cache'), GITHUB_TOKEN: 'ghp_cli' }) {
	const out: string[] = []
	const err: string[] = []
	const written: Record<string, string> = {}
	const io: IO = {
		readFile: async (p) => {
			throw new Error(`ENOENT: ${p}`)
		},
		writeFile: async (p, d) => {
			written[p] = d
		},
		readStdin: async () => '',
		stdout: (t) => out.push(t),
		stderr: (t) => err.push(t),
		fetch: fetchFn,
		env,
	}
	return { io, written, out: () => out.join(''), err: () => err.join('') }
}

describe('octo-draw scan', () => {
	it('scans a folder to octo with findings on stderr and renders the root page', async () => {
		const m = memIO()
		expect(await run(['scan', join(FIXTURES, 'monorepo'), '-o', 'arch.octo', '--render', 'arch.svg'], m.io)).toBe(0)
		expect(m.written['arch.octo']).toMatch(/^title acme architecture/)
		expect(m.written['arch.octo']).toContain('page api modules')
		expect(m.written['arch.svg']).toMatch(/^<svg/)
		expect(m.err()).toMatch(/code \(80%\)/)
		expect(m.err()).toMatch(/wrote arch\.svg \(root page\)/)
	})

	it('supports --only and --json', async () => {
		const m = memIO()
		expect(await run(['scan', join(FIXTURES, 'monorepo'), '--only', 'compose', '--json', '--quiet'], m.io)).toBe(0)
		const body = JSON.parse(m.out())
		expect(body.findings.map((f: { analyzer: string }) => f.analyzer)).toEqual(['compose'])
		expect(m.err()).toBe('')
		const bad = memIO()
		expect(await run(['scan', FIXTURES, '--only', 'nope'], bad.io)).toBe(2)
		expect(bad.err()).toMatch(/--only accepts/)
	})

	it('scans GitHub sources through the connector with the env token', async () => {
		const auth: string[] = []
		const fake = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			auth.push((init?.headers as Record<string, string>).Authorization ?? '')
			if (url.endsWith('/repos/o/r')) return Response.json({ description: 'Demo', default_branch: 'main', html_url: 'https://github.com/o/r' })
			if (url.endsWith('/languages')) return Response.json({ Go: 1 })
			if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'main.tf', type: 'blob', size: 40 }] })
			if (url.endsWith('/main.tf')) return new Response('resource "aws_s3_bucket" "logs" {}\n')
			return new Response('', { status: 404 })
		}) as typeof fetch
		const m = memIO(fake)
		expect(await run(['scan', 'o/r@main'], m.io)).toBe(0)
		expect(m.out()).toMatch(/^title Demo/)
		expect(m.out()).toContain('aws_s3_bucket.logs')
		expect(m.err()).toMatch(/scanned github:o\/r@main/)
		expect(auth.every((a) => a === 'Bearer ghp_cli')).toBe(true)
		expect(m.out() + m.err()).not.toContain('ghp_cli')
	})

	it('rejects inputs that are neither folders nor sources', async () => {
		const m = memIO()
		expect(await run(['scan', 'definitely not a source'], m.io)).toBe(2)
		expect(m.err()).toMatch(/not a directory or a recognised source/)
		expect(await run(['scan'], memIO().io)).toBe(2)
	})

	it('rootPage cuts before the first page', () => {
		expect(rootPage('title T\nA > B\n\npage X\nC > D\n')).toBe('title T\nA > B\n\n')
	})
})
