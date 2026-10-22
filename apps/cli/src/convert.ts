/** Input detection and output conversion, shared by every command. */

import {
	createDocument,
	detectFormat,
	fromTldrawSnapshot,
	importText,
	isTldrawSnapshot,
	layoutDiagram,
	migrateDocument,
	parseOcto,
	printOcto,
	renderDocumentSvg,
	serializeDocument,
	toMermaid,
	toTldrawSnapshot,
	type DiagramIR,
	type OctoDocument,
	type RenderTheme,
} from '@octo-draw/core'
import { loadIconResolver } from './icons'

export type InputFormat = 'octo' | 'mermaid' | 'ascii' | 'json' | 'tldraw'
export type OutputFormat = 'octo' | 'mermaid' | 'svg' | 'json' | 'tldraw'

export const INPUT_FORMATS: readonly InputFormat[] = ['octo', 'mermaid', 'ascii', 'json', 'tldraw']
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['octo', 'mermaid', 'svg', 'json', 'tldraw']

export interface Loaded {
	doc: OctoDocument
	format: InputFormat
	warnings: string[]
}

export class CliError extends Error {}

const EXT_FORMAT: Record<string, InputFormat> = {
	octo: 'octo',
	eraser: 'octo',
	mmd: 'mermaid',
	mermaid: 'mermaid',
	tldr: 'tldraw',
}

/** Format implied by a file name, if any (`.octo`, `.mmd`, `.tldr`, …). JSON is sniffed by content. */
export function formatFromName(name: string | undefined): InputFormat | undefined {
	const ext = name?.match(/\.([a-z]+)$/i)?.[1]?.toLowerCase()
	return ext ? EXT_FORMAT[ext] : undefined
}

function fromJson(value: unknown, warnings: string[], title?: string): Loaded {
	if (isTldrawSnapshot(value)) {
		return { doc: fromTldrawSnapshot(value, { title, onWarning: (w) => warnings.push(w) }), format: 'tldraw', warnings }
	}
	const o = value as Record<string, unknown> | null
	// The web app's "Export JSON" ({ title, ir, layout, drawing, pins }).
	if (o && typeof o === 'object' && o.ir && typeof o.code !== 'string') {
		const doc = createDocument({
			title: typeof o.title === 'string' ? o.title : title,
			code: printOcto(o.ir as DiagramIR),
			pins: (o.pins as OctoDocument['pins']) ?? {},
			shapes: Array.isArray(o.drawing) ? (o.drawing as OctoDocument['shapes']) : [],
		})
		return { doc: migrateDocument(doc), format: 'json', warnings }
	}
	try {
		const doc = migrateDocument(value)
		return { doc: title ? { ...doc, title } : doc, format: 'json', warnings }
	} catch (err) {
		throw new CliError(`JSON input is neither an octo document nor a tldraw snapshot: ${(err as Error).message}`)
	}
}

/**
 * Reads any supported input into a document: octo DSL, mermaid, ASCII box
 * art (markdown fences ok), an OctoDocument JSON (any version), the web app's
 * JSON export, or a tldraw snapshot.
 */
export function loadInput(text: string, opts: { name?: string; from?: InputFormat; title?: string } = {}): Loaded {
	const warnings: string[] = []
	const from = opts.from ?? formatFromName(opts.name)
	const trimmed = text.trim()
	if (from === 'json' || from === 'tldraw' || (!from && /^[{[]/.test(trimmed))) {
		let value: unknown
		try {
			value = JSON.parse(trimmed)
		} catch (err) {
			if (from) throw new CliError(`invalid JSON: ${(err as Error).message}`)
			value = undefined
		}
		if (value !== undefined) return fromJson(value, warnings, opts.title)
	}
	const title = opts.title ?? opts.name?.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
	const format = from ?? detectFormat(text)
	if (format === 'octo') {
		const { diagnostics, ir } = parseOcto(text)
		for (const d of diagnostics) warnings.push(`${d.severity}: ${d.message} (offset ${d.from})`)
		return { doc: createDocument({ code: text, title: ir.title ?? title }), format: 'octo', warnings }
	}
	const r = importText(text)
	if (!r || r.ir.nodes.length === 0) throw new CliError('could not recognise a diagram in the input (expected octo, mermaid, ASCII box art, JSON document or tldraw snapshot)')
	for (const d of r.diagnostics) warnings.push(`${d.severity}: ${d.message}`)
	const fmt: InputFormat = r.format === 'mermaid' ? 'mermaid' : r.format === 'ascii' ? 'ascii' : 'octo'
	return { doc: createDocument({ code: printOcto(r.ir), title: r.ir.title ?? title }), format: fmt, warnings }
}

export interface ConvertOptions {
	theme?: RenderTheme
	scale?: number
	/** Draw vector icons (default true); false keeps text badges. */
	icons?: boolean
}

export async function convertDoc(doc: OctoDocument, to: OutputFormat, opts: ConvertOptions = {}): Promise<string> {
	switch (to) {
		case 'octo':
			return doc.code.endsWith('\n') || !doc.code ? doc.code : doc.code + '\n'
		case 'mermaid':
			return toMermaid(parseOcto(doc.code).ir)
		case 'json':
			return serializeDocument(doc)
		case 'svg':
			return (await renderDocumentSvg(doc, { theme: opts.theme, scale: opts.scale, icon: opts.icons === false ? false : await loadIconResolver() })) + '\n'
		case 'tldraw': {
			const layout = await layoutDiagram(parseOcto(doc.code).ir, { pinned: doc.pins })
			return JSON.stringify(toTldrawSnapshot(doc, layout), null, '\t') + '\n'
		}
	}
}

/** Output format implied by an output file name. */
export function formatForOutput(name: string | undefined): OutputFormat | undefined {
	const ext = name?.match(/\.([a-z]+)$/i)?.[1]?.toLowerCase()
	if (!ext) return undefined
	if (ext === 'svg') return 'svg'
	if (ext === 'json') return name!.toLowerCase().endsWith('.tldraw.json') ? 'tldraw' : 'json'
	if (ext === 'tldr') return 'tldraw'
	if (ext === 'mmd' || ext === 'mermaid') return 'mermaid'
	if (ext === 'octo' || ext === 'eraser') return 'octo'
	return undefined
}
