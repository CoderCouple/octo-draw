import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { NODE_SHAPES, pageNames } from '@octo-draw/core'
import { COLOR_NAMES } from '../lib/colors'
import { iconSvgString, loadIcons, loadLucide, searchIconNames } from '../lib/icons'
import { useStore } from '../store'
import { DIRECTIVES, KIND_HEADERS, SEQ_BLOCK_KEYWORDS, SEQ_CONT_KEYWORDS } from './language'

const NODE_PROPS: Completion[] = [
	{ label: 'shape', type: 'property', apply: 'shape: ', detail: 'rectangle, oval, diamond…' },
	{ label: 'icon', type: 'property', apply: 'icon: ', detail: 'aws-lambda, postgres, kafka…' },
	{ label: 'color', type: 'property', apply: 'color: ', detail: 'palette name or #hex' },
	{ label: 'label', type: 'property', apply: 'label: ', detail: 'display text' },
	{ label: 'link', type: 'property', apply: 'link: ', detail: 'URL' },
	{ label: 'drill', type: 'property', apply: 'drill: ', detail: 'page to open' },
]
const EDGE_PROPS: Completion[] = [
	{ label: 'id', type: 'property', apply: 'id: ', detail: 'edge id' },
	{ label: 'color', type: 'property', apply: 'color: ' },
	{ label: 'dash', type: 'property', apply: 'dash: ', detail: 'solid | dotted | dashed' },
]

const DIRECTIVE_VALUES: Record<string, string[]> = {
	direction: ['down', 'up', 'right', 'left'],
	colorMode: ['pastel', 'bold', 'outline'],
	styleMode: ['shadow', 'plain', 'watercolor'],
	typeface: ['clean', 'rough', 'mono'],
	autoNumber: ['on', 'off', 'nested'],
	notation: ['crows-feet', 'chen'],
	diagramType: ['flowchart', 'architecture', 'sequence', 'erd'],
}

const SEQ_SNIPPETS: Completion[] = [
	...SEQ_BLOCK_KEYWORDS.map((k) => ({ label: k, type: 'keyword', apply: `${k} [label: ] {`, detail: 'block' })),
	{ label: 'activate', type: 'keyword', apply: 'activate ' },
	{ label: 'deactivate', type: 'keyword', apply: 'deactivate ' },
	{ label: 'note over', type: 'keyword', apply: 'note over ', detail: 'note over A, B: text' },
	{ label: 'note left of', type: 'keyword', apply: 'note left of ' },
	{ label: 'note right of', type: 'keyword', apply: 'note right of ' },
	{ label: 'autoNumber', type: 'keyword', apply: 'autoNumber ' },
]
const ERD_SNIPPETS: Completion[] = [{ label: 'notation', type: 'keyword', apply: 'notation ', detail: 'crows-feet | chen' }]
const HEADER_SNIPPETS: Completion[] = KIND_HEADERS.map((k) => ({ label: k, type: 'keyword', detail: 'diagram type' }))
const FIELD_META: Completion[] = ['pk', 'fk', 'unique'].map((m) => ({ label: m, type: 'keyword' }))
const FIELD_TYPES: Completion[] = ['string', 'int', 'bigint', 'uuid', 'boolean', 'timestamp', 'date', 'float', 'decimal', 'json', 'text'].map((t) => ({ label: t, type: 'type' }))

const PROP_VALUES = (prop: string): Completion[] | null => {
	switch (prop) {
		case 'shape':
			return NODE_SHAPES.map((s) => ({ label: s, type: 'enum' }))
		case 'color':
			return COLOR_NAMES.map((c) => ({ label: c, type: 'constant' }))
		case 'dash':
			return ['solid', 'dotted', 'dashed'].map((d) => ({ label: d, type: 'enum' }))
		default:
			return null
	}
}

/** Completion type for icon names; `iconPreview` renders their glyph in the list. */
export const ICON_COMPLETION = 'octo-icon'

/** Ranked icon names for the text after `icon:` — catalog search (names, aliases, labels, tags), then lucide. */
async function iconCompletions(ctx: CompletionContext): Promise<CompletionResult> {
	// the query may contain spaces ("aws lam"); it starts after the spaces following `icon:`
	const word = ctx.matchBefore(/[\w.\- ]*$/)
	const lead = word ? word.text.length - word.text.trimStart().length : 0
	const from = word ? word.from + lead : ctx.pos
	await loadIcons()
	void loadLucide()
	const query = ctx.state.sliceDoc(from, ctx.pos)
	const options: Completion[] = searchIconNames(query, 60).map((h, i) => ({
		label: h.name,
		detail: h.matched ? `${h.label} · ${h.matched}` : h.label,
		type: ICON_COMPLETION,
		boost: 60 - i,
	}))
	// results are ranked by searchIcons; re-query on each keystroke instead of fuzzy-filtering
	return { from, options, filter: false }
}

/** `addToOptions` renderer: a small glyph before each icon completion. */
export const iconPreview = {
	position: 20,
	render(c: Completion): Node | null {
		if (c.type !== ICON_COMPLETION) return null
		const el = document.createElement('span')
		el.className = 'cm-octo-icon-preview'
		const svg = iconSvgString(c.label, 16)
		if (svg) el.innerHTML = svg
		return el
	},
}

export function octoCompletions(ctx: CompletionContext): CompletionResult | Promise<CompletionResult> | null {
	const line = ctx.state.doc.lineAt(ctx.pos)
	const before = line.text.slice(0, ctx.pos - line.from)

	// inside [ ... ]
	const open = before.lastIndexOf('[')
	const close = before.lastIndexOf(']')
	if (open > close) {
		const inside = before.slice(open + 1)
		const seg = inside.slice(inside.lastIndexOf(',') + 1)
		const colon = seg.indexOf(':')
		const isEdge = /\s(<>|-->|--|>|<|-)\s/.test(before.slice(0, open)) || /:\s*[^[]*$/.test(before.slice(0, open))
		if (colon >= 0) {
			const prop = seg.slice(0, colon).trim()
			if (prop === 'icon') return iconCompletions(ctx)
			if (prop === 'drill') {
				const names = pageNames(ctx.state.doc.toString()).filter(Boolean)
				if (!names.length) return null
				const word = ctx.matchBefore(/[^,:[\]"]*$/)
				const lead = word ? word.text.length - word.text.trimStart().length : 0
				return {
					from: word ? word.from + lead : ctx.pos,
					options: names.map((n) => ({ label: n, type: 'class', detail: 'page', apply: /[[\]{},:"]/.test(n) ? `"${n}"` : n })),
					validFor: /^[^,:[\]"]*$/,
				}
			}
			const values = PROP_VALUES(prop)
			if (!values) return null
			const word = ctx.matchBefore(/[\w#-]*$/)
			return { from: word ? word.from : ctx.pos, options: values, validFor: /^[\w#-]*$/ }
		}
		const word = ctx.matchBefore(/\w*$/)
		return { from: word ? word.from : ctx.pos, options: isEdge ? EDGE_PROPS : NODE_PROPS, validFor: /^\w*$/ }
	}

	// directive values
	const dm = /^\s*(direction|colorMode|styleMode|typeface|autoNumber|notation|diagramType)\s+([\w-]*)$/.exec(before)
	if (dm) {
		return {
			from: ctx.pos - dm[2].length,
			options: DIRECTIVE_VALUES[dm[1]].map((v) => ({ label: v, type: 'enum' })),
			validFor: /^[\w-]*$/,
		}
	}

	const kind = useStore.getState().ir?.kind
	// `} else` / `} and` after a sequence block
	if (kind === 'sequence' && /^\s*\}\s+\w*$/.test(before)) {
		const w = ctx.matchBefore(/\w*$/)
		return { from: w ? w.from : ctx.pos, options: SEQ_CONT_KEYWORDS.map((k) => ({ label: k, type: 'keyword', apply: `${k} [label: ] {` })), validFor: /^\w*$/ }
	}
	// ERD attribute rows: `name type pk`
	if (kind === 'erd' && isInsideBraces(ctx.state.doc.sliceString(0, ctx.pos))) {
		const m = /^\s*\S+\s+(\S+\s+)?(\w*)$/.exec(before)
		if (m) return { from: ctx.pos - m[2].length, options: m[1] ? FIELD_META : FIELD_TYPES, validFor: /^\w*$/ }
		return null
	}

	// node names (line start or after an operator / comma) + directives at line start
	const word = ctx.matchBefore(/[\w][\w .-]*$/)
	const atLineStart = /^\s*[\w .-]*$/.test(before)
	const afterOp = /(\s(<>|-->|--|>|<|-)\s+|,\s*)[\w .-]*$/.test(before)
	if (!atLineStart && !afterOp) return null
	if (!word && !ctx.explicit) return null
	const ir = useStore.getState().ir
	const names: Completion[] = (ir?.nodes ?? []).map((n) => ({ label: n.key, type: n.isContainer ? 'class' : 'variable', detail: n.label && n.label !== n.key ? n.label : undefined }))
	const kindWords = kind === 'sequence' ? SEQ_SNIPPETS : kind === 'erd' ? ERD_SNIPPETS : []
	const firstLine = line.number === 1 ? HEADER_SNIPPETS : []
	const options =
		atLineStart && !/^\s+/.test(before)
			? [...firstLine, ...DIRECTIVES.map((d) => ({ label: d, type: 'keyword', apply: d + ' ' })), ...kindWords, ...names]
			: atLineStart && kind === 'sequence'
				? [...SEQ_SNIPPETS, ...names]
				: names
	let from = word ? word.from : ctx.pos
	if (afterOp && word) {
		const m = /(\s(<>|-->|--|>|<|-)\s+|,\s*)([\w .-]*)$/.exec(before)
		if (m) from = ctx.pos - m[3].length
	}
	return { from, options, validFor: /^[\w .-]*$/ }
}

/** Is the cursor inside an unclosed `{` (ignoring strings and comments)? */
function isInsideBraces(text: string): boolean {
	let depth = 0
	for (const raw of text.split('\n')) {
		const l = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/(^|\s)\/\/.*$/, '')
		for (const ch of l) {
			if (ch === '{') depth++
			else if (ch === '}') depth = Math.max(0, depth - 1)
		}
	}
	return depth > 0
}
