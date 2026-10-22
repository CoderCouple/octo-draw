/**
 * Paste/import classifier: figures out whether text is mermaid, octo DSL,
 * an ASCII/Unicode box diagram or plain prose, and converts it to IR.
 */
import { parseAscii } from '../ascii/parse'
import { KIND_HEADERS, parseOcto } from '../dsl/parse'
import type { DiagramIR, Diagnostic } from '../ir'
import { parseMermaid } from '../mermaid/parse'

export type TextFormat = 'octo' | 'mermaid' | 'ascii' | 'plain'

export interface ImportResult {
	format: TextFormat
	ir: DiagramIR
	diagnostics: Diagnostic[]
	/** ASCII imports only: how sure the parser is (0..1). */
	confidence?: number
}

const MERMAID_LANGS = new Set(['mermaid', 'mmd'])
const OCTO_LANGS = new Set(['octo', 'eraser', 'octo-draw', 'octodraw'])
const DIAGRAM_LANGS = new Set([...MERMAID_LANGS, ...OCTO_LANGS, 'text', 'txt', 'ascii', 'plaintext', ''])

const MERMAID_EXACT = new Set([
	'sequenceDiagram',
	'classDiagram',
	'classDiagram-v2',
	'stateDiagram',
	'stateDiagram-v2',
	'erDiagram',
	'gantt',
	'journey',
	'gitGraph',
	'mindmap',
	'timeline',
	'quadrantChart',
	'requirementDiagram',
	'C4Context',
	'C4Container',
	'C4Component',
	'C4Dynamic',
	'C4Deployment',
	'sankey-beta',
	'xychart-beta',
	'block-beta',
	'packet-beta',
	'kanban',
	'architecture-beta',
	'radar-beta',
	'treemap-beta',
	'zenuml',
])

export interface Unfenced {
	body: string
	/** Fence info string (language), lowercased; undefined when not fenced. */
	lang?: string
}

/** Strip markdown code fences. Prefers a diagram-language block when there are several. */
export function unfence(text: string): Unfenced {
	const re = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*([\w+.-]*)[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[`~]*[ \t]*(?=\n|$)|$)/g
	const blocks: Unfenced[] = []
	let m: RegExpExecArray | null
	while ((m = re.exec(text))) {
		blocks.push({ lang: m[3].toLowerCase(), body: m[4] })
		if (m[0].length === 0) re.lastIndex++
	}
	if (!blocks.length) return { body: text }
	const pick =
		blocks.find((b) => MERMAID_LANGS.has(b.lang!) || OCTO_LANGS.has(b.lang!)) ??
		blocks.find((b) => DIAGRAM_LANGS.has(b.lang!)) ??
		blocks[0]
	return pick
}

function meaningfulLines(body: string): string[] {
	let src = body
	const fm = /^\s*---[ \t]*\n[\s\S]*?\n[ \t]*---[ \t]*(\n|$)/.exec(src)
	if (fm) src = src.slice(fm[0].length)
	return src
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('%%'))
}

/** Strict mermaid sniffing: the first non-comment line must be a diagram header. */
export function looksMermaid(body: string): boolean {
	const first = meaningfulLines(body)[0]
	if (!first) return false
	if (/^(flowchart|graph)(-elk)?\s+(TD|TB|BT|LR|RL)\b/.test(first)) return true
	if (/^(flowchart|graph)\s*;?$/.test(first)) return true
	if (MERMAID_EXACT.has(first.replace(/;$/, ''))) return true
	if (/^pie(\s+(showData|title\s.+))?$/.test(first)) return true
	if (/^xychart-beta(\s+(horizontal|vertical))?$/.test(first)) return true
	return false
}

const BOX_CHARS = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬╭╮╯╰━┃▶◀▲▼►◄]/g
const TREE_LINE = /^[\s│|]*(├──|└──|\|--|\+--|`--)\s*\S/

function boxScore(body: string): number {
	const nonSpace = body.replace(/\s/g, '').length
	if (!nonSpace) return 0
	const uni = (body.match(BOX_CHARS) ?? []).length
	const asciiBoxes = (body.match(/\+[-=]{2,}\+/g) ?? []).length
	const lines = body.split('\n')
	const tree = lines.filter((l) => TREE_LINE.test(l)).length
	let score = Math.min(1, (uni / nonSpace) * 4)
	if (/[┌╔╭+]/.test(body) && uni >= 4) score = Math.max(score, 0.6)
	if (asciiBoxes >= 2 && /\|/.test(body)) score = Math.max(score, 0.7)
	if (tree >= 2) score = Math.max(score, 0.8)
	return score
}

const OCTO_OPS = String.raw`(?:<>|-->|--|>|<|-)`
const OCTO_NAME = String.raw`(?:"[^"]+"|[^\s\[\]{}:,"<>]+(?: [^\s\[\]{}:,"<>]+){0,4})`
const OCTO_CONN = new RegExp(String.raw`^${OCTO_NAME}(?:\s*,\s*${OCTO_NAME})*\s+${OCTO_OPS}\s+${OCTO_NAME}`)
const OCTO_DIRECTIVE = /^(title\s+\S|direction\s+(down|up|right|left)\b|colorMode\s+(pastel|bold|outline)\b|styleMode\s+(shadow|plain|watercolor)\b|typeface\s+(rough|clean|mono)\b)/
const OCTO_DECL = /^(?:"[^"]+"|[^\[\]{}"]+?)\s*\[\s*[\w-]+\s*(?::[^\]]*)?(?:,[^\]]*)?\]\s*\{?\s*$/
const OCTO_GROUP = /^(?:"[^"]+"|[^\[\]{}"]+?)\s*(\[[^\]]*\])?\s*\{\s*$|^\}$/

/** Heuristic + parse check for the octo DSL. */
export function looksOcto(body: string): boolean {
	const lines = body
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('//') && !l.startsWith('#'))
	if (!lines.length) return false
	let strong = 0
	let ok = 0
	// `sequence` / `erd` / `diagramType x` header
	if (KIND_HEADERS[lines[0]] || /^diagramType\s+\S+$/.test(lines[0])) strong++
	for (const l of lines) {
		const line = l.replace(/\s+\/\/.*$/, '')
		const sentence = line.length > 100 || /[.!?]$/.test(line) || /\.\s+[A-Z]/.test(line)
		if (OCTO_DIRECTIVE.test(line) || OCTO_DECL.test(line)) {
			strong++
			ok++
		} else if (!sentence && OCTO_CONN.test(line)) {
			strong++
			ok++
		} else if (OCTO_GROUP.test(line)) ok++
		else if (!sentence && /^[\w"'][\w\s"'-]{0,40}$/.test(line) && line.split(/\s+/).length <= 4) ok += 0.5
	}
	if (!strong || ok / lines.length < 0.6) return false
	const { diagnostics } = parseOcto(body)
	const errs = diagnostics.filter((d) => d.severity === 'error').length
	return errs <= Math.floor(lines.length * 0.2)
}

interface Detection {
	format: TextFormat
	body: string
	ascii?: ReturnType<typeof parseAscii>
}

function detect(text: string): Detection {
	const { body, lang } = unfence(text)
	if (lang && MERMAID_LANGS.has(lang)) return { format: 'mermaid', body }
	if (lang && OCTO_LANGS.has(lang)) return { format: 'octo', body }
	if (!body.trim()) return { format: 'plain', body }
	if (looksMermaid(body)) return { format: 'mermaid', body }

	const score = boxScore(body)
	if (score >= 0.35) {
		const ascii = parseAscii(body)
		if (ascii.ir.nodes.length && ascii.confidence >= 0.45) return { format: 'ascii', body, ascii }
	}
	if (looksOcto(body)) return { format: 'octo', body }

	// Weak ASCII: arrow chains (`A -> B`, `[x] --> [y]`, `a → b`) in short lines.
	const lines = body.split('\n').filter((l) => l.trim())
	const arrowy = /(-+>|<-+|=+>|→|←|⟶|──|▶|▼)/.test(body) || /^\s*[|v^]\s*$/m.test(body)
	const shortLines = lines.filter((l) => l.length <= 100).length / lines.length
	if (arrowy && shortLines >= 0.8) {
		const ascii = parseAscii(body)
		if (ascii.ir.nodes.length >= 2 && ascii.ir.edges.length && ascii.confidence >= 0.6) return { format: 'ascii', body, ascii }
	}
	return { format: 'plain', body }
}

export function detectFormat(text: string): TextFormat {
	return detect(text).format
}

export function importText(text: string): ImportResult | null {
	const d = detect(text)
	switch (d.format) {
		case 'mermaid': {
			const r = parseMermaid(d.body)
			return { format: 'mermaid', ir: r.ir, diagnostics: r.diagnostics }
		}
		case 'octo': {
			const r = parseOcto(d.body)
			return { format: 'octo', ir: r.ir, diagnostics: r.diagnostics }
		}
		case 'ascii': {
			const r = d.ascii ?? parseAscii(d.body)
			return { format: 'ascii', ir: r.ir, diagnostics: r.diagnostics, confidence: r.confidence }
		}
		default:
			return null
	}
}
