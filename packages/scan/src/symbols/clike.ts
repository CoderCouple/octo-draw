/**
 * Small tokenizer for Go and Rust: identifiers, numbers, strings (incl. Go
 * raw strings and Rust raw / byte strings), chars vs Rust lifetimes,
 * comments (Rust block comments nest), and punctuation (`::`, `->`, `=>`,
 * `:=`, ...). Never throws.
 */

import { lineAt, lineStarts } from './types'

export interface CTok {
	type: 'ident' | 'punct' | 'string' | 'number' | 'char' | 'lifetime'
	value: string
	line: number
	nl: boolean
}

const PUNCTS = ['...', '<<=', '>>=', '&^=', '::', '->', '=>', ':=', '==', '!=', '<=', '>=', '&&', '||', '<-', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^', '..']

const idStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c)
const idPart = (c: string) => /[A-Za-z0-9_\u0080-￿]/.test(c)

export function tokenizeC(text: string, lang: 'go' | 'rust'): CTok[] {
	const n = text.length
	const starts = lineStarts(text)
	const toks: CTok[] = []
	let lastLine = 0
	let i = 0
	const push = (type: CTok['type'], s: number, e: number) => {
		const line = lineAt(starts, s)
		toks.push({ type, value: text.slice(s, e), line, nl: line !== lastLine })
		lastLine = line
	}
	while (i < n) {
		const c = text[i]
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
			i++
			continue
		}
		if (c === '/' && text[i + 1] === '/') {
			while (i < n && text[i] !== '\n') i++
			continue
		}
		if (c === '/' && text[i + 1] === '*') {
			if (lang === 'rust') {
				let depth = 0
				while (i < n) {
					if (text[i] === '/' && text[i + 1] === '*') {
						depth++
						i += 2
					} else if (text[i] === '*' && text[i + 1] === '/') {
						depth--
						i += 2
						if (depth === 0) break
					} else i++
				}
			} else {
				const e = text.indexOf('*/', i + 2)
				i = e < 0 ? n : e + 2
			}
			continue
		}
		// Rust raw strings r"..", r#".."#, br"..", and byte strings b".."
		if (lang === 'rust' && (c === 'r' || c === 'b')) {
			const m = /^(?:br|rb|r)(#*)"/.exec(text.slice(i, i + 260))
			if (m) {
				const s = i
				const close = '"' + m[1]
				const e = text.indexOf(close, i + m[0].length)
				i = e < 0 ? n : e + close.length
				push('string', s, i)
				continue
			}
			if (c === 'b' && (text[i + 1] === '"' || text[i + 1] === "'")) {
				i++
				// fall through to string / char handling with the prefix included
				const s = i - 1
				const q = text[i]
				i++
				while (i < n && text[i] !== q) i += text[i] === '\\' ? 2 : 1
				i = Math.min(n, i + 1)
				push(q === '"' ? 'string' : 'char', s, i)
				continue
			}
		}
		if (c === '"') {
			const s = i
			i++
			while (i < n && text[i] !== '"') {
				if (text[i] === '\n' && lang === 'go') break
				i += text[i] === '\\' ? 2 : 1
			}
			i = Math.min(n, i + 1)
			push('string', s, i)
			continue
		}
		if (c === '`' && lang === 'go') {
			const s = i
			const e = text.indexOf('`', i + 1)
			i = e < 0 ? n : e + 1
			push('string', s, i)
			continue
		}
		if (c === "'") {
			const s = i
			if (lang === 'rust') {
				// char literal vs lifetime
				if (text[i + 1] === '\\') {
					i += 2
					while (i < n && text[i] !== "'" && text[i] !== '\n') i++
					i = Math.min(n, i + 1)
					push('char', s, i)
					continue
				}
				const cp = text.codePointAt(i + 1)
				const w = cp !== undefined && cp > 0xffff ? 2 : 1
				if (text[i + 1 + w] === "'") {
					i += 2 + w
					push('char', s, i)
					continue
				}
				i++
				while (i < n && idPart(text[i])) i++
				push('lifetime', s, i)
				continue
			}
			i++
			while (i < n && text[i] !== "'" && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
			i = Math.min(n, i + 1)
			push('char', s, i)
			continue
		}
		if (idStart(c)) {
			const s = i
			while (i < n && idPart(text[i])) i++
			push('ident', s, i)
			continue
		}
		if (/[0-9]/.test(c)) {
			const s = i
			while (i < n && /[0-9A-Za-z_.]/.test(text[i])) {
				if (text[i] === '.' && (text[i + 1] === '.' || !/[0-9]/.test(text[i + 1] ?? ''))) break
				i++
			}
			push('number', s, i)
			continue
		}
		let p = ''
		for (const cand of PUNCTS) if (text.startsWith(cand, i)) {
			p = cand
			break
		}
		if (!p) p = c
		push('punct', i, i + p.length)
		i += p.length
	}
	return toks
}

export function matchC(toks: CTok[]): Int32Array {
	const m = new Int32Array(toks.length).fill(-1)
	const stack: number[] = []
	const open: Record<string, string> = { '}': '{', ')': '(', ']': '[' }
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]
		if (t.type !== 'punct') continue
		if (t.value === '{' || t.value === '(' || t.value === '[') stack.push(i)
		else if (open[t.value]) {
			let k = stack.length - 1
			while (k >= 0 && toks[stack[k]].value !== open[t.value]) k--
			if (k < 0) continue
			m[stack[k]] = i
			m[i] = stack[k]
			stack.length = k
		}
	}
	return m
}
