/**
 * A small HCL block scanner (not a parser): finds top-level blocks
 * (`resource "aws_s3_bucket" "logs" { ... }`, `module "vpc" { ... }`),
 * their body text with comments and string contents blanked out of the way
 * of brace matching, and simple `key = value` attributes.
 */

export interface HclBlock {
	type: string
	labels: string[]
	/** Body without the outer braces, comments removed (strings kept). */
	body: string
	/** 1-based line of the block header. */
	line: number
}

/** Removes comments; keeps strings and heredocs intact. */
export function stripComments(src: string): string {
	let out = ''
	let i = 0
	while (i < src.length) {
		const c = src[i]
		const n = src[i + 1]
		if (c === '"') {
			const end = skipString(src, i)
			out += src.slice(i, end)
			i = end
		} else if (c === '<' && n === '<' && /^<<-?[A-Z_a-z]/.test(src.slice(i, i + 4))) {
			const m = /^<<-?([A-Za-z_][A-Za-z0-9_]*)[^\n]*\n/.exec(src.slice(i))
			if (!m) {
				out += c
				i++
				continue
			}
			const close = new RegExp(`\\n\\s*${m[1]}\\s*(\\n|$)`, 'g')
			close.lastIndex = i + m[0].length - 1
			const hit = close.exec(src)
			const end = hit ? hit.index + hit[0].length : src.length
			out += src.slice(i, end)
			i = end
		} else if (c === '#' || (c === '/' && n === '/')) {
			while (i < src.length && src[i] !== '\n') i++
		} else if (c === '/' && n === '*') {
			const end = src.indexOf('*/', i + 2)
			const chunk = src.slice(i, end < 0 ? src.length : end + 2)
			out += chunk.replace(/[^\n]/g, ' ')
			i = end < 0 ? src.length : end + 2
		} else {
			out += c
			i++
		}
	}
	return out
}

/** Index just past the closing quote of the string starting at `i` (handles `${ ... }` with nested strings). */
function skipString(s: string, i: number): number {
	let j = i + 1
	let depth = 0
	while (j < s.length) {
		const c = s[j]
		if (c === '\\') {
			j += 2
			continue
		}
		if (c === '$' && s[j + 1] === '{') {
			depth++
			j += 2
			continue
		}
		if (depth > 0) {
			if (c === '}') depth--
			else if (c === '"') {
				j = skipString(s, j)
				continue
			}
			j++
			continue
		}
		if (c === '"') return j + 1
		if (c === '\n') return j
		j++
	}
	return j
}

/** Index of the brace matching the `{` at `open`, ignoring braces in strings. */
function matchBrace(s: string, open: number): number {
	let depth = 0
	for (let i = open; i < s.length; i++) {
		const c = s[i]
		if (c === '"') {
			i = skipString(s, i) - 1
			continue
		}
		if (c === '{') depth++
		else if (c === '}' && --depth === 0) return i
	}
	return s.length
}

const HEADER = /^[ \t]*([A-Za-z_][\w-]*)((?:[ \t]+(?:"[^"\n]*"|[A-Za-z_][\w-]*))*)[ \t]*\{/gm

/** Top-level blocks of one `.tf` file. */
export function scanBlocks(src: string): HclBlock[] {
	const text = stripComments(src)
	const blocks: HclBlock[] = []
	let pos = 0
	HEADER.lastIndex = 0
	for (;;) {
		HEADER.lastIndex = pos
		const m = HEADER.exec(text)
		if (!m) break
		const open = m.index + m[0].length - 1
		const close = matchBrace(text, open)
		const labels = [...m[2].matchAll(/"([^"\n]*)"|([A-Za-z_][\w-]*)/g)].map((x) => x[1] ?? x[2])
		blocks.push({ type: m[1], labels, body: text.slice(open + 1, close), line: text.slice(0, m.index).split('\n').length })
		pos = close + 1
	}
	return blocks
}

/** Top-level `key = value` attributes in a block body (nested blocks skipped). Values are raw text. */
export function attributes(body: string): Record<string, string> {
	const out: Record<string, string> = {}
	let depth = 0
	let lineStart = true
	for (let i = 0; i < body.length; i++) {
		const c = body[i]
		if (c === '"') {
			i = skipString(body, i) - 1
			lineStart = false
			continue
		}
		if (c === '{' || c === '[' || c === '(') depth++
		else if (c === '}' || c === ']' || c === ')') depth--
		else if (c === '\n') lineStart = true
		else if (depth === 0 && lineStart && /[A-Za-z_]/.test(c)) {
			const m = /^([A-Za-z_][\w-]*)[ \t]*=(?!=)[ \t]*/.exec(body.slice(i))
			lineStart = false
			if (!m) continue
			let j = i + m[0].length
			let d = 0
			const start = j
			for (; j < body.length; j++) {
				const cj = body[j]
				if (cj === '"') {
					j = skipString(body, j) - 1
					continue
				}
				if (cj === '{' || cj === '[' || cj === '(') d++
				else if (cj === '}' || cj === ']' || cj === ')') d--
				else if (cj === '\n' && d <= 0) break
				if (d < 0) break
			}
			out[m[1]] = body.slice(start, j).trim()
			i = j - 1
		} else if (!/\s/.test(c)) lineStart = false
	}
	return out
}

/** Unquoted string value (`"./modules/vpc"` → `./modules/vpc`), or undefined if not a plain string. */
export function stringValue(v: string | undefined): string | undefined {
	const m = v?.match(/^"((?:[^"\\$]|\\.)*)"$/)
	return m ? m[1] : undefined
}
