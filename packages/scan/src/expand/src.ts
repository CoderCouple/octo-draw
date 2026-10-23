/** `src` refs: parsing, formatting and the "structurally inside" relation used for recursion. */

import type { SrcRef } from './types'

const SCHEME_KIND: Record<string, string> = { local: 'local', file: 'local', github: 'github', gh: 'github', aws: 'aws', gcp: 'gcp', azure: 'azure', hf: 'huggingface', huggingface: 'huggingface' }

/** `hf` → `huggingface`; other known schemes are their kind. */
export function schemeKind(scheme: string): string {
	return SCHEME_KIND[scheme.toLowerCase()] ?? scheme.toLowerCase()
}

/** The scheme a connector kind writes (`huggingface` → `hf`). */
export function kindScheme(kind: string): string {
	return kind === 'huggingface' ? 'hf' : kind
}

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\.$/, '').replace(/\/+$/, '')

/**
 * Parses `<scheme>:<path>[#fragment]`. Cloud ids keep everything after the
 * scheme (ARNs contain `:`; GCP names contain `//`). Code paths are
 * normalised (`./a/` → `a`, `.` → ``). A value without a scheme is a code
 * path relative to the source (scheme `''`, kind `''`). The GitHub long form
 * `github:o/r@ref:path` fills `repo` / `ref`.
 */
export function parseSrc(raw: string): SrcRef {
	const text = raw.trim()
	const m = /^([a-z][a-z0-9+-]*):(.*)$/i.exec(text)
	const scheme = m ? m[1].toLowerCase() : ''
	let rest = m ? m[2] : text
	const kind = scheme ? schemeKind(scheme) : ''
	const out: SrcRef = { kind, scheme, path: '', raw }
	const isCloud = kind === 'aws' || kind === 'gcp' || kind === 'azure'
	if (isCloud) {
		out.path = rest
		return out
	}
	const hash = rest.indexOf('#')
	if (hash >= 0) {
		const frag = rest.slice(hash + 1)
		if (frag) out.fragment = frag
		rest = rest.slice(0, hash)
	}
	if (kind === 'github') {
		const long = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^:]+):(.*)$/.exec(rest)
		if (long) {
			out.repo = long[1]
			out.ref = long[2]
			rest = long[3]
		}
	}
	out.path = kind === 'huggingface' ? rest : normPath(rest)
	return out
}

/** Formats a src ref: `local:apps/server/src`, `local:a.ts#Parser.parseItem`, `aws:arn:...`. */
export function formatSrc(scheme: string, path: string, fragment?: string): string {
	return `${scheme}:${path}${fragment ? `#${fragment}` : ''}`
}

/**
 * Is `child` structurally inside `parent`? Used when a page has no explicit
 * `children` list (scanner pages):
 * - a path under the parent's path (directory containment; the repo root `''` contains everything),
 * - the parent's file with a fragment (file → symbol),
 * - a fragment extending the parent's fragment (`Parser` → `Parser.parseItem`).
 * `uses:` fragments (dependency users) and different schemes are never inside.
 */
export function isChildSrc(parent: SrcRef, child: SrcRef): boolean {
	if (parent.kind !== child.kind) return false
	if (child.fragment?.startsWith('uses:')) return false
	if (parent.fragment?.startsWith('uses:')) return false
	if (parent.kind === 'aws' || parent.kind === 'gcp' || parent.kind === 'azure') return false
	if (parent.fragment === undefined) {
		if (child.path === parent.path) return child.fragment !== undefined
		return parent.path === '' ? child.path !== '' : child.path.startsWith(parent.path + '/')
	}
	return child.path === parent.path && child.fragment !== undefined && child.fragment.startsWith(parent.fragment + '.')
}
