/**
 * TS/JS symbol extraction on top of `tokenizeJs`: top-level declarations
 * (statement boundaries found without relying on semicolons), class /
 * interface / enum members, imports, re-exports, CommonJS exports, and the
 * references between symbols of one file.
 */

import { tokenizeJs, type JsToken } from './jsTokenize'
import { emptySymbols, flag, MAX_SYMBOLS, OrderedSet, type CodeSymbol, type FileSymbols, type ImportBinding, type SymbolKind, type SymbolLang } from './types'

interface Sym extends CodeSymbol {
	/** Token ranges [start, end] (inclusive) that make up the body. */
	ranges: [number, number][]
	/** Index of the name token (excluded from refs). */
	nameTok: number
	membersX?: Sym[]
}

const CLOSE: Record<string, string> = { '{': '}', '(': ')', '[': ']' }
const OPEN_OF: Record<string, string> = { '}': '{', ')': '(', ']': '[' }

const STRONG_KEYWORDS = new Set(['export', 'import', 'const', 'let', 'var', 'function', 'class', 'if', 'for', 'while', 'do', 'return', 'throw', 'try', 'switch', 'break', 'continue', 'enum', 'debugger', 'with'])
const CONTEXTUAL_DECL = new Set(['type', 'interface', 'declare', 'abstract', 'namespace', 'module', 'async', 'enum'])
const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'readonly', 'abstract', 'override', 'declare', 'async', 'accessor'])
const TYPE_OPS = new Set([':', '|', '&', ',', '<', '=>', '=', 'extends', 'implements', '(', '?', 'keyof', 'typeof', '['])

function matchBrackets(toks: JsToken[]): Int32Array {
	const m = new Int32Array(toks.length).fill(-1)
	const stack: number[] = []
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]
		if (t.type !== 'punct') continue
		if (CLOSE[t.value]) stack.push(i)
		else if (OPEN_OF[t.value]) {
			// pop until a matching opener (tolerates unbalanced input)
			let k = stack.length - 1
			while (k >= 0 && toks[stack[k]].value !== OPEN_OF[t.value]) k--
			if (k < 0) continue
			const o = stack[k]
			stack.length = k
			m[o] = i
			m[i] = o
		}
	}
	return m
}

export function extractJs(text: string, lang: SymbolLang, jsx: boolean): FileSymbols {
	const out = emptySymbols(lang)
	let toks: JsToken[]
	try {
		toks = tokenizeJs(text, { jsx, ts: lang === 'ts' })
	} catch {
		return out
	}
	const n = toks.length
	const match = matchBrackets(toks)
	const is = (i: number, v: string) => i >= 0 && i < n && toks[i].value === v && (toks[i].type === 'punct' || toks[i].type === 'keyword' || toks[i].type === 'ident')
	const isPunct = (i: number, v: string) => i >= 0 && i < n && toks[i].type === 'punct' && toks[i].value === v
	const isName = (i: number) => i >= 0 && i < n && (toks[i].type === 'ident' || toks[i].type === 'keyword')
	const isIdent = (i: number) => i >= 0 && i < n && toks[i].type === 'ident'
	const lineOf = (i: number) => toks[Math.max(0, Math.min(n - 1, i))]?.line ?? 1
	/** Jump over a bracket group starting at i (returns index of its closer, or limit-1 when unmatched). */
	const jump = (i: number, limit: number) => {
		const m = match[i]
		return m > i && m < limit ? m : limit - 1
	}

	const canEnd = (j: number) => {
		const t = toks[j]
		if (t.type === 'ident' || t.type === 'number' || t.type === 'string' || t.type === 'template' || t.type === 'regex' || t.type === 'private' || t.type === 'jsx-text') return true
		if (t.type === 'keyword') return t.value === 'this' || t.value === 'super' || t.value === 'null' || t.value === 'true' || t.value === 'false' || (t.value === 'const' && toks[j - 1]?.value === 'as')
		return t.value === ')' || t.value === ']' || t.value === '}' || t.value === '++' || t.value === '--' || t.value === '>'
	}
	const prevContinues = (j: number) => {
		const t = toks[j]
		if (t.type === 'punct') return !(t.value === ')' || t.value === ']' || t.value === '}' || t.value === '>' || t.value === '++' || t.value === '--' || t.value === ';')
		if (t.type === 'keyword') return !(t.value === 'this' || t.value === 'super' || t.value === 'null' || t.value === 'true' || t.value === 'false' || (t.value === 'const' && toks[j - 1]?.value === 'as'))
		return false
	}
	const strongStart = (j: number) => {
		const t = toks[j]
		if (t.type === 'keyword') return STRONG_KEYWORDS.has(t.value)
		if (t.type === 'punct') return t.value === '@'
		if (t.type === 'ident' && CONTEXTUAL_DECL.has(t.value)) return isName(j + 1) || is(j + 1, 'function') || isPunct(j + 1, '{')
		return false
	}
	const weakStart = (t: JsToken) => t.type === 'ident' || t.type === 'private' || t.type === 'string' || t.type === 'number' || (t.type === 'keyword' && (t.value === 'this' || t.value === 'super' || t.value === 'new' || t.value === 'typeof' || t.value === 'await' || t.value === 'yield' || t.value === 'delete' || t.value === 'void'))

	/** Last token index of the statement starting at `from` (within `[from, limit)`). */
	const stmtEnd = (from: number, limit: number): number => {
		let j = from
		while (j < limit) {
			const t = toks[j]
			if (t.type === 'punct' && CLOSE[t.value]) j = jump(j, limit)
			else if (t.type === 'punct' && t.value === ';') return j
			else if (t.type === 'punct' && OPEN_OF[t.value]) return Math.max(from, j - 1) // stray closer: stop before it
			const next = j + 1
			if (next >= limit) return j
			const nt = toks[next]
			if (nt.nl) {
				if (strongStart(next) && !prevContinues(j)) return j
				if (weakStart(nt) && canEnd(j) && !(nt.type === 'ident' && (nt.value === 'as' || nt.value === 'satisfies' || nt.value === 'in' || nt.value === 'of' || nt.value === 'instanceof'))) return j
			}
			j = next
		}
		return limit - 1
	}

	const symbols: Sym[] = []
	const byName = new Map<string, Sym>()
	const imports: ImportBinding[] = []
	const specPos: { pos: number; spec: string }[] = []
	const exportNames = new Set<string>()
	const defaultNames = new Set<string>()
	const unq = (s: string) => s.replace(/^['"`]|['"`]$/g, '')

	const addSym = (s: Sym): Sym => {
		const prev = byName.get(s.name)
		if (prev && s.name !== 'default') {
			// overloads / declaration merging
			prev.ranges.push(...s.ranges)
			prev.endLine = Math.max(prev.endLine, s.endLine)
			prev.exported ||= s.exported
			for (const f of s.flags ?? []) flag(prev, f)
			if (s.membersX?.length) prev.membersX = [...(prev.membersX ?? []), ...s.membersX]
			if (s.heritage?.length) prev.heritage = [...new Set([...(prev.heritage ?? []), ...s.heritage])]
			if (prev.kind === 'function' && s.kind !== 'function') prev.kind = s.kind
			return prev
		}
		if (symbols.length >= MAX_SYMBOLS) return s
		symbols.push(s)
		byName.set(s.name, s)
		return s
	}
	const mk = (name: string, kind: SymbolKind, nameTok: number, from: number, to: number, exported: boolean): Sym => ({
		name,
		kind,
		exported,
		line: lineOf(nameTok),
		endLine: lineOf(to),
		refs: [],
		calls: [],
		importRefs: [],
		ranges: [[from, to]],
		nameTok,
	})

	/** Finds the body `{` of a function/method after its params: the first depth-0 `{` not part of a return type. */
	const findBody = (from: number, limit: number): number => {
		for (let j = from; j < limit; j++) {
			const t = toks[j]
			if (t.type === 'punct' && t.value === '{') {
				const p = toks[j - 1]
				const typeLit = p && TYPE_OPS.has(p.value) && (p.type === 'punct' || p.value === 'extends' || p.value === 'implements' || p.value === 'keyof' || p.value === 'typeof')
				if (!typeLit) return j
				j = jump(j, limit)
				continue
			}
			if (t.type === 'punct' && (t.value === '(' || t.value === '[')) {
				j = jump(j, limit)
				continue
			}
			if (t.type === 'punct' && t.value === ';') return -1
			if (j > from && t.nl && ((strongStart(j) && !prevContinues(j - 1)) || (weakStart(t) && canEnd(j - 1)))) return -1
		}
		return -1
	}

	/** Binding names in a destructuring pattern `{ a, b: c, ...d }` / `[e, f = 1]` at [open, close]. */
	const patternNames = (open: number, close: number): number[] => {
		const names: number[] = []
		const defaults: boolean[] = [false]
		let depth = 0
		for (let j = open + 1; j < close; j++) {
			const t = toks[j]
			if (t.type === 'punct' && CLOSE[t.value]) {
				if (defaults[depth]) {
					j = jump(j, close)
					continue
				}
				depth++
				defaults[depth] = false
				continue
			}
			if (t.type === 'punct' && OPEN_OF[t.value]) {
				depth = Math.max(0, depth - 1)
				continue
			}
			if (t.type === 'punct' && t.value === ',') {
				defaults[depth] = false
				continue
			}
			if (t.type === 'punct' && t.value === '=') {
				defaults[depth] = true
				continue
			}
			if (defaults[depth]) continue
			if (t.type === 'ident' && !isPunct(j + 1, ':') && !isPunct(j - 1, '.')) names.push(j)
		}
		return names
	}

	/** Is the initializer at [s, e] an arrow function? */
	const arrowAt = (s: number, e: number): boolean => {
		let j = s
		if (is(j, 'async') && j + 1 <= e && !toks[j + 1].nl) j++
		if (isIdent(j) && isPunct(j + 1, '=>')) return true
		if (isPunct(j, '<')) {
			for (let k = j; k <= e; k++) if (isPunct(k, '=>')) return true
			return false
		}
		if (isPunct(j, '(')) {
			const c = jump(j, e + 1)
			if (isPunct(c + 1, '=>')) return true
			if (isPunct(c + 1, ':')) {
				for (let k = c + 1; k <= e; k++) {
					if (isPunct(k, '=>')) return true
					if (isPunct(k, '{') || isPunct(k, '(')) k = jump(k, e + 1)
				}
			}
		}
		return false
	}

	// ---------------------------------------------------------------- members

	const memberNameAt = (j: number): { name: string; end: number } | null => {
		const t = toks[j]
		if (!t) return null
		if (t.type === 'ident' || t.type === 'keyword' || t.type === 'private' || t.type === 'number') return { name: t.value, end: j }
		if (t.type === 'string') return { name: unq(t.value), end: j }
		if (t.type === 'punct' && t.value === '[') {
			const c = match[j]
			if (c < 0) return null
			return { name: text.slice(t.start, toks[c].end).replace(/\s+/g, ' '), end: c }
		}
		return null
	}

	/** Parses class / interface members in the body `{` at open … `}` at close. */
	const parseMembers = (open: number, close: number, mode: 'class' | 'interface'): Sym[] => {
		const members: Sym[] = []
		const byKey = new Map<string, Sym>()
		const add = (m: Sym) => {
			const k = `${m.kind}\u0000${m.name}`
			const prev = byKey.get(k)
			if (prev) {
				prev.ranges.push(...m.ranges)
				prev.endLine = Math.max(prev.endLine, m.endLine)
				return
			}
			byKey.set(k, m)
			members.push(m)
		}
		let j = open + 1
		for (let guard = 0; j < close && guard < 100000; guard++) {
			if (isPunct(j, ';') || isPunct(j, ',')) {
				j++
				continue
			}
			const start = j
			const flags: string[] = []
			while (isPunct(j, '@')) {
				j++
				while (isName(j) && isPunct(j + 1, '.')) j += 2
				if (isName(j)) j++
				if (isPunct(j, '(')) j = jump(j, close) + 1
				flags.push('decorated')
			}
			// static block
			if (is(j, 'static') && isPunct(j + 1, '{')) {
				j = jump(j + 1, close) + 1
				continue
			}
			while (isIdent(j) && MODIFIERS.has(toks[j].value) && j + 1 < close && !toks[j + 1].nl && memberNameAt(j + 1) && !isPunct(j + 1, '(') && !isPunct(j + 1, '<')) {
				flags.push(toks[j].value)
				j++
			}
			if (is(j, 'static') && memberNameAt(j + 1) && !isPunct(j + 1, '(') && !isPunct(j + 1, '=')) {
				flags.push('static')
				j++
			}
			let kind: SymbolKind = 'property'
			if ((is(j, 'get') || is(j, 'set')) && memberNameAt(j + 1) && !isPunct(j + 1, '(') && !isPunct(j + 1, '=') && !isPunct(j + 1, ':') && !isPunct(j + 1, ';') && !toks[j + 1].nl) {
				kind = toks[j].value === 'get' ? 'getter' : 'setter'
				j++
			}
			if (isPunct(j, '*')) {
				flags.push('generator')
				j++
			}
			// index / call signatures in interfaces: `[k: string]: T`, `(x): T`, `new (): T`
			if (mode === 'interface' && (isPunct(j, '(') || isPunct(j, '<') || (is(j, 'new') && (isPunct(j + 1, '(') || isPunct(j + 1, '<'))))) {
				j = stmtEnd(j, close) + 1
				continue
			}
			if (isPunct(j, '[') && match[j] > 0 && toks.slice(j, match[j]).some((t) => t.type === 'punct' && t.value === ':') && mode === 'interface') {
				j = stmtEnd(j, close) + 1
				continue
			}
			const nm = memberNameAt(j)
			if (!nm) {
				j = Math.max(j + 1, stmtEnd(j, close) + 1)
				continue
			}
			const nameTok = j
			j = nm.end + 1
			if (isPunct(j, '?')) {
				flags.push('optional')
				j++
			} else if (isPunct(j, '!')) j++
			if (nm.name === 'constructor' && mode === 'class') kind = 'constructor'
			const isPrivateName = toks[nameTok].type === 'private'
			if (isPrivateName) flags.push('private')
			if (isPunct(j, '(') || isPunct(j, '<')) {
				if (kind === 'property') kind = 'method'
				let p = j
				if (isPunct(p, '<')) {
					while (p < close && !isPunct(p, '(')) p++
				}
				const pClose = isPunct(p, '(') ? jump(p, close) : p
				// parameter properties
				if (kind === 'constructor' && isPunct(p, '(')) {
					for (let k = p + 1; k < pClose; k++) {
						if (isIdent(k) && (toks[k].value === 'public' || toks[k].value === 'private' || toks[k].value === 'protected' || toks[k].value === 'readonly')) {
							let q = k
							const pf: string[] = []
							while (isIdent(q) && MODIFIERS.has(toks[q].value) && isIdent(q + 1)) {
								pf.push(toks[q].value)
								q++
							}
							if (isIdent(q)) {
								const pm = mk(toks[q].value, 'property', q, q, q, false)
								for (const f of pf) if (f !== 'public') flag(pm, f)
								add(pm)
								k = q
							}
						}
						if (isPunct(k, '(') || isPunct(k, '{') || isPunct(k, '[')) k = jump(k, pClose)
					}
				}
				const body = mode === 'class' ? findBody(pClose + 1, close) : -1
				const end = body >= 0 ? jump(body, close) : stmtEnd(pClose + 1 <= close - 1 ? pClose + 1 : pClose, close)
				const m = mk(nm.name, kind, nameTok, start, Math.max(end, pClose), false)
				for (const f of flags) if (f !== 'public' && f !== 'override' && f !== 'declare' && f !== 'accessor') flag(m, f)
				add(m)
				j = Math.max(end, pClose) + 1
				continue
			}
			// property
			const end = stmtEnd(j <= close - 1 ? j : j - 1, close)
			const eq = isPunct(j, '=') ? j : -1
			let initFrom = eq
			if (eq < 0 && isPunct(j, ':')) {
				for (let k = j; k <= end; k++) {
					if (isPunct(k, '=')) {
						initFrom = k
						break
					}
					if (isPunct(k, '{') || isPunct(k, '(') || isPunct(k, '[')) k = jump(k, close)
				}
			}
			const m = mk(nm.name, kind, nameTok, start, Math.max(end, nameTok), false)
			if (initFrom >= 0 && arrowAt(initFrom + 1, end)) {
				m.kind = 'method'
				flag(m, 'arrow')
				if (is(initFrom + 1, 'async')) flag(m, 'async')
			}
			for (const f of flags) if (f !== 'public' && f !== 'override' && f !== 'declare' && f !== 'accessor') flag(m, f)
			add(m)
			j = Math.max(end, nameTok) + 1
		}
		return members
	}

	const parseEnumMembers = (open: number, close: number): Sym[] => {
		const members: Sym[] = []
		let j = open + 1
		while (j < close) {
			const nm = memberNameAt(j)
			let k = j
			while (k < close && !isPunct(k, ',')) {
				if (isPunct(k, '(') || isPunct(k, '{') || isPunct(k, '[')) k = jump(k, close)
				k++
			}
			if (nm && toks[j].type !== 'punct') members.push(mk(nm.name, 'property', j, j, Math.min(k, close) - 1 >= j ? Math.min(k, close) - 1 : j, false))
			j = k + 1
		}
		return members
	}

	/** Heritage names between `from` and the body `{`. */
	const heritageOf = (from: number, to: number): string[] => {
		const names: string[] = []
		let active = false
		let angle = 0
		for (let j = from; j < to; j++) {
			const t = toks[j]
			if (t.value === 'extends' || t.value === 'implements') {
				active = true
				continue
			}
			if (t.type === 'punct' && t.value === '<') angle++
			else if (t.type === 'punct' && t.value === '>') angle = Math.max(0, angle - 1)
			else if (t.type === 'punct' && t.value === '>>') angle = Math.max(0, angle - 2)
			if (!active || angle > 0) continue
			if (t.type === 'punct' && t.value === '(') {
				j = jump(j, to)
				continue
			}
			if ((t.type === 'ident' || t.type === 'keyword') && !isPunct(j - 1, '.')) {
				let name = t.value
				let k = j
				while (isPunct(k + 1, '.') && isName(k + 2)) {
					name += '.' + toks[k + 2].value
					k += 2
				}
				names.push(name)
				j = k
			}
		}
		return names
	}

	// ---------------------------------------------------------------- statements

	const parseImport = (s: number, e: number) => {
		let j = s + 1
		if (isPunct(j, '(') || isPunct(j, '.')) return // dynamic import / import.meta
		if (toks[j]?.type === 'string') {
			specPos.push({ pos: j, spec: unq(toks[j].value) })
			return
		}
		let typeOnly = false
		if (is(j, 'type') && !is(j + 1, 'from') && !isPunct(j + 1, ',') && !isPunct(j + 1, '=')) {
			typeOnly = true
			j++
		}
		// import x = require('y') / import x = A.B
		if (isIdent(j) && isPunct(j + 1, '=')) {
			const local = toks[j].value
			for (let k = j + 2; k <= e; k++) {
				if (toks[k].type === 'string') {
					specPos.push({ pos: k, spec: unq(toks[k].value) })
					imports.push({ local, spec: unq(toks[k].value), imported: 'default', ...(typeOnly ? { typeOnly } : {}) })
					break
				}
			}
			return
		}
		let fromIdx = -1
		for (let k = j; k <= e; k++) if (is(k, 'from') && toks[k + 1]?.type === 'string') fromIdx = k
		if (fromIdx < 0) return
		const spec = unq(toks[fromIdx + 1].value)
		specPos.push({ pos: fromIdx + 1, spec })
		const bind = (local: string, imported: string, tOnly: boolean) => imports.push({ local, spec, imported, ...(tOnly ? { typeOnly: true } : {}) })
		for (let k = j; k < fromIdx; k++) {
			const t = toks[k]
			if (t.type === 'punct' && t.value === '*' && is(k + 1, 'as') && isName(k + 2)) {
				bind(toks[k + 2].value, '*', typeOnly)
				k += 2
				continue
			}
			if (t.type === 'punct' && t.value === '{') {
				const c = jump(k, fromIdx)
				for (let q = k + 1; q < c; q++) {
					let tOnly = typeOnly
					if (is(q, 'type') && (isName(q + 1) || toks[q + 1]?.type === 'string') && !isPunct(q + 1, ',') && !is(q + 1, 'as')) {
						tOnly = true
						q++
					}
					if (isName(q) || toks[q]?.type === 'string') {
						const imported = unq(toks[q].value)
						let local = imported
						if (is(q + 1, 'as') && isName(q + 2)) {
							local = toks[q + 2].value
							q += 2
						}
						bind(local, imported, tOnly)
					}
					while (q < c && !isPunct(q, ',')) q++
				}
				k = c
				continue
			}
			if (isName(t ? k : -1) && t.value !== 'type') bind(t.value, 'default', typeOnly)
			else if (t.value === 'type' && isPunct(k + 1, ',')) bind('type', 'default', typeOnly)
		}
	}

	/** `export { a, b as c } [from 'x']`, `export * [as ns] from 'x'` */
	const parseExportList = (s: number, e: number): boolean => {
		let j = s
		if (is(j, 'type') && isPunct(j + 1, '{')) j++
		if (isPunct(j, '*')) {
			let k = j + 1
			let ns: string | undefined
			if (is(k, 'as') && isName(k + 1)) {
				ns = toks[k + 1].value
				k += 2
			}
			if (is(k, 'from') && toks[k + 1]?.type === 'string') {
				const spec = unq(toks[k + 1].value)
				specPos.push({ pos: k + 1, spec })
				out.reexports.push({ spec, names: ns ? [ns] : ['*'] })
			}
			return true
		}
		if (!isPunct(j, '{')) return false
		const c = jump(j, e + 1)
		const pairs: { local: string; exported: string }[] = []
		for (let q = j + 1; q < c; q++) {
			if (is(q, 'type') && isName(q + 1) && !isPunct(q + 1, ',')) q++
			if (isName(q) || toks[q]?.type === 'string') {
				const local = unq(toks[q].value)
				let exported = local
				if (is(q + 1, 'as') && (isName(q + 2) || toks[q + 2]?.type === 'string')) {
					exported = unq(toks[q + 2].value)
					q += 2
				}
				pairs.push({ local, exported })
			}
			while (q < c && !isPunct(q, ',')) q++
		}
		if (is(c + 1, 'from') && toks[c + 2]?.type === 'string') {
			const spec = unq(toks[c + 2].value)
			specPos.push({ pos: c + 2, spec })
			out.reexports.push({ spec, names: pairs.map((p) => p.local) })
		} else {
			for (const p of pairs) {
				exportNames.add(p.local)
				if (p.exported === 'default') defaultNames.add(p.local)
			}
		}
		return true
	}

	const parseVar = (kw: number, e: number, exported: boolean, stmtStart: number) => {
		const isConst = toks[kw].value === 'const'
		let j = kw + 1
		while (j <= e) {
			const declStart = j
			// declarator end: the next depth-0 comma that starts another declarator
			let k = j
			let angle = 0
			let seenEq = false
			while (k <= e) {
				const t = toks[k]
				if (t.type === 'punct') {
					if (CLOSE[t.value]) {
						k = jump(k, e + 1) + 1
						continue
					}
					if (t.value === '=' && angle === 0) seenEq = true
					else if (!seenEq && t.value === '<') angle++
					else if (!seenEq && t.value === '>') angle = Math.max(0, angle - 1)
					else if (!seenEq && t.value === '>>') angle = Math.max(0, angle - 2)
					else if (t.value === ',') {
						if (!seenEq && angle === 0) break
						if (seenEq && ((isIdent(k + 1) && (isPunct(k + 2, '=') || isPunct(k + 2, ':') || isPunct(k + 2, ',') || k + 1 === e)) || ((isPunct(k + 1, '{') || isPunct(k + 1, '[')) && isPunct(jump(k + 1, e + 1) + 1, '=')))) break
					}
				}
				k++
			}
			const dEnd = Math.min(k, e + 1) - 1
			let nameToks: number[] = []
			let after = j
			if (isPunct(j, '{') || isPunct(j, '[')) {
				const c = jump(j, e + 1)
				nameToks = patternNames(j, c)
				after = c + 1
			} else if (isName(j)) {
				nameToks = [j]
				after = j + 1
			}
			if (isPunct(after, '!')) after++
			// type annotation then '='
			let eq = -1
			for (let q = after; q <= dEnd; q++) {
				if (isPunct(q, '=')) {
					eq = q
					break
				}
				if (toks[q].type === 'punct' && CLOSE[toks[q].value]) q = jump(q, dEnd + 1)
			}
			const initS = eq >= 0 ? eq + 1 : -1
			// require()
			let required: string | null = null
			if (initS >= 0 && is(initS, 'require') && isPunct(initS + 1, '(') && toks[initS + 2]?.type === 'string') required = unq(toks[initS + 2].value)
			if (required !== null) {
				if (nameToks.length === 1 && nameToks[0] === declStart) imports.push({ local: toks[declStart].value, spec: required, imported: 'default' })
				else if (isPunct(declStart, '{')) {
					const c = jump(declStart, e + 1)
					for (let q = declStart + 1; q < c; q++) {
						if (isName(q)) {
							const imported = toks[q].value
							let local = imported
							if (isPunct(q + 1, ':') && isName(q + 2)) {
								local = toks[q + 2].value
								q += 2
							}
							imports.push({ local, spec: required, imported })
						}
						while (q < c && !isPunct(q, ',')) q++
					}
				}
			} else {
				for (const nt of nameToks) declToks.add(nt)
				for (const nt of nameToks) {
					let kind: SymbolKind = isConst ? 'const' : 'variable'
					const s = mk(toks[nt].value, kind, nt, nameToks.length === 1 && declStart === j && declStart === kw + 1 ? stmtStart : declStart, dEnd, exported)
					if (nameToks.length === 1 && initS >= 0 && initS <= dEnd) {
						let fi = initS
						if (is(fi, 'async') && (is(fi + 1, 'function') || arrowAt(fi, dEnd))) flag(s, 'async')
						if (arrowAt(initS, dEnd)) {
							kind = 'function'
							flag(s, 'arrow')
						} else {
							if (is(fi, 'async')) fi++
							if (is(fi, 'function')) {
								kind = 'function'
								if (isPunct(fi + 1, '*')) flag(s, 'generator')
							} else if (is(fi, 'class')) {
								kind = 'class'
								const body = findClassBody(fi + 1, dEnd + 1)
								if (body >= 0) {
									s.heritage = heritageOf(fi + 1, body)
									s.membersX = parseMembers(body, jump(body, dEnd + 1), 'class')
								}
							}
						}
						s.kind = kind
					}
					addSym(s)
				}
			}
			j = dEnd + 2
		}
	}

	const findClassBody = (from: number, limit: number): number => {
		for (let j = from; j < limit; j++) {
			const t = toks[j]
			if (t.type === 'punct' && t.value === '{') {
				const p = toks[j - 1]
				if (p && (p.value === 'extends' || p.value === 'implements' || p.value === ',' || p.value === '<' || p.value === '&' || p.value === '|' || p.value === ':' || p.value === '=')) {
					j = jump(j, limit)
					continue
				}
				return j
			}
			if (t.type === 'punct' && (t.value === '(' || t.value === '[')) j = jump(j, limit)
		}
		return -1
	}

	const pendingCjs: { names: string[]; pos: number }[] = []
	/** Binding-name tokens of destructuring declarations (never references). */
	const declToks = new Set<number>()

	/** Parses one top-level statement [s, e]; returns the real end (declarations end at their body). */
	const parseStatement = (s: number, e: number, decorated: boolean): number => {
		const stmtStart = s
		let j = s
		let exported = false
		let isDefault = false
		if (is(j, 'export')) {
			exported = true
			j++
			if (is(j, 'default')) {
				isDefault = true
				j++
			}
			if (isPunct(j, '=')) return e
			if (is(j, 'as')) return e
			if (!isDefault && parseExportList(j, e)) return e
		}
		if (is(j, 'import') && !exported) {
			parseImport(j, e)
			return e
		}
		const flags: string[] = []
		if (decorated) flags.push('decorated')
		if (isDefault) flags.push('default')
		while (is(j, 'declare') && isName(j + 1)) j++
		if (is(j, 'abstract') && is(j + 1, 'class')) {
			flags.push('abstract')
			j++
		}
		if (is(j, 'async') && is(j + 1, 'function')) {
			flags.push('async')
			j++
		}
		const apply = (sym: Sym) => {
			for (const f of flags) flag(sym, f)
			return addSym(sym)
		}
		const t = toks[j]
		if (!t) return e
		if (t.value === 'function' && t.type === 'keyword') {
			let k = j + 1
			if (isPunct(k, '*')) {
				flags.push('generator')
				k++
			}
			const named = isName(k) && !isPunct(k, '(')
			const name = named ? toks[k].value : isDefault ? 'default' : null
			if (!name) return e
			let p = named ? k + 1 : k
			while (p <= e && !isPunct(p, '(')) p++
			const pClose = jump(p, n)
			const body = findBody(pClose + 1, n)
			const end = body >= 0 ? jump(body, n) : e
			apply(mk(name, 'function', named ? k : j, stmtStart, end, exported))
			return Math.max(end, body >= 0 ? end : e)
		}
		if (t.value === 'class' && t.type === 'keyword') {
			const named = isIdent(j + 1) && toks[j + 1].value !== 'extends' && toks[j + 1].value !== 'implements'
			const name = named ? toks[j + 1].value : isDefault ? 'default' : null
			const body = findClassBody(j + 1, n)
			const end = body >= 0 ? jump(body, n) : e
			if (!name) return end
			const sym = mk(name, 'class', named ? j + 1 : j, stmtStart, end, exported)
			if (body >= 0) {
				const her = heritageOf(j + 1, body)
				if (her.length) sym.heritage = her
				sym.membersX = parseMembers(body, end, 'class')
			}
			apply(sym)
			return end
		}
		if (t.value === 'interface' && isIdent(j + 1)) {
			const body = findClassBody(j + 2, n)
			const end = body >= 0 ? jump(body, n) : e
			const sym = mk(toks[j + 1].value, 'interface', j + 1, stmtStart, end, exported)
			if (body >= 0) {
				const her = heritageOf(j + 2, body)
				if (her.length) sym.heritage = her
				sym.membersX = parseMembers(body, end, 'interface')
			}
			apply(sym)
			return end
		}
		if (t.value === 'type' && isIdent(j + 1) && (isPunct(j + 2, '=') || isPunct(j + 2, '<'))) {
			apply(mk(toks[j + 1].value, 'type', j + 1, stmtStart, e, exported))
			return e
		}
		if (t.value === 'enum' || (t.value === 'const' && is(j + 1, 'enum'))) {
			const k = t.value === 'const' ? j + 2 : j + 1
			if (!isIdent(k)) return e
			const body = isPunct(k + 1, '{') ? k + 1 : -1
			const end = body >= 0 ? jump(body, n) : e
			const sym = mk(toks[k].value, 'enum', k, stmtStart, end, exported)
			if (body >= 0) sym.membersX = parseEnumMembers(body, end)
			apply(sym)
			return end
		}
		if ((t.value === 'namespace' || t.value === 'module') && (isIdent(j + 1) || toks[j + 1]?.type === 'string')) {
			let k = j + 1
			let name = unq(toks[k].value)
			while (isPunct(k + 1, '.') && isIdent(k + 2)) {
				name += '.' + toks[k + 2].value
				k += 2
			}
			const body = isPunct(k + 1, '{') ? k + 1 : -1
			const end = body >= 0 ? jump(body, n) : e
			apply(mk(name, 'namespace', j + 1, stmtStart, end, exported))
			return end
		}
		if (t.value === 'global' && isPunct(j + 1, '{')) return jump(j + 1, n)
		if ((t.value === 'const' || t.value === 'let' || t.value === 'var') && t.type === 'keyword') {
			const before = symbols.length
			parseVar(j, e, exported, stmtStart)
			for (let q = before; q < symbols.length; q++) for (const f of flags) flag(symbols[q], f)
			return e
		}
		if (isDefault) {
			// export default foo / export default foo(...)
			if (isIdent(j) && j === e) {
				exportNames.add(toks[j].value)
				defaultNames.add(toks[j].value)
			}
			return e
		}
		// CommonJS: module.exports = { a, b } / module.exports = x / exports.x = / module.exports.x =
		if (is(j, 'module') && isPunct(j + 1, '.') && is(j + 2, 'exports')) {
			if (isPunct(j + 3, '=')) {
				if (isPunct(j + 4, '{')) {
					const c = jump(j + 4, e + 1)
					const names: string[] = []
					for (let q = j + 5; q < c; q++) {
						if (isIdent(q) && (isPunct(q + 1, ',') || q + 1 === c)) names.push(toks[q].value)
						else if (isIdent(q) && isPunct(q + 1, ':') && isIdent(q + 2)) {
							names.push(toks[q + 2].value)
							q += 2
						}
						while (q < c && !isPunct(q, ',')) q++
					}
					pendingCjs.push({ names, pos: j })
				} else if (isIdent(j + 4)) pendingCjs.push({ names: [toks[j + 4].value], pos: j })
			} else if (isPunct(j + 3, '.') && isName(j + 4) && isPunct(j + 5, '=')) cjsProp(toks[j + 4].value, j + 6, e, j + 4, stmtStart)
			return e
		}
		if (is(j, 'exports') && isPunct(j + 1, '.') && isName(j + 2) && isPunct(j + 3, '=')) {
			cjsProp(toks[j + 2].value, j + 4, e, j + 2, stmtStart)
			return e
		}
		return e
	}

	const cjsProp = (name: string, initS: number, e: number, nameTok: number, stmtStart: number) => {
		if (isIdent(initS) && initS === e) {
			pendingCjs.push({ names: [toks[initS].value], pos: initS })
			return
		}
		let kind: SymbolKind = 'const'
		const sym = mk(name, kind, nameTok, stmtStart, e, true)
		if (arrowAt(initS, e) || is(initS, 'function') || (is(initS, 'async') && is(initS + 1, 'function'))) {
			kind = 'function'
			if (arrowAt(initS, e)) flag(sym, 'arrow')
		} else if (is(initS, 'class')) kind = 'class'
		sym.kind = kind
		addSym(sym)
	}

	// top-level loop
	let i = 0
	let decorated = false
	for (let guard = 0; i < n && guard < 1_000_000; guard++) {
		if (isPunct(i, ';')) {
			i++
			continue
		}
		if (isPunct(i, '@') && isName(i + 1)) {
			i += 2
			while (isPunct(i, '.') && isName(i + 1)) i += 2
			if (isPunct(i, '(')) i = jump(i, n) + 1
			decorated = true
			continue
		}
		if (toks[i].type === 'punct' && OPEN_OF[toks[i].value]) {
			i++ // stray closer
			continue
		}
		const e = stmtEnd(i, n)
		const end = parseStatement(i, Math.max(e, i), decorated)
		decorated = false
		i = Math.max(end, e, i) + 1
	}

	// specs: imports collected above + require() / import() anywhere
	for (let k = 0; k < n; k++) {
		const t = toks[k]
		if ((t.value === 'require' && t.type === 'ident' && !isPunct(k - 1, '.')) || (t.value === 'import' && t.type === 'keyword')) {
			if (isPunct(k + 1, '(') && toks[k + 2]?.type === 'string' && isPunct(k + 3, ')')) specPos.push({ pos: k + 2, spec: unq(toks[k + 2].value) })
			else if (isPunct(k + 1, '(') && toks[k + 2]?.type === 'template' && isPunct(k + 3, ')') && !toks[k + 2].value.includes('${')) specPos.push({ pos: k + 2, spec: unq(toks[k + 2].value) })
		}
	}
	specPos.sort((a, b) => a.pos - b.pos)
	const specs = new OrderedSet()
	for (const s of specPos) if (s.spec) specs.add(s.spec)

	for (const name of exportNames) {
		const s = byName.get(name)
		if (s) {
			s.exported = true
			if (defaultNames.has(name)) flag(s, 'default')
		}
	}
	for (const p of pendingCjs) for (const name of p.names) {
		const s = byName.get(name)
		if (s) s.exported = true
	}

	// references
	const topNames = new Set(symbols.map((s) => s.name))
	const importLocals = new Set(imports.map((b) => b.local))
	const isCallAt = (k: number): boolean => {
		const t = toks[k]
		if (t.jsx) return true
		if (is(k - 1, 'new')) return true
		const nx = toks[k + 1]
		if (!nx) return false
		if (nx.type === 'punct' && nx.value === '(') return true
		if (nx.type === 'template' && nx.start === t.end) return true
		if (nx.type === 'punct' && nx.value === '<') {
			let depth = 0
			for (let q = k + 1; q < Math.min(n, k + 40); q++) {
				const v = toks[q]
				if (v.type !== 'punct') continue
				if (v.value === '<') depth++
				else if (v.value === '>') depth--
				else if (v.value === '>>') depth -= 2
				else if (v.value === ';' || v.value === '{' || v.value === '=>') return false
				if (depth <= 0) return isPunct(q + 1, '(')
			}
		}
		return false
	}
	const collect = (sym: Sym, own: string, memberNames?: Set<string>) => {
		const refs = new OrderedSet()
		const calls = new OrderedSet()
		const irefs = new OrderedSet()
		const mrefs = new OrderedSet()
		for (const [a, b] of sym.ranges) {
			for (let k = Math.max(0, a); k <= Math.min(b, n - 1); k++) {
				const t = toks[k]
				if (memberNames && t.value === 'this' && t.type === 'keyword' && (isPunct(k + 1, '.') || isPunct(k + 1, '?.')) && toks[k + 2] && (isName(k + 2) || toks[k + 2].type === 'private')) {
					const m = toks[k + 2].value
					if (memberNames.has(m) && m !== own) mrefs.add(m)
					k += 2
					continue
				}
				if (t.type !== 'ident') continue
				if (k === sym.nameTok || declToks.has(k)) continue
				if (isPunct(k - 1, '.') || isPunct(k - 1, '?.')) continue
				// object literal keys / parameter names `(a: T` `{ key: v`
				if (isPunct(k + 1, ':') && (isPunct(k - 1, '{') || isPunct(k - 1, ',') || isPunct(k - 1, '(')) && !t.jsx) continue
				const v = t.value
				if (v === own) continue
				if (topNames.has(v)) {
					refs.add(v)
					if (isCallAt(k)) calls.add(v)
				} else if (importLocals.has(v)) irefs.add(v)
			}
		}
		sym.refs = refs.list
		sym.calls = calls.list
		sym.importRefs = irefs.list
		if (memberNames) sym.memberRefs = mrefs.list
	}
	for (const s of symbols) {
		collect(s, s.name)
		if (s.membersX?.length) {
			const names = new Set(s.membersX.map((m) => m.name))
			for (const m of s.membersX) collect(m, m.name, names)
		}
	}

	const finish = (s: Sym): CodeSymbol => {
		const c: CodeSymbol = { name: s.name, kind: s.kind, exported: s.exported, line: s.line, endLine: s.endLine, refs: s.refs, calls: s.calls, importRefs: s.importRefs }
		if (s.flags?.length) c.flags = s.flags
		if (s.heritage?.length) c.heritage = s.heritage
		if (s.memberRefs) c.memberRefs = s.memberRefs
		if (s.membersX) c.members = s.membersX.map(finish)
		return c
	}
	out.symbols = symbols.map(finish)
	out.imports = imports
	out.specs = specs.list
	return out
}
