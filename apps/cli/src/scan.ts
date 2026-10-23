/** `octo-draw scan <dir|url>`: source scanning (local folders and any registered connector). */

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { RenderTheme } from '@octo-draw/core'
import { ANALYZERS, ConnectorError, resolveSource, type AnalyzerName, type ConnectorResult } from '@octo-draw/scan'
import { scanDir } from '@octo-draw/scan/node'
import { defaultIconsDir } from '@octo-draw/core/node/iconCache'
import type { IO } from './cli'
import { CliError, convertDoc, loadInput } from './convert'

export const SCAN_HELP = `  octo-draw scan <dir|source> [-o out.octo] [--render out.svg] [--only ${ANALYZERS.join(',')}] [--json]
                                                  architecture diagram from a folder or a source:
                                                  github.com/owner/repo[/tree/ref/dir], owner/repo@ref, hf:org/model, aws:region
`

export interface ScanFlags {
	out?: string
	render?: string
	only?: string
	title?: string
	json?: boolean
	quiet?: boolean
	theme?: RenderTheme
}

function parseOnly(v: string | undefined): AnalyzerName[] | undefined {
	if (!v) return undefined
	const list = v.split(',').map((s) => s.trim()).filter(Boolean)
	const bad = list.filter((x) => !(ANALYZERS as readonly string[]).includes(x))
	if (bad.length) throw new CliError(`--only accepts ${ANALYZERS.join(', ')} (got ${bad.join(', ')})`)
	return list as AnalyzerName[]
}

function isDir(p: string): boolean {
	try {
		return statSync(p.startsWith('~/') ? homedir() + p.slice(1) : p).isDirectory()
	} catch {
		return false
	}
}

/** `gh auth token`, if the GitHub CLI is installed and logged in (never printed). */
function ghToken(): Promise<string | undefined> {
	return new Promise((res) => {
		try {
			execFile('gh', ['auth', 'token'], { timeout: 4000 }, (err, stdout) => res(err ? undefined : stdout.trim() || undefined))
		} catch {
			res(undefined)
		}
	})
}

/** Root page only: everything before the first `page` line. */
export function rootPage(code: string): string {
	const m = /^page[ \t]/m.exec(code)
	return m ? code.slice(0, m.index) : code
}

export async function scanCommand(io: IO, input: string | undefined, flags: ScanFlags): Promise<number> {
	if (!input) throw new CliError('missing <dir|source> to scan')
	const only = parseOnly(flags.only)
	let result: Pick<ConnectorResult, 'code' | 'findings' | 'warnings'> & { source?: string }
	if (isDir(input)) {
		const r = await scanDir(input.startsWith('~/') ? homedir() + input.slice(1) : input, { only, title: flags.title })
		result = { ...r, source: `${r.root} (${r.fileCount} files)` }
	} else {
		const hit = resolveSource(input)
		if (!hit) throw new CliError(`"${input}" is not a directory or a recognised source (github.com/owner/repo, owner/repo@ref, hf:org/model, aws:region)`)
		const env = { ...io.env }
		if (hit.ref.kind === 'github' && !env.GITHUB_TOKEN && !env.GH_TOKEN) env.GITHUB_TOKEN = await ghToken()
		try {
			const r = await hit.connector.scan({ ...hit.ref, options: { ...hit.ref.options, only, title: flags.title } }, { fetch: io.fetch, env, log: flags.quiet ? undefined : (m) => io.stderr(`${m}\n`) })
			result = { ...r, source: `${r.source.kind}:${r.source.id}${r.source.ref ? `@${r.source.ref}` : ''}` }
		} catch (err) {
			if (err instanceof ConnectorError) throw new CliError(err.message)
			throw err
		}
	}
	if (!flags.quiet) {
		io.stderr(`scanned ${result.source}\n`)
		for (const f of result.findings) io.stderr(`  ${f.analyzer} (${Math.round(f.confidence * 100)}%): ${(f.notes ?? []).join('; ')}\n`)
		for (const w of result.warnings) io.stderr(`warning: ${w}\n`)
	}
	const body = flags.json ? JSON.stringify({ code: result.code, findings: result.findings, warnings: result.warnings }, null, '\t') + '\n' : result.code
	if (flags.out && flags.out !== '-') {
		await io.writeFile(flags.out, body)
		if (!flags.quiet) io.stderr(`wrote ${flags.out}\n`)
	} else io.stdout(body)
	if (flags.render) {
		const { doc } = loadInput(rootPage(result.code), { from: 'octo' })
		await io.writeFile(flags.render, await convertDoc(doc, 'svg', { theme: flags.theme, iconsDir: defaultIconsDir(io.env) }))
		if (!flags.quiet) io.stderr(`wrote ${flags.render} (root page)\n`)
	}
	return 0
}
