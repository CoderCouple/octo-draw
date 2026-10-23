/** `octo-draw expand <file.octo> --node <key>`: on-demand drill-down from the scanned source (no AI in the CLI). */

import { dirname, isAbsolute, resolve } from 'node:path'
import { addPage, drillTargets, pageNames, parsePage, setNodeProp, sourceDirective, splitPages } from '@octo-draw/core'
import { ConnectorError, expandNode, resolveSource } from '@octo-draw/scan'
import '@octo-draw/scan/node'
import type { IO } from './cli'
import { CliError } from './convert'

export const EXPAND_HELP = `  octo-draw expand <file.octo> --node <key> [--page P] [--depth N] [-o out]
                                                  turn a node into a drill-down page from its scanned
                                                  source (src prop + the file's source directive)
`

export interface ExpandFlags {
	node?: string
	page?: string
	depth?: string
	out?: string
	quiet?: boolean
}

/** A relative local `source` is resolved against the .octo file's folder. */
function localSource(source: string, file: string): string {
	const hit = resolveSource(source)
	if (!hit || hit.ref.kind !== 'local') return source
	const id = hit.ref.id
	if (isAbsolute(id) || id.startsWith('~')) return id
	return resolve(file === '-' ? '.' : dirname(file), id)
}

export async function expandCommand(io: IO, file: string | undefined, flags: ExpandFlags): Promise<number> {
	if (!file) throw new CliError('missing <file.octo> to expand (use - for stdin)')
	if (!flags.node) throw new CliError('missing --node <key>')
	const depth = flags.depth === undefined ? 1 : Number(flags.depth)
	if (!Number.isInteger(depth) || depth < 1 || depth > 8) throw new CliError('--depth must be an integer from 1 to 8')
	const code = file === '-' ? await io.readStdin() : await io.readFile(file)
	const page = flags.page ?? ''
	const parsed = parsePage(code, page)
	if (!parsed) throw new CliError(`no page named "${page}"`)
	const canonical = page === '' ? '' : (splitPages(code).find((p) => p.name === page) ?? splitPages(code).find((p) => p.name.toLowerCase() === page.toLowerCase()))!.name
	const node = parsed.ir.nodes.find((n) => n.key === flags.node)
	if (!node) throw new CliError(`no node "${flags.node}" on ${canonical ? `page "${canonical}"` : 'the root page'}`)
	const names = pageNames(code)
	const has = drillTargets(parsed.ir, names, canonical)[node.key]
	if (has !== undefined) throw new CliError(`"${node.key}" already opens the page "${has}"`)
	const src = node.ext?.src
	if (!src) throw new CliError(`"${node.key}" has no src prop (scan with octo-draw scan to get expandable nodes; AI expansion is only in the editor)`)
	const source = sourceDirective(code)
	try {
		const r = await expandNode(
			{ source: source ? localSource(source, file) : '', src, node: { key: node.key, label: node.label }, parentPage: canonical, depth, existingPages: names },
			{ fetch: io.fetch, env: io.env },
		)
		const next = setNodeProp(addPage(code, r.title, r.body), node.key, 'drill', r.title, canonical)
		if (!flags.quiet) {
			io.stderr(`expanded "${node.key}" into ${r.pages.length === 1 ? `page "${r.title}"` : `${r.pages.length} pages`}\n`)
			for (const w of r.warnings) io.stderr(`warning: ${w}\n`)
		}
		const out = flags.out ?? '-'
		if (out === '-') io.stdout(next)
		else {
			await io.writeFile(out, next)
			if (!flags.quiet) io.stderr(`wrote ${out}\n`)
		}
		return 0
	} catch (err) {
		if (err instanceof ConnectorError) throw new CliError(err.message)
		throw err
	}
}
