/**
 * TS/JS tokenizer for symbol extraction. Comments are dropped; strings,
 * template pieces, regex literals and numbers are single tokens; identifiers
 * inside template `${}` expressions and JSX expression containers are real
 * tokens. Regex vs division is decided by the previous significant token.
 * JSX (opt-in) emits tag names as identifiers (`jsx: true`), attribute values
 * as strings and text content as `jsx-text`. Never throws; unterminated
 * constructs end at EOF (or the line end for strings / regexes).
 */

import { lineAt, lineStarts } from './types'

export interface JsToken {
	type: 'ident' | 'keyword' | 'punct' | 'string' | 'template' | 'regex' | 'number' | 'jsx-text' | 'private'
	value: string
	start: number
	end: number
	/** 1-based line of `start`. */
	line: number
	/** First token on its line. */
	nl: boolean
	/** JSX tag name (`<Foo` / `<Foo.Bar`). */
	jsx?: boolean
}

export const JS_KEYWORDS = new Set([
	'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
	'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this',
	'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'await',
])

/** Keywords after which an expression can NOT start (so `/` is division). */
const VALUE_KEYWORDS = new Set(['this', 'super', 'null', 'true', 'false'])

const PUNCTS = [
	'>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
	'=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
]

function isIdStart(c: number): boolean {
	return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 36 || c === 95 || (c > 127 && c !== 0xa0 && c !== 0xfeff && c !== 0x2028 && c !== 0x2029)
}

function isIdPart(c: number): boolean {
	return isIdStart(c) || (c >= 48 && c <= 57)
}

function isDigit(c: number): boolean {
	return c >= 48 && c <= 57
}

function isWs(c: number): boolean {
	return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029
}

export function tokenizeJs(text: string, opts: { jsx?: boolean; ts?: boolean } = {}): JsToken[] {
	const n = text.length
	const starts = lineStarts(text)
	const toks: JsToken[] = []
	const jsx = !!opts.jsx
	let i = 0
	let regexOk = true
	let lastLine = 0
	let guard = 0

	const push = (type: JsToken['type'], start: number, end: number, value = text.slice(start, end)): JsToken => {
		const line = lineAt(starts, start)
		const t: JsToken = { type, value, start, end, line, nl: line !== lastLine }
		lastLine = line
		toks.push(t)
		return t
	}

	const skipWsAndComments = (): void => {
		while (i < n) {
			const c = text.charCodeAt(i)
			if (isWs(c)) {
				i++
				continue
			}
			if (c === 47 && text.charCodeAt(i + 1) === 47) {
				while (i < n && text.charCodeAt(i) !== 10) i++
				continue
			}
			if (c === 47 && text.charCodeAt(i + 1) === 42) {
				const e = text.indexOf('*/', i + 2)
				i = e < 0 ? n : e + 2
				continue
			}
			break
		}
	}

	const readString = (q: number): void => {
		const s = i
		i++
		while (i < n) {
			const c = text.charCodeAt(i)
			if (c === 92) {
				i += 2
				continue
			}
			if (c === q) {
				i++
				break
			}
			if (c === 10) break
			i++
		}
		if (i > n) i = n
		push('string', s, i)
		regexOk = false
	}

	/** Template literal at '`': pieces are `template` tokens, `${}` contents are tokenized. */
	const readTemplate = (): void => {
		let s = i
		i++
		while (i < n) {
			const c = text.charCodeAt(i)
			if (c === 92) {
				i += 2
				continue
			}
			if (c === 96) {
				i++
				push('template', s, Math.min(i, n))
				regexOk = false
				return
			}
			if (c === 36 && text.charCodeAt(i + 1) === 123) {
				push('template', s, i + 2)
				i += 2
				regexOk = true
				run(true)
				s = i
				continue
			}
			i++
		}
		if (s < n) push('template', s, n)
		i = n
		regexOk = false
	}

	const readRegex = (): boolean => {
		const s = i
		let j = i + 1
		let inClass = false
		while (j < n) {
			const c = text.charCodeAt(j)
			if (c === 10) return false
			if (c === 92) {
				j += 2
				continue
			}
			if (c === 91) inClass = true
			else if (c === 93) inClass = false
			else if (c === 47 && !inClass) break
			j++
		}
		if (j >= n) return false
		j++
		while (j < n && isIdPart(text.charCodeAt(j))) j++
		i = j
		push('regex', s, j)
		regexOk = false
		return true
	}

	const readNumber = (): void => {
		const s = i
		while (i < n) {
			const c = text.charCodeAt(i)
			if (isIdPart(c) || c === 46) {
				// exponent sign
				if ((c === 101 || c === 69) && (text[i + 1] === '+' || text[i + 1] === '-') && !/^0[xX]/.test(text.slice(s, i))) i++
				i++
				continue
			}
			break
		}
		push('number', s, i)
		regexOk = false
	}

	const readIdent = (): string => {
		const s = i
		while (i < n && isIdPart(text.charCodeAt(i))) i++
		return text.slice(s, i)
	}

	/** In expression position at '<': is this JSX (not a generic `<T,>` / `<T extends`)? */
	const looksLikeJsx = (): boolean => {
		const c = text.charCodeAt(i + 1)
		if (c === 62) return true // fragment <>
		if (!isIdStart(c)) return false
		let j = i + 1
		while (j < n && isIdPart(text.charCodeAt(j))) j++
		const name = text.slice(i + 1, j)
		while (j < n && (text[j] === ' ' || text[j] === '\t')) j++
		if (text[j] === ',') return false
		if (/^extends\b/.test(text.slice(j, j + 8)) && !/^extends\s*=/.test(text.slice(j, j + 12))) return false
		return name.length > 0
	}

	const readJsxElement = (): void => {
		// at '<'
		i++
		if (text[i] === '>') {
			i++
			readJsxChildren()
			regexOk = false
			return
		}
		skipWsAndComments()
		// tag name (Foo.Bar, foo-bar, ns:tag)
		while (i < n && isIdStart(text.charCodeAt(i))) {
			const s = i
			while (i < n && (isIdPart(text.charCodeAt(i)) || text[i] === '-' || text[i] === ':')) i++
			const t = push(/^[A-Z_$]/.test(text[s]) || text[i] === '.' || (toks.length && toks[toks.length - 1].value === '.' && toks[toks.length - 1].jsx) ? 'ident' : 'jsx-text', s, i)
			t.jsx = true
			if (text[i] === '.') {
				const d = push('punct', i, i + 1)
				d.jsx = true
				i++
				continue
			}
			break
		}
		// type arguments on components: <Foo<Bar> ...> (TSX) — skip
		if (text[i] === '<') {
			let depth = 0
			while (i < n) {
				if (text[i] === '<') depth++
				else if (text[i] === '>') {
					depth--
					if (depth === 0) {
						i++
						break
					}
				}
				i++
			}
		}
		for (let g = 0; i < n && g < 100000; g++) {
			skipWsAndComments()
			const c = text[i]
			if (c === '/' && text[i + 1] === '>') {
				i += 2
				regexOk = false
				return
			}
			if (c === '>') {
				i++
				readJsxChildren()
				regexOk = false
				return
			}
			if (c === '{') {
				i++
				regexOk = true
				run(true)
				continue
			}
			if (c !== undefined && isIdStart(c.charCodeAt(0))) {
				while (i < n && (isIdPart(text.charCodeAt(i)) || text[i] === '-' || text[i] === ':')) i++
				skipWsAndComments()
				if (text[i] === '=') {
					i++
					skipWsAndComments()
					const v = text[i]
					if (v === '"' || v === "'") {
						const s = i
						const e = text.indexOf(v, i + 1)
						i = e < 0 ? n : e + 1
						push('string', s, i)
					} else if (v === '{') {
						i++
						regexOk = true
						run(true)
					} else if (v === '<') {
						readJsxElement()
					}
				}
				continue
			}
			i++
		}
		regexOk = false
	}

	const readJsxChildren = (): void => {
		for (let g = 0; i < n && g < 1000000; g++) {
			const c = text[i]
			if (c === '{') {
				i++
				regexOk = true
				run(true)
				continue
			}
			if (c === '<') {
				if (text[i + 1] === '/') {
					const e = text.indexOf('>', i)
					i = e < 0 ? n : e + 1
					return
				}
				readJsxElement()
				continue
			}
			const s = i
			while (i < n && text[i] !== '{' && text[i] !== '<') i++
			const raw = text.slice(s, i)
			if (raw.trim()) {
				const lead = raw.length - raw.trimStart().length
				push('jsx-text', s + lead, s + lead + raw.trim().length, raw.trim())
			}
		}
	}

	/** Tokenizes until EOF, or (endOnBrace) until the `}` that closes the current expression container. */
	function run(endOnBrace: boolean): void {
		let depth = 0
		while (i < n) {
			if (++guard > 50_000_000) {
				i = n
				return
			}
			skipWsAndComments()
			if (i >= n) return
			const c = text.charCodeAt(i)
			if (c === 34 || c === 39) {
				readString(c)
				continue
			}
			if (c === 96) {
				readTemplate()
				continue
			}
			if (isIdStart(c) || c === 92) {
				const s = i
				if (c === 92) i++ // \u escapes: rare, treat as ident char
				const id = readIdent()
				const kw = JS_KEYWORDS.has(id)
				push(kw ? 'keyword' : 'ident', s, i)
				regexOk = kw ? !VALUE_KEYWORDS.has(id) : false
				continue
			}
			if (isDigit(c) || (c === 46 && isDigit(text.charCodeAt(i + 1)))) {
				readNumber()
				continue
			}
			if (c === 35) {
				// #private, or a shebang at the very start
				if (i === 0 && text[1] === '!') {
					while (i < n && text.charCodeAt(i) !== 10) i++
					continue
				}
				if (isIdStart(text.charCodeAt(i + 1))) {
					const s = i
					i++
					readIdent()
					push('private', s, i)
					regexOk = false
					continue
				}
				push('punct', i, i + 1)
				i++
				regexOk = true
				continue
			}
			if (c === 47) {
				if (regexOk && readRegex()) continue
				const two = text[i + 1] === '='
				push('punct', i, i + (two ? 2 : 1))
				i += two ? 2 : 1
				regexOk = true
				continue
			}
			if (c === 60 && jsx && regexOk && looksLikeJsx()) {
				readJsxElement()
				continue
			}
			if (c === 123) {
				depth++
				push('punct', i, i + 1)
				i++
				regexOk = true
				continue
			}
			if (c === 125) {
				if (depth === 0 && endOnBrace) {
					i++
					return
				}
				depth = Math.max(0, depth - 1)
				push('punct', i, i + 1)
				i++
				regexOk = false
				continue
			}
			let p = ''
			for (const cand of PUNCTS) {
				if (text.startsWith(cand, i)) {
					p = cand
					break
				}
			}
			if (p === '?.' && isDigit(text.charCodeAt(i + 2))) p = '?'
			if (!p) p = text[i]
			push('punct', i, i + p.length)
			i += p.length
			regexOk = !(p === ')' || p === ']' || p === '++' || p === '--')
		}
	}

	run(false)
	return toks
}
