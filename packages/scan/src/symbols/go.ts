/** Go symbol extraction (best effort): funcs, methods (attached to their receiver type), types, const / var, imports. */

import { matchC, tokenizeC, type CTok } from './clike'
import { emptySymbols, flag, MAX_SYMBOLS, OrderedSet, type CodeSymbol, type FileSymbols, type ImportBinding, type SymbolKind } from './types'

export interface CSym extends CodeSymbol {
	from: number
	to: number
	nameTok: number
	membersX?: CSym[]
	/** Go receiver name / Rust: 'self'. */
	receiver?: string
}

export function mkC(toks: CTok[], name: string, kind: SymbolKind, nameTok: number, from: number, to: number, exported: boolean): CSym {
	return { name, kind, exported, line: toks[nameTok]?.line ?? 1, endLine: toks[Math.min(to, toks.length - 1)]?.line ?? 1, refs: [], calls: [], importRefs: [], from, to, nameTok }
}

/** Fills refs / calls / importRefs / memberRefs for top-level symbols and their members. */
export function collectC(toks: CTok[], symbols: CSym[], imports: ImportBinding[], lang: 'go' | 'rust', skip: Set<number> = new Set()) {
	const top = new Set(symbols.map((s) => s.name))
	const structs = new Set(symbols.filter((s) => s.kind === 'struct' || s.kind === 'enum').map((s) => s.name))
	const locals = new Set(imports.map((b) => b.local))
	const run = (s: CSym, memberNames?: Set<string>) => {
		const refs = new OrderedSet()
		const calls = new OrderedSet()
		const irefs = new OrderedSet()
		const mrefs = new OrderedSet()
		for (let k = Math.max(0, s.from); k <= Math.min(s.to, toks.length - 1); k++) {
			const t = toks[k]
			if (t.type !== 'ident') continue
			const prev = toks[k - 1]
			const next = toks[k + 1]
			if (memberNames && next?.value === '.' && toks[k + 2]?.type === 'ident') {
				const recv = lang === 'go' ? s.receiver : 'self'
				if (recv && t.value === recv && prev?.value !== '.') {
					const m = toks[k + 2].value
					if (memberNames.has(m) && m !== s.name) mrefs.add(m)
					k += 2
					continue
				}
			}
			if (memberNames && lang === 'rust' && t.value === 'Self' && next?.value === '::' && toks[k + 2]?.type === 'ident') {
				const m = toks[k + 2].value
				if (memberNames.has(m) && m !== s.name) mrefs.add(m)
				k += 2
				continue
			}
			if (k === s.nameTok || skip.has(k)) continue
			if (prev && (prev.value === '.' || prev.value === '::') && prev.type === 'punct') continue
			const v = t.value
			if (v === s.name && !memberNames) continue
			if (top.has(v) && v !== s.name) {
				refs.add(v)
				const isCall = next?.value === '(' || (next?.value === '{' && structs.has(v) && prev?.value !== 'struct') || (lang === 'rust' && next?.value === '::' && toks[k + 3]?.value === '(')
				if (isCall) calls.add(v)
			} else if (locals.has(v)) irefs.add(v)
		}
		s.refs = refs.list
		s.calls = calls.list
		s.importRefs = irefs.list
		if (memberNames) s.memberRefs = mrefs.list
	}
	for (const s of symbols) {
		run(s)
		if (s.membersX) {
			const names = new Set(s.membersX.map((m) => m.name))
			for (const m of s.membersX) run(m, names)
		}
	}
}

/** Types declared in another file: their refs are the union of their (method) members' refs. */
export function unionElsewhere(symbols: CSym[]) {
	for (const s of symbols) {
		if (!s.flags?.includes('declared-elsewhere') || !s.membersX) continue
		const r = new OrderedSet()
		const c = new OrderedSet()
		const ir = new OrderedSet()
		for (const m of s.membersX) {
			for (const x of m.refs) if (x !== s.name) r.add(x)
			for (const x of m.calls) if (x !== s.name) c.add(x)
			for (const x of m.importRefs) ir.add(x)
		}
		s.refs = r.list
		s.calls = c.list
		s.importRefs = ir.list
	}
}

export function finishC(s: CSym): CodeSymbol {
	const c: CodeSymbol = { name: s.name, kind: s.kind, exported: s.exported, line: s.line, endLine: s.endLine, refs: s.refs, calls: s.calls, importRefs: s.importRefs }
	if (s.flags?.length) c.flags = s.flags
	if (s.heritage?.length) c.heritage = s.heritage
	if (s.memberRefs) c.memberRefs = s.memberRefs
	if (s.membersX) c.members = s.membersX.map(finishC)
	return c
}

const cap = (s: string) => /^[A-Z]/.test(s)
const unq = (s: string) => s.replace(/^["`]|["`]$/g, '')

export function extractGo(text: string): FileSymbols {
	const out = emptySymbols('go')
	const toks = tokenizeC(text, 'go')
	const n = toks.length
	const match = matchC(toks)
	const jump = (i: number) => (match[i] > i ? match[i] : n - 1)
	const isP = (i: number, v: string) => toks[i]?.type === 'punct' && toks[i].value === v
	const isW = (i: number, v: string) => toks[i]?.type === 'ident' && toks[i].value === v
	const isId = (i: number) => toks[i]?.type === 'ident'
	const symbols: CSym[] = []
	const byName = new Map<string, CSym>()
	const methods: { type: string; sym: CSym }[] = []
	const imports: ImportBinding[] = []
	const specs = new OrderedSet()
	const declNames = new Set<number>()
	const add = (s: CSym) => {
		if (symbols.length >= MAX_SYMBOLS || byName.has(s.name)) return
		symbols.push(s)
		byName.set(s.name, s)
	}
	/** End of a line-ish spec starting at i (next token on a new line, or `;`, at depth 0, bounded by limit). */
	const lineEnd = (i: number, limit: number) => {
		let j = i
		while (j < limit) {
			if (isP(j, '(') || isP(j, '{') || isP(j, '[')) j = Math.min(jump(j), limit - 1)
			if (isP(j, ';')) return j
			if (j + 1 < limit && toks[j + 1].nl) return j
			j++
		}
		return limit - 1
	}
	const importSpec = (i: number) => {
		let alias: string | undefined
		let j = i
		if (isId(j) || isP(j, '.') || isP(j, '_')) {
			alias = toks[j].value
			j++
		}
		if (toks[j]?.type !== 'string') return
		const spec = unq(toks[j].value)
		specs.add(spec)
		if (alias === '_' || alias === '.') return
		const segs = spec.split('/')
		let local = segs[segs.length - 1]
		if (/^v\d+$/.test(local) && segs.length > 1) local = segs[segs.length - 2]
		local = local.replace(/^go-/, '').replace(/[.-].*$/, '')
		imports.push({ local: alias ?? local, spec, imported: '*' })
	}
	/** Type declaration spec at i (name ...). Returns end index. */
	const typeSpec = (i: number, limit: number, from: number): number => {
		if (!isId(i)) return lineEnd(i, limit)
		const nameTok = i
		const name = toks[i].value
		let j = i + 1
		if (isP(j, '[') && isId(j + 1) && !isP(j + 2, ']')) j = jump(j) + 1
		if (isP(j, '=')) j++
		if (isW(j, 'struct') && isP(j + 1, '{')) {
			const end = jump(j + 1)
			const s = mkC(toks, name, 'struct', nameTok, from, end, cap(name))
			s.membersX = []
			const her: string[] = []
			// fields, one per line
			let k = j + 2
			while (k < end) {
				const le = lineEnd(k, end)
				const t0 = toks[k]
				if (t0.type === 'ident' && (isP(k + 1, ',') || (k + 1 <= le && !isP(k + 1, '.') && toks[k + 1].type !== 'string'))) {
					let q = k
					while (isId(q)) {
						s.membersX.push(mkC(toks, toks[q].value, 'property', q, q, le, cap(toks[q].value)))
						if (isP(q + 1, ',')) q += 2
						else break
					}
				} else {
					// embedded: T, *T, pkg.T
					let q = k
					if (isP(q, '*')) q++
					let last = ''
					while (isId(q)) {
						last = toks[q].value
						if (isP(q + 1, '.')) q += 2
						else break
					}
					if (last) her.push(last)
				}
				k = le + 1
			}
			if (her.length) s.heritage = her
			add(s)
			return end
		}
		if (isW(j, 'interface') && isP(j + 1, '{')) {
			const end = jump(j + 1)
			const s = mkC(toks, name, 'interface', nameTok, from, end, cap(name))
			s.membersX = []
			const her: string[] = []
			let k = j + 2
			while (k < end) {
				const le = lineEnd(k, end)
				if (isId(k) && isP(k + 1, '(')) s.membersX.push(mkC(toks, toks[k].value, 'method', k, k, le, cap(toks[k].value)))
				else if (isId(k) && (k === le || (isP(k + 1, '.') && isId(k + 2) && k + 2 === le))) her.push(toks[k + 2 === le && isP(k + 1, '.') ? k + 2 : k].value)
				k = le + 1
			}
			if (her.length) s.heritage = her
			add(s)
			return end
		}
		const end = lineEnd(j, limit)
		add(mkC(toks, name, 'type', nameTok, from, end, cap(name)))
		return end
	}
	const valueSpec = (i: number, limit: number, kind: SymbolKind, from: number): number => {
		const end = lineEnd(i, limit)
		let q = i
		for (let w = i; isId(w); w += 2) {
			declNames.add(w)
			if (!isP(w + 1, ',')) break
		}
		while (isId(q)) {
			if (toks[q].value !== '_') add(mkC(toks, toks[q].value, kind, q, from, end, cap(toks[q].value)))
			if (isP(q + 1, ',')) q += 2
			else break
		}
		return end
	}
	const group = (i: number, fn: (k: number, limit: number, from: number) => number) => {
		// i at '('
		const end = jump(i)
		let k = i + 1
		while (k < end) {
			if (isP(k, ';')) {
				k++
				continue
			}
			const e = fn(k, end, k)
			k = Math.max(e, k) + 1
		}
		return end
	}

	let i = 0
	for (let guard = 0; i < n && guard < 1_000_000; guard++) {
		const t = toks[i]
		if (t.type === 'ident' && t.value === 'package') {
			i += 2
			continue
		}
		if (t.type === 'ident' && t.value === 'import') {
			if (isP(i + 1, '(')) {
				const end = jump(i + 1)
				let k = i + 2
				while (k < end) {
					const le = lineEnd(k, end)
					importSpec(k)
					k = le + 1
				}
				i = end + 1
			} else {
				importSpec(i + 1)
				i = lineEnd(i, n) + 1
			}
			continue
		}
		if (t.type === 'ident' && t.value === 'func') {
			let j = i + 1
			let recvType: string | undefined
			let recvName: string | undefined
			if (isP(j, '(')) {
				const rc = jump(j)
				const inner = toks.slice(j + 1, rc)
				const ids = inner.filter((x) => x.type === 'ident')
				if (inner.length && inner[0].type === 'ident' && (inner[1]?.type === 'ident' || inner[1]?.value === '*')) recvName = inner[0].value
				// type: last identifier before any '['
				const br = inner.findIndex((x) => x.value === '[')
				const tIds = (br >= 0 ? inner.slice(0, br) : inner).filter((x) => x.type === 'ident')
				recvType = tIds[tIds.length - 1]?.value ?? ids[ids.length - 1]?.value
				j = rc + 1
			}
			if (!isId(j)) {
				i = lineEnd(i, n) + 1
				continue
			}
			const nameTok = j
			const name = toks[j].value
			j++
			if (isP(j, '[')) j = jump(j) + 1
			if (isP(j, '(')) j = jump(j) + 1
			// body: first '{' not belonging to struct{} / interface{} result types
			let body = -1
			for (let k = j; k < n; k++) {
				if (isP(k, '{')) {
					if (isW(k - 1, 'struct') || isW(k - 1, 'interface')) {
						k = jump(k)
						continue
					}
					body = k
					break
				}
				if (isP(k, '(') || isP(k, '[')) {
					k = jump(k)
					continue
				}
				if (toks[k].nl && k > j) break
			}
			const end = body >= 0 ? jump(body) : lineEnd(j, n)
			if (recvType) {
				const m = mkC(toks, name, 'method', nameTok, i, end, cap(name))
				m.receiver = recvName
				methods.push({ type: recvType, sym: m })
			} else add(mkC(toks, name, 'function', nameTok, i, end, cap(name)))
			i = end + 1
			continue
		}
		if (t.type === 'ident' && t.value === 'type') {
			i = (isP(i + 1, '(') ? group(i + 1, typeSpec) : typeSpec(i + 1, n, i)) + 1
			continue
		}
		if (t.type === 'ident' && (t.value === 'const' || t.value === 'var')) {
			const kind: SymbolKind = t.value === 'const' ? 'const' : 'variable'
			i = (isP(i + 1, '(') ? group(i + 1, (k, l, f) => valueSpec(k, l, kind, f)) : valueSpec(i + 1, n, kind, i)) + 1
			continue
		}
		if (isP(i, '{') || isP(i, '(') || isP(i, '[')) {
			i = jump(i) + 1
			continue
		}
		i++
	}

	// attach methods to their receiver types
	for (const { type, sym } of methods) {
		let owner = byName.get(type)
		if (!owner) {
			owner = mkC(toks, type, 'struct', sym.nameTok, sym.from, sym.to, cap(type))
			owner.line = sym.line
			flag(owner, 'declared-elsewhere')
			owner.membersX = []
			add(owner)
			if (!byName.has(type)) continue
		}
		owner.membersX ??= []
		owner.membersX.push(sym)
		if (owner.flags?.includes('declared-elsewhere')) {
			owner.endLine = Math.max(owner.endLine, sym.endLine)
			owner.to = Math.max(owner.to, sym.to)
		}
	}
	collectC(toks, symbols, imports, 'go', declNames)
	unionElsewhere(symbols)
	out.symbols = symbols.map(finishC)
	out.imports = imports
	out.specs = specs.list
	return out
}
