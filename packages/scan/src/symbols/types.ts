/** Symbol extraction types (shared by the TS/JS, Python, Go and Rust extractors). */

export type SymbolLang = 'ts' | 'js' | 'python' | 'go' | 'rust' | 'unknown'

export type SymbolKind =
	| 'class'
	| 'function'
	| 'const'
	| 'variable'
	| 'type'
	| 'interface'
	| 'enum'
	| 'namespace'
	| 'method'
	| 'property'
	| 'getter'
	| 'setter'
	| 'constructor'
	| 'struct'
	| 'trait'
	| 'impl'

export interface CodeSymbol {
	name: string
	kind: SymbolKind
	exported: boolean
	/** 1-based line of the declaration name. */
	line: number
	/** Last line of the declaration. */
	endLine: number
	/** 'async','generator','arrow','static','private','protected','abstract','readonly','optional','default','declared-elsewhere','decorated' */
	flags?: string[]
	/** Other top-level symbol names of this file referenced in the body (deduped, first-use order). */
	refs: string[]
	/** Subset of `refs` used as calls (`name(`, `new Name`, JSX `<Name`, tagged templates). */
	calls: string[]
	/** Local import bindings referenced in the body. */
	importRefs: string[]
	/** Class / interface / struct / trait / enum members. */
	members?: CodeSymbol[]
	/** Members only: sibling members referenced via `this.x` / `self.x` / the Go receiver. */
	memberRefs?: string[]
	/** extends / implements names, Rust traits implemented, Go embedded types. */
	heritage?: string[]
}

export interface ImportBinding {
	local: string
	spec: string
	/** 'default' | '*' | the original exported name. */
	imported: string
	typeOnly?: boolean
}

export interface FileSymbols {
	lang: SymbolLang
	symbols: CodeSymbol[]
	imports: ImportBinding[]
	/** Every module specifier in source order, deduped. */
	specs: string[]
	reexports: { spec: string; names: string[] }[]
}

export const MAX_SYMBOLS = 2000

export function emptySymbols(lang: SymbolLang): FileSymbols {
	return { lang, symbols: [], imports: [], specs: [], reexports: [] }
}

/** Ordered, deduped string collector. */
export class OrderedSet {
	private seen = new Set<string>()
	readonly list: string[] = []
	add(s: string) {
		if (this.seen.has(s)) return
		this.seen.add(s)
		this.list.push(s)
	}
	has(s: string) {
		return this.seen.has(s)
	}
}

/** Adds a flag once. */
export function flag(s: { flags?: string[] }, f: string) {
	if (!s.flags) s.flags = []
	if (!s.flags.includes(f)) s.flags.push(f)
}

/** Builds line-start offsets for offset → line lookups. */
export function lineStarts(text: string): number[] {
	const out = [0]
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1)
	return out
}

export function lineAt(starts: number[], offset: number): number {
	let lo = 0
	let hi = starts.length - 1
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1
		if (starts[mid] <= offset) lo = mid
		else hi = mid - 1
	}
	return lo + 1
}
