/** Rust symbol extraction (best effort): fn, struct, enum, trait, impl blocks (methods attached to the type), const / static / type, mod, use. */

import { matchC, tokenizeC } from './clike'
import { collectC, finishC, mkC, unionElsewhere, type CSym } from './go'
import { emptySymbols, flag, MAX_SYMBOLS, OrderedSet, type FileSymbols, type ImportBinding } from './types'

export function extractRust(text: string): FileSymbols {
	const out = emptySymbols('rust')
	const toks = tokenizeC(text, 'rust')
	const n = toks.length
	const match = matchC(toks)
	const jump = (i: number) => (match[i] > i ? match[i] : n - 1)
	const isP = (i: number, v: string) => toks[i]?.type === 'punct' && toks[i].value === v
	const isW = (i: number, v: string) => toks[i]?.type === 'ident' && toks[i].value === v
	const isId = (i: number) => toks[i]?.type === 'ident'
	const symbols: CSym[] = []
	const byName = new Map<string, CSym>()
	const imports: ImportBinding[] = []
	const specs = new OrderedSet()
	const impls: { type: string; trait?: string; methods: CSym[]; at: number }[] = []

	const add = (s: CSym) => {
		if (symbols.length >= MAX_SYMBOLS) return
		const prev = byName.get(s.name)
		if (prev) return
		symbols.push(s)
		byName.set(s.name, s)
	}
	/** Index of the `;` ending an item, or the closer of its first top-level `{` group. */
	const itemEnd = (i: number, limit: number): number => {
		for (let k = i; k < limit; k++) {
			if (isP(k, ';')) return k
			if (isP(k, '{')) return jump(k)
			if (isP(k, '(') || isP(k, '[')) k = jump(k)
		}
		return limit - 1
	}
	/** Skips a `<...>` generic list starting at i; returns the index after it. */
	const skipAngle = (i: number): number => {
		if (!isP(i, '<')) return i
		let depth = 0
		for (let k = i; k < n; k++) {
			const v = toks[k].value
			if (toks[k].type !== 'punct') continue
			if (v === '<') depth++
			else if (v === '>') depth--
			else if (v === '>>') depth -= 2
			else if (v === '(' || v === '[') k = jump(k)
			else if (v === '{' || v === ';') return k
			if (depth <= 0) return k + 1
		}
		return n
	}
	const useTree = (i: number, end: number, prefix: string[]) => {
		// parses one use-tree starting at i; returns index after it
		let k = i
		const path = [...prefix]
		while (k < end) {
			if (isP(k, '::')) {
				k++
				continue
			}
			if (isP(k, '{')) {
				const c = jump(k)
				let q = k + 1
				while (q < c) {
					q = useTree(q, c, path)
					if (isP(q, ',')) q++
					else if (q < c && !isId(q) && !isP(q, '*') && !isP(q, '{')) q++
				}
				return c + 1
			}
			if (isP(k, '*')) {
				if (path.length) specs.add(path.join('::'))
				return k + 1
			}
			if (isId(k)) {
				const seg = toks[k].value
				if (isP(k + 1, '::')) {
					path.push(seg)
					k += 2
					continue
				}
				let local = seg
				let q = k + 1
				if (isW(q, 'as') && isId(q + 1)) {
					local = toks[q + 1].value
					q += 2
				}
				if (seg === 'self') {
					const spec = path.join('::')
					if (spec) {
						specs.add(spec)
						if (local !== '_') imports.push({ local: local === 'self' ? path[path.length - 1] : local, spec: path.slice(0, -1).join('::') || spec, imported: path[path.length - 1] })
					}
				} else {
					specs.add([...path, seg].join('::'))
					if (local !== '_') imports.push({ local, spec: path.join('::') || seg, imported: seg })
				}
				return q
			}
			return k + 1
		}
		return k
	}

	/** Parses items in [from, to); `onFn` receives fns (for trait / impl bodies). */
	const items = (from: number, to: number, inner: ((s: CSym) => void) | null) => {
		let i = from
		for (let guard = 0; i < to && guard < 1_000_000; guard++) {
			const start = i
			// attributes
			if (isP(i, '#')) {
				let k = i + 1
				if (isP(k, '!')) k++
				if (isP(k, '[')) {
					i = jump(k) + 1
					continue
				}
			}
			let pub = false
			const flags: string[] = []
			for (;;) {
				if (isW(i, 'pub')) {
					pub = true
					i++
					if (isP(i, '(')) i = jump(i) + 1
					continue
				}
				if (isW(i, 'async') || isW(i, 'unsafe') || isW(i, 'default') || (isW(i, 'const') && (isW(i + 1, 'fn') || isW(i + 1, 'unsafe') || isW(i + 1, 'async')))) {
					if (toks[i].value === 'async') flags.push('async')
					i++
					continue
				}
				if (isW(i, 'extern') && toks[i + 1]?.type === 'string') {
					i += 2
					continue
				}
				break
			}
			const kw = toks[i]
			if (!kw) break
			const v = kw.type === 'ident' ? kw.value : ''
			if (v === 'fn' && isId(i + 1)) {
				const end = itemEnd(i + 2, to)
				const s = mkC(toks, toks[i + 1].value, inner ? 'method' : 'function', i + 1, start, end, pub)
				for (const f of flags) flag(s, f)
				if (inner) inner(s)
				else add(s)
				i = end + 1
				continue
			}
			if ((v === 'struct' || v === 'union') && isId(i + 1)) {
				const end = itemEnd(i + 2, to)
				const s = mkC(toks, toks[i + 1].value, 'struct', i + 1, start, end, pub)
				s.membersX = []
				const open = toks.findIndex((t, k) => k > i + 1 && k <= end && t.type === 'punct' && (t.value === '{' || t.value === '(' || t.value === ';'))
				if (open >= 0 && isP(open, '{')) {
					const c = jump(open)
					for (let k = open + 1; k < c; k++) {
						if (isP(k, '(') || isP(k, '[') || isP(k, '{')) {
							k = jump(k)
							continue
						}
						const p = toks[k - 1]
						if (isId(k) && isP(k + 1, ':') && p && (p.value === '{' || p.value === ',' || p.value === ']' || p.value === ')' || p.value === 'pub')) s.membersX.push(mkC(toks, toks[k].value, 'property', k, k, k, toks[k - 1]?.value === 'pub' || toks[k - 1]?.value === ')'))
					}
				}
				add(s)
				i = end + 1
				continue
			}
			if (v === 'enum' && isId(i + 1)) {
				const end = itemEnd(i + 2, to)
				const s = mkC(toks, toks[i + 1].value, 'enum', i + 1, start, end, pub)
				s.membersX = []
				const open = toks.findIndex((t, k) => k > i + 1 && k <= end && t.type === 'punct' && t.value === '{')
				if (open >= 0) {
					const c = jump(open)
					for (let k = open + 1; k < c; k++) {
						if (isP(k, '(') || isP(k, '[') || isP(k, '{')) {
							k = jump(k)
							continue
						}
						const p = toks[k - 1]
						if (isId(k) && p && (p.value === '{' || p.value === ',' || p.value === ']')) s.membersX.push(mkC(toks, toks[k].value, 'property', k, k, k, pub))
					}
				}
				add(s)
				i = end + 1
				continue
			}
			if (v === 'trait' && isId(i + 1)) {
				const end = itemEnd(i + 2, to)
				const s = mkC(toks, toks[i + 1].value, 'trait', i + 1, start, end, pub)
				s.membersX = []
				let k = skipAngle(i + 2)
				const her: string[] = []
				if (isP(k, ':')) {
					for (k = k + 1; k < end && !isP(k, '{') && !isW(k, 'where'); k++) {
						if (isP(k, '<')) {
							k = skipAngle(k) - 1
							continue
						}
						if (isId(k) && !isP(k + 1, '::') && (toks[k - 1].value === ':' || toks[k - 1].value === '+' || toks[k - 1].value === '::')) her.push(toks[k].value)
					}
				}
				if (her.length) s.heritage = her
				const open = toks.findIndex((t, q) => q > i + 1 && q <= end && t.type === 'punct' && t.value === '{')
				if (open >= 0) items(open + 1, jump(open), (m) => s.membersX!.push(m))
				add(s)
				i = end + 1
				continue
			}
			if (v === 'impl') {
				const end = itemEnd(i + 1, to)
				let k = skipAngle(i + 1)
				if (isP(k, '!')) k++
				const path = (from: number): { name: string; next: number } => {
					let q = from
					let name = ''
					while (q < end) {
						if (isP(q, '&') || isW(q, 'dyn') || isW(q, 'mut') || toks[q].type === 'lifetime') {
							q++
							continue
						}
						if (isId(q)) {
							name = toks[q].value
							q++
							if (isP(q, '::')) {
								q++
								continue
							}
							if (isP(q, '<')) q = skipAngle(q)
							if (isP(q, '::')) {
								q++
								continue
							}
							break
						}
						break
					}
					return { name, next: q }
				}
				const first = path(k)
				let type = first.name
				let trait: string | undefined
				if (isW(first.next, 'for')) {
					trait = first.name
					type = path(first.next + 1).name
				}
				const methods: CSym[] = []
				const open = toks.findIndex((t, q) => q >= first.next && q <= end && t.type === 'punct' && t.value === '{')
				if (open >= 0) items(open + 1, jump(open), (m) => methods.push(m))
				if (type) impls.push({ type, trait, methods, at: start })
				i = end + 1
				continue
			}
			if ((v === 'const' || v === 'static') && isId(i + 1)) {
				let k = i + 1
				if (isW(k, 'mut')) k++
				const end = itemEnd(k, to)
				if (isId(k) && toks[k].value !== '_') {
					const s = mkC(toks, toks[k].value, v === 'const' ? 'const' : 'variable', k, start, end, pub)
					if (inner) inner(s)
					else add(s)
				}
				i = end + 1
				continue
			}
			if (v === 'type' && isId(i + 1)) {
				const end = itemEnd(i + 2, to)
				const s = mkC(toks, toks[i + 1].value, 'type', i + 1, start, end, pub)
				if (inner) inner(s)
				else add(s)
				i = end + 1
				continue
			}
			if (v === 'mod' && isId(i + 1)) {
				if (isP(i + 2, ';')) {
					specs.add(`crate::${toks[i + 1].value}`)
					i += 3
					continue
				}
				const end = itemEnd(i + 2, to)
				add(mkC(toks, toks[i + 1].value, 'namespace', i + 1, start, end, pub))
				i = end + 1
				continue
			}
			if (v === 'use') {
				const end = itemEnd(i + 1, to)
				useTree(i + 1, end, [])
				i = end + 1
				continue
			}
			if (v === 'extern' && isW(i + 1, 'crate') && isId(i + 2)) {
				const name = toks[i + 2].value
				let local = name
				if (isW(i + 3, 'as') && isId(i + 4)) local = toks[i + 4].value
				specs.add(name)
				imports.push({ local, spec: name, imported: '*' })
				i = itemEnd(i + 2, to) + 1
				continue
			}
			if (v === 'macro_rules' && isP(i + 1, '!')) {
				i = itemEnd(i + 2, to) + 1
				continue
			}
			if (isP(i, '{') || isP(i, '(') || isP(i, '[')) {
				i = jump(i) + 1
				continue
			}
			i = Math.max(i, start) + 1
		}
	}
	items(0, n, null)

	for (const im of impls) {
		let owner = byName.get(im.type)
		if (!owner) {
			const at = im.methods[0]
			owner = mkC(toks, im.type, 'struct', at?.nameTok ?? im.at, at?.from ?? im.at, at?.to ?? im.at, im.methods.some((m) => m.exported))
			flag(owner, 'declared-elsewhere')
			owner.membersX = []
			add(owner)
			if (byName.get(im.type) !== owner) continue
		}
		owner.membersX ??= []
		for (const m of im.methods) {
			if (!owner.membersX.some((x) => x.name === m.name)) owner.membersX.push(m)
			if (owner.flags?.includes('declared-elsewhere')) owner.endLine = Math.max(owner.endLine, m.endLine)
		}
		if (im.trait) owner.heritage = [...new Set([...(owner.heritage ?? []), im.trait])]
	}
	collectC(toks, symbols, imports, 'rust')
	unionElsewhere(symbols)
	out.symbols = symbols.map(finishC)
	out.imports = imports
	out.specs = specs.list
	return out
}
