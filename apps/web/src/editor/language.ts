import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

interface OctoState {
	/** inside a `[ ... ]` property list */
	inProps: boolean
	/** after a `key:` inside props, expecting a value */
	expectValue: boolean
	/** after `:` outside props (edge label) */
	inLabel: boolean
	lineStart: boolean
}

export const DIRECTIVES = ['title', 'direction', 'colorMode', 'styleMode', 'typeface']
/** Directive-like keywords of the sequence / ERD grammars (and the `diagramType` header). */
export const KIND_DIRECTIVES = ['autoNumber', 'notation', 'diagramType']
export const KIND_HEADERS = ['flowchart', 'architecture', 'sequence', 'erd']
export const SEQ_BLOCK_KEYWORDS = ['loop', 'alt', 'opt', 'par', 'break', 'critical']
export const SEQ_CONT_KEYWORDS = ['else', 'and', 'option']
export const SEQ_KEYWORDS = ['activate', 'deactivate', 'note']
const HAS_OP = /\s(<>|-->|--|>|<|-)(\s|$)/
const OPERATORS = ['<>', '-->', '--', '>', '<', '-']

function tokenize(stream: StringStream, state: OctoState): string | null {
	if (stream.sol()) {
		state.lineStart = true
		state.inLabel = false
		if (!state.inProps) state.expectValue = false
	}
	if (stream.eatSpace()) return null
	const atStart = state.lineStart
	state.lineStart = false

	// comments
	if (stream.match('//') || (stream.peek() === '#' && !state.inProps)) {
		stream.skipToEnd()
		return 'comment'
	}
	// strings
	if (stream.peek() === '"') {
		stream.next()
		let escaped = false
		let ch: string | void
		while ((ch = stream.next()) != null) {
			if (ch === '"' && !escaped) break
			escaped = ch === '\\' && !escaped
		}
		if (state.inProps) {
			state.expectValue = false
			return 'string'
		}
		return state.inLabel ? 'string' : 'variableName'
	}
	if (state.inProps) {
		if (stream.eat(']')) {
			state.inProps = false
			state.expectValue = false
			return 'squareBracket'
		}
		if (stream.eat(',')) {
			state.expectValue = false
			return 'punctuation'
		}
		if (stream.eat(':')) {
			state.expectValue = true
			return 'punctuation'
		}
		if (state.expectValue) {
			stream.match(/^[^,\]]+/)
			const v = stream.current().trim()
			state.expectValue = false
			if (/^#[0-9a-f]{3,6}$/i.test(v)) return 'color'
			if (/^\d/.test(v)) return 'number'
			return 'atom'
		}
		stream.match(/^[A-Za-z_][\w-]*/) || stream.next()
		return 'propertyName'
	}
	if (stream.eat('[')) {
		state.inProps = true
		state.expectValue = false
		return 'squareBracket'
	}
	if (stream.eat('{') || stream.eat('}')) return 'brace'
	if (stream.eat(',')) return 'punctuation'
	if (state.inLabel) {
		stream.match(/^[^[\n]+/)
		return 'string'
	}
	if (stream.eat(':')) {
		state.inLabel = true
		return 'punctuation'
	}
	// operators need whitespace on both sides
	for (const op of OPERATORS) {
		if (stream.match(op, false)) {
			const before = stream.pos === 0 || /\s/.test(stream.string[stream.pos - 1])
			const after = stream.string[stream.pos + op.length]
			if (before && (after === undefined || /\s/.test(after))) {
				stream.pos += op.length
				return 'operator'
			}
		}
	}
	const line = stream.string
	const before = line.slice(0, stream.pos)
	if (!HAS_OP.test(line)) {
		// header line: `sequence`, `erd`, ...
		if (atStart && stream.match(new RegExp(`^(${KIND_HEADERS.join('|')})\\s*$`))) return 'keyword'
		if (atStart) {
			for (const d of KIND_DIRECTIVES) {
				if (stream.match(new RegExp(`^${d}(?=\\s|$)`))) {
					state.inLabel = true
					return 'keyword'
				}
			}
			if (stream.match(new RegExp(`^(${[...SEQ_BLOCK_KEYWORDS, ...SEQ_KEYWORDS].join('|')})(?=[\\s[{]|$)`))) return 'keyword'
		}
		if (/^\s*\}\s*$/.test(before) && stream.match(new RegExp(`^(${SEQ_CONT_KEYWORDS.join('|')})(?=[\\s[{]|$)`))) return 'keyword'
		if (/^\s*note\s+$/.test(before) && stream.match(/^(over|left of|right of|left|right)(?=\s)/)) return 'keyword'
	}
	if (atStart) {
		for (const d of DIRECTIVES) {
			if (stream.match(new RegExp(`^${d}(?=\\s|$)`))) {
				state.inLabel = true
				return 'keyword'
			}
		}
	}
	// a name: up to an operator, bracket, brace, comma or colon
	let consumed = false
	while (!stream.eol()) {
		const rest = stream.string.slice(stream.pos)
		if (/^[[\]{},:"]/.test(rest)) break
		if (/^\/\//.test(rest)) break
		if (/^\s(<>|-->|--|>|<|-)(\s|$)/.test(rest)) break
		stream.next()
		consumed = true
	}
	if (!consumed) stream.next()
	return 'variableName'
}

export const octoLanguage = StreamLanguage.define<OctoState>({
	name: 'octo',
	startState: () => ({ inProps: false, expectValue: false, inLabel: false, lineStart: true }),
	copyState: (s) => ({ ...s }),
	token: tokenize,
	languageData: { commentTokens: { line: '//' } },
	tokenTable: {
		squareBracket: t.squareBracket,
		brace: t.brace,
		punctuation: t.punctuation,
		color: t.color,
	},
})

export const octoHighlight = syntaxHighlighting(
	HighlightStyle.define([
		{ tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
		{ tag: t.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
		{ tag: t.operator, color: 'var(--syn-operator)', fontWeight: '700' },
		{ tag: t.string, color: 'var(--syn-string)' },
		{ tag: t.propertyName, color: 'var(--syn-prop)', fontStyle: 'italic' },
		{ tag: t.atom, color: 'var(--syn-atom)' },
		{ tag: t.number, color: 'var(--syn-atom)' },
		{ tag: t.color, color: 'var(--syn-atom)' },
		{ tag: t.variableName, color: 'var(--syn-name)' },
		{ tag: [t.squareBracket, t.brace], color: 'var(--syn-bracket)' },
		{ tag: t.punctuation, color: 'var(--syn-bracket)' },
	]),
)
