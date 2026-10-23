/**
 * octo-draw CLI. `run` takes argv and an injectable IO so tests drive it in-process.
 */

import { OCTO_DOCUMENT_SCHEMA, type RenderTheme } from '@octo-draw/core'
import { CliError, convertDoc, formatForOutput, INPUT_FORMATS, loadInput, OUTPUT_FORMATS, type InputFormat, type OutputFormat } from './convert'
import { defaultIconsDir } from '@octo-draw/core/node/iconCache'

export interface IO {
	readFile(path: string): Promise<string>
	writeFile(path: string, data: string): Promise<void>
	readStdin(): Promise<string>
	stdout(text: string): void
	stderr(text: string): void
	fetch: typeof fetch
	env: Record<string, string | undefined>
}

export const HELP = `octo-draw — diagram-as-code from the command line

Usage:
  octo-draw convert <input|-> --to <format> [-o <file>] [--from <format>] [--theme light|dark]
  octo-draw render <input|-> [-o <file.svg>] [--theme light|dark] [--scale <n>] [--icons color|grayscale]
  octo-draw push <input|-> [--server <url>]       replace the running editor's diagram
  octo-draw pull [-o <file>] [--to <format>] [--server <url>]
  octo-draw schema                                print the document JSON schema

Input is detected automatically: octo DSL, mermaid flowchart, ASCII box art
(markdown fences are fine), an octo document (.json), or a tldraw snapshot.
Formats:  --to ${OUTPUT_FORMATS.join(' | ')}    --from ${INPUT_FORMATS.join(' | ')}
Server:   --server, or OCTO_SERVER_URL (default http://localhost:8787)
Icons:    official AWS / Google Cloud / Azure icons are used when downloaded with
          \`pnpm icons:fetch --accept-terms\` (cache: OCTO_ICONS_DIR or ~/.cache/octo-draw/icons)

Examples:
  octo-draw convert flow.mmd --to octo > flow.octo
  octo-draw render flow.octo -o flow.svg --theme dark
  octo-draw convert canvas.tldraw.json --to json -o canvas.octo.json
  pbpaste | octo-draw push -
`

interface Args {
	positional: string[]
	flags: Record<string, string | true>
}

const SHORT: Record<string, string> = { o: 'out', t: 'to', h: 'help', f: 'from', s: 'server' }
const BOOLEAN = new Set(['help', 'version', 'quiet'])

export function parseArgs(argv: string[]): Args {
	const positional: string[] = []
	const flags: Record<string, string | true> = {}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === '--') {
			positional.push(...argv.slice(i + 1))
			break
		}
		const m = a.match(/^--([a-z-]+)(?:=(.*))?$/) ?? a.match(/^-([a-z])$/)
		if (!m) {
			positional.push(a)
			continue
		}
		const name = a.startsWith('--') ? m[1] : (SHORT[m[1]] ?? m[1])
		if (m[2] !== undefined) flags[name] = m[2]
		else if (BOOLEAN.has(name)) flags[name] = true
		else {
			const v = argv[i + 1]
			if (v === undefined || (v.startsWith('-') && v !== '-')) throw new CliError(`--${name} needs a value`)
			flags[name] = v
			i++
		}
	}
	return { positional, flags }
}

function str(args: Args, name: string): string | undefined {
	const v = args.flags[name]
	return typeof v === 'string' ? v : undefined
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T | undefined {
	if (value === undefined) return undefined
	if (!(allowed as readonly string[]).includes(value)) throw new CliError(`--${flag} must be one of ${allowed.join(', ')} (got "${value}")`)
	return value as T
}

const theme = (args: Args) => oneOf<RenderTheme>(str(args, 'theme'), ['light', 'dark'], 'theme')

async function readInput(io: IO, args: Args) {
	const path = args.positional[1]
	if (!path) throw new CliError(`missing input file (use - for stdin)\n\n${HELP}`)
	const text = path === '-' ? await io.readStdin() : await io.readFile(path)
	const loaded = loadInput(text, { name: path === '-' ? undefined : path, from: oneOf<InputFormat>(str(args, 'from'), INPUT_FORMATS, 'from'), title: str(args, 'title') })
	if (!args.flags.quiet) for (const w of loaded.warnings) io.stderr(`warning: ${w}\n`)
	return loaded
}

async function emit(io: IO, out: string | undefined, data: string) {
	if (out && out !== '-') {
		await io.writeFile(out, data)
		io.stderr(`wrote ${out}\n`)
	} else io.stdout(data)
}

function serverUrl(io: IO, args: Args) {
	return (str(args, 'server') ?? io.env.OCTO_SERVER_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
}

async function request(io: IO, base: string, method: string, path: string, body?: unknown) {
	let res: Response
	try {
		res = await io.fetch(`${base}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
	} catch {
		throw new CliError(`octo-draw server is not reachable at ${base} (start it with: pnpm dev)`)
	}
	const data = (await res.json().catch(() => ({}))) as { code?: string; version?: number; error?: string }
	if (!res.ok) throw new CliError(data.error ?? `server answered HTTP ${res.status}`)
	return data
}

export async function run(argv: string[], io: IO): Promise<number> {
	try {
		const args = parseArgs(argv)
		const cmd = args.positional[0]
		if (args.flags.version) {
			io.stdout('0.0.1\n')
			return 0
		}
		if (!cmd || args.flags.help || cmd === 'help') {
			io.stdout(HELP)
			return cmd || args.flags.help ? 0 : 1
		}
		switch (cmd) {
			case 'convert': {
				const out = str(args, 'out')
				const to = oneOf<OutputFormat>(str(args, 'to'), OUTPUT_FORMATS, 'to') ?? formatForOutput(out)
				if (!to) throw new CliError(`--to is required (${OUTPUT_FORMATS.join(', ')})`)
				const { doc } = await readInput(io, args)
				await emit(io, out, await convertDoc(doc, to, { theme: theme(args), iconsDir: defaultIconsDir(io.env) }))
				return 0
			}
			case 'render': {
				const { doc } = await readInput(io, args)
				const scale = str(args, 'scale') ? Number(str(args, 'scale')) : undefined
				if (scale !== undefined && !(scale > 0)) throw new CliError('--scale must be a positive number')
				const officialIcons = oneOf<'color' | 'grayscale'>(str(args, 'icons'), ['color', 'grayscale'], 'icons')
				await emit(io, str(args, 'out'), await convertDoc(doc, 'svg', { theme: theme(args), scale, officialIcons, iconsDir: defaultIconsDir(io.env) }))
				return 0
			}
			case 'push': {
				const { doc, format } = await readInput(io, args)
				const base = serverUrl(io, args)
				const r = await request(io, base, 'PUT', '/api/doc', { code: doc.code, source: 'cli' })
				io.stderr(`pushed ${format} as version ${r.version} to ${base}\n`)
				return 0
			}
			case 'pull': {
				const base = serverUrl(io, args)
				const out = str(args, 'out')
				const to = oneOf<OutputFormat>(str(args, 'to'), OUTPUT_FORMATS, 'to') ?? formatForOutput(out) ?? 'octo'
				const r = await request(io, base, 'GET', '/api/doc')
				const { doc } = loadInput(r.code ?? '', { from: 'octo', title: str(args, 'title') })
				await emit(io, out, await convertDoc(doc, to, { theme: theme(args), iconsDir: defaultIconsDir(io.env) }))
				return 0
			}
			case 'schema':
				io.stdout(JSON.stringify(OCTO_DOCUMENT_SCHEMA, null, '\t') + '\n')
				return 0
			default:
				throw new CliError(`unknown command "${cmd}"\n\n${HELP}`)
		}
	} catch (err) {
		io.stderr(`octo-draw: ${err instanceof CliError ? err.message : err instanceof Error ? err.message : String(err)}\n`)
		return err instanceof CliError ? 2 : 1
	}
}
