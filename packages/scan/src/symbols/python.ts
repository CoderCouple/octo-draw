/**
 * Python symbol extraction (best effort, indentation based): top-level
 * def / class / assignments, class methods and properties, imports, and
 * references from identifiers in each body (strings and comments removed).
 */

import { emptySymbols, flag, MAX_SYMBOLS, OrderedSet, type CodeSymbol, type FileSymbols, type ImportBinding, type SymbolKind } from './types'

/** Blanks string contents and comments, keeping line structure. */
function strip(text: string): string {
	let out = ''
	const n = text.length
	let i = 0
	while (i < n) {
		const c = text[i]
		if (c === '#') {
			while (i < n && text[i] !== '\n') i++
			continue
		}
		if (c === '"' || c === "'") {
			const triple = text.startsWith(c.repeat(3), i)
			const q = triple ? c.repeat(3) : c
			out += '""'
			i += q.length
			while (i < n) {
				if (text[i] === '\\') {
					if (text[i + 1] === '\n') out += '\n'
					i += 2
					continue
				}
				if (text.startsWith(q, i)) {
					i += q.length
					break
				}
				if (text[i] === '\n') {
					if (!triple) break
					out += '\n'
				}
				i++
			}
			continue
		}
		out += c
		i++
	}
	return out
}

interface Line {
	text: string
	indent: number
	/** Starts a logical line (not inside brackets / continuation) and is not blank. */
	start: boolean
	/** The joined logical line (for multi-line statements). */
	logical: string
	/** Last physical line index of the logical line. */
	last: number
}

function lines(src: string): Line[] {
	const phys = src.split('\n')
	const out: Line[] = phys.map((t) => ({ text: t, indent: 0, start: false, logical: '', last: 0 }))
	let depth = 0
	let cont = false
	let cur = -1
	for (let i = 0; i < phys.length; i++) {
		const t = phys[i]
		const blank = t.trim() === ''
		if (depth === 0 && !cont && !blank) {
			cur = i
			out[i].start = true
			out[i].indent = t.length - t.trimStart().length
			out[i].logical = ''
		}
		if (cur >= 0 && !blank) {
			out[cur].logical += (out[cur].logical ? ' ' : '') + t.trim().replace(/\\$/, '')
			out[cur].last = i
		}
		for (const ch of t) {
			if (ch === '(' || ch === '[' || ch === '{') depth++
			else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
		}
		cont = /\\\s*$/.test(t)
	}
	return out
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g

interface PySym extends CodeSymbol {
	from: number
	to: number
	membersX?: PySym[]
}

export function extractPython(text: string): FileSymbols {
	const out = emptySymbols('python')
	const src = strip(text)
	const L = lines(src)
	const symbols: PySym[] = []
	const imports: ImportBinding[] = []
	const specs = new OrderedSet()

	/** Last physical line of the block opened by line i (indent > L[i].indent). */
	const blockEnd = (i: number): number => {
		const ind = L[i].indent
		let end = L[i].last
		for (let k = L[i].last + 1; k < L.length; k++) {
			if (!L[k].start) {
				if (L[k].text.trim()) end = k
				continue
			}
			if (L[k].indent <= ind) break
			end = L[k].last
		}
		return end
	}

	// imports anywhere
	for (let i = 0; i < L.length; i++) {
		if (!L[i].start) continue
		const t = L[i].logical
		let m = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(t)
		if (m) {
			const spec = m[1]
			specs.add(spec)
			for (const part of m[2].replace(/[()]/g, ' ').split(',')) {
				const p = part.trim().split(/\s+/)
				if (!p[0] || p[0] === '*') continue
				imports.push({ local: p[1] === 'as' && p[2] ? p[2] : p[0], spec, imported: p[0] })
			}
			continue
		}
		m = /^import\s+(.+)$/.exec(t)
		if (m) {
			for (const part of m[1].split(',')) {
				const p = part.trim().split(/\s+/)
				if (!p[0]) continue
				specs.add(p[0])
				imports.push({ local: p[1] === 'as' && p[2] ? p[2] : p[0].split('.')[0], spec: p[0], imported: '*' })
			}
		}
	}

	const mk = (name: string, kind: SymbolKind, line: number, from: number, to: number, exported: boolean): PySym => ({ name, kind, exported, line: line + 1, endLine: to + 1, refs: [], calls: [], importRefs: [], from, to })

	const parseClassBody = (cls: PySym, head: number, end: number) => {
		const members: PySym[] = []
		const seen = new Map<string, PySym>()
		let bodyIndent = -1
		let decos: string[] = []
		let decoStart = -1
		for (let k = L[head].last + 1; k <= end; k++) {
			if (!L[k].start) continue
			if (bodyIndent < 0) bodyIndent = L[k].indent
			if (L[k].indent !== bodyIndent) continue
			const t = L[k].logical
			if (t.startsWith('@')) {
				if (decoStart < 0) decoStart = k
				decos.push(t.slice(1).split('(')[0].trim())
				continue
			}
			const d = /^(async\s+)?def\s+([A-Za-z_]\w*)/.exec(t)
			if (d) {
				const e = blockEnd(k)
				let kind: SymbolKind = d[2] === '__init__' ? 'constructor' : 'method'
				if (decos.some((x) => x === 'property' || x.endsWith('.getter') || x === 'cached_property' || x.endsWith('.cached_property'))) kind = 'property'
				if (decos.some((x) => x.endsWith('.setter'))) kind = 'setter'
				const m = mk(d[2], kind, k, decoStart >= 0 ? decoStart : k, e, !d[2].startsWith('_') || /^__\w+__$/.test(d[2]))
				if (d[1]) flag(m, 'async')
				if (decos.includes('staticmethod')) flag(m, 'static')
				if (decos.includes('classmethod')) flag(m, 'static')
				if (decos.some((x) => x === 'abstractmethod' || x.endsWith('.abstractmethod'))) flag(m, 'abstract')
				if (decos.length) flag(m, 'decorated')
				if (d[2].startsWith('_') && !/^__\w+__$/.test(d[2])) flag(m, 'private')
				const prev = seen.get(m.name)
				if (prev && (kind === 'setter' || prev.kind === 'property')) {
					prev.to = Math.max(prev.to, e)
					prev.endLine = prev.to + 1
				} else {
					seen.set(m.name, m)
					members.push(m)
				}
				// self.x = ... in __init__
				if (d[2] === '__init__') {
					for (let q = k + 1; q <= e; q++) {
						for (const a of L[q].text.matchAll(/\bself\.([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/g)) {
							if (seen.has(a[1])) continue
							const p = mk(a[1], 'property', q, q, q, !a[1].startsWith('_'))
							seen.set(a[1], p)
							members.push(p)
						}
					}
				}
				decos = []
				decoStart = -1
				continue
			}
			decos = []
			decoStart = -1
			const a = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(t) ?? /^([A-Za-z_]\w*)\s*:\s*[^=]+$/.exec(t)
			if (a && !seen.has(a[1])) {
				const p = mk(a[1], 'property', k, k, L[k].last, !a[1].startsWith('_'))
				seen.set(a[1], p)
				members.push(p)
			}
		}
		cls.membersX = members
	}

	let decos: string[] = []
	let decoStart = -1
	for (let i = 0; i < L.length && symbols.length < MAX_SYMBOLS; i++) {
		if (!L[i].start || L[i].indent !== 0) continue
		const t = L[i].logical
		if (t.startsWith('@')) {
			if (decoStart < 0) decoStart = i
			decos.push(t.slice(1).split('(')[0].trim())
			continue
		}
		const d = /^(async\s+)?def\s+([A-Za-z_]\w*)/.exec(t)
		const c = /^class\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?/.exec(t)
		if (d) {
			const e = blockEnd(i)
			const s = mk(d[2], 'function', i, decoStart >= 0 ? decoStart : i, e, !d[2].startsWith('_'))
			if (d[1]) flag(s, 'async')
			if (decos.length) flag(s, 'decorated')
			symbols.push(s)
		} else if (c) {
			const e = blockEnd(i)
			const s = mk(c[1], 'class', i, decoStart >= 0 ? decoStart : i, e, !c[1].startsWith('_'))
			if (c[3]) {
				const bases = c[3].split(',').map((b) => b.trim()).filter((b) => b && !b.includes('=')).map((b) => b.replace(/\[.*$/, ''))
				if (bases.length) s.heritage = bases
			}
			if (decos.length) flag(s, 'decorated')
			parseClassBody(s, i, e)
			symbols.push(s)
		} else {
			const a = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::[^=]+)?=(?!=)/.exec(t) ?? /^([A-Za-z_]\w*)\s*:\s*[^=]+$/.exec(t)
			if (a && !/^(if|elif|while|for|with|return|assert|del|print|global|nonlocal|lambda|yield|raise|try|except)\b/.test(t)) {
				for (const name of a[1].split(',').map((x) => x.trim())) {
					if (symbols.some((s) => s.name === name)) continue
					const kind: SymbolKind = /^[A-Z][A-Z0-9_]*$/.test(name) ? 'const' : 'variable'
					symbols.push(mk(name, kind, i, i, L[i].last, !name.startsWith('_')))
				}
			}
		}
		decos = []
		decoStart = -1
	}

	// __all__ overrides exports
	const all = /^__all__\s*(?::[^=\n]+)?=\s*[[(]([\s\S]*?)[\])]/m.exec(text)
	if (all) {
		const names = new Set([...all[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)].map((m) => m[1]))
		for (const s of symbols) s.exported = names.has(s.name)
	}

	const top = new Set(symbols.map((s) => s.name))
	const locals = new Set(imports.map((b) => b.local))
	const physLines = src.split('\n')
	const collect = (s: PySym, memberNames?: Set<string>) => {
		const refs = new OrderedSet()
		const calls = new OrderedSet()
		const irefs = new OrderedSet()
		const mrefs = new OrderedSet()
		for (let q = s.from; q <= s.to && q < physLines.length; q++) {
			let line = physLines[q]
			if (q === s.line - 1) line = line.replace(/^\s*(async\s+)?(def|class)\s+[A-Za-z_]\w*/, '')
			IDENT.lastIndex = 0
			for (const m of line.matchAll(IDENT)) {
				const at = m.index!
				const before = line.slice(0, at).trimEnd()
				const v = m[0]
				if (before.endsWith('.')) {
					if (memberNames && /\bself\s*\.$/.test(before) && memberNames.has(v) && v !== s.name) mrefs.add(v)
					continue
				}
				if (v === s.name && !memberNames) continue
				const after = line.slice(at + v.length)
				if (top.has(v) && v !== s.name) {
					refs.add(v)
					if (/^\s*\(/.test(after)) calls.add(v)
				} else if (locals.has(v)) irefs.add(v)
			}
		}
		s.refs = refs.list
		s.calls = calls.list
		s.importRefs = irefs.list
		if (memberNames) s.memberRefs = mrefs.list
	}
	for (const s of symbols) {
		collect(s)
		if (s.membersX) {
			const names = new Set(s.membersX.map((m) => m.name))
			for (const m of s.membersX) collect(m, names)
		}
	}
	const finish = (s: PySym): CodeSymbol => {
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
