/**
 * Symbol extraction for code expansion: top-level declarations, members,
 * imports and intra-file references. TS/JS uses a real tokenizer (comments,
 * strings, templates, regex literals, JSX); Python, Go and Rust are best effort.
 * Pure and never throws.
 */

import { extractGo } from './go'
import { extractJs } from './js'
import { extractPython } from './python'
import { extractRust } from './rust'
import { emptySymbols, type FileSymbols, type SymbolLang } from './types'

export type { SymbolLang, SymbolKind, CodeSymbol, ImportBinding, FileSymbols } from './types'
export { tokenizeJs, type JsToken } from './jsTokenize'

export function langOf(path: string): SymbolLang {
	const p = path.toLowerCase()
	if (/\.(ts|tsx|mts|cts)$/.test(p)) return 'ts'
	if (/\.(js|jsx|mjs|cjs|vue|svelte)$/.test(p)) return 'js'
	if (/\.pyi?$/.test(p)) return 'python'
	if (/\.go$/.test(p)) return 'go'
	if (/\.rs$/.test(p)) return 'rust'
	return 'unknown'
}

/** `<script>` blocks of a .vue / .svelte file, other text blanked (line numbers kept). */
function scriptBlocks(text: string): string {
	let out = text.replace(/[^\n]/g, ' ')
	for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
		const start = m.index! + m[0].indexOf(m[1], m[0].indexOf('>'))
		out = out.slice(0, start) + m[1] + out.slice(start + m[1].length)
	}
	return out
}

export function extractSymbols(path: string, text: string): FileSymbols {
	const lang = langOf(path)
	try {
		switch (lang) {
			case 'ts':
				return extractJs(text, 'ts', /\.tsx$/i.test(path))
			case 'js': {
				const sfc = /\.(vue|svelte)$/i.test(path)
				return extractJs(sfc ? scriptBlocks(text) : text, 'js', !sfc && !/\.(mjs|cjs)$/i.test(path))
			}
			case 'python':
				return extractPython(text)
			case 'go':
				return extractGo(text)
			case 'rust':
				return extractRust(text)
			default:
				return emptySymbols('unknown')
		}
	} catch {
		return emptySymbols(lang)
	}
}
