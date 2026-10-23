/**
 * Hugging Face inputs → SourceRef.
 *
 *   hf:org/name                      model (hf:gpt2 for legacy un-namespaced ids)
 *   hf:datasets/org/name             dataset (also hf:spaces/..., hf:collections/...)
 *   huggingface.co/org/name          model (https://, www., hf.co, /tree/<rev>, /blob/<rev>/... all fine)
 *   huggingface.co/datasets/org/name dataset
 *   huggingface.co/spaces/org/name   space
 *   huggingface.co/collections/owner/slug
 *   `@rev` suffix on any of them picks a revision
 */

import type { SourceRef } from '../types'

export type HfRepoType = 'model' | 'dataset' | 'space' | 'collection'

export interface HfRef extends SourceRef {
	kind: 'huggingface'
	options: { type: HfRepoType } & Record<string, unknown>
}

const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** First path segments that are site pages, not orgs. */
const RESERVED = new Set(['models', 'docs', 'blog', 'papers', 'pricing', 'settings', 'login', 'join', 'organizations', 'tasks', 'learn', 'posts', 'enterprise', 'api', 'new', 'search', 'chat'])
const TYPES: Record<string, HfRepoType> = { datasets: 'dataset', dataset: 'dataset', spaces: 'space', space: 'space', collections: 'collection', collection: 'collection', models: 'model', model: 'model' }

export function parseHuggingface(input: string): HfRef | null {
	let s = input.trim()
	let explicit = false
	const pre = /^(?:hf|huggingface):/i.exec(s)
	if (pre) {
		s = s.slice(pre[0].length).replace(/^\/+/, '')
		explicit = true
	} else {
		const m = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)(\/.*)?$/i.exec(s)
		if (!m) return null
		s = (m[1] ?? '').replace(/^\/+/, '')
	}
	s = s.replace(/[?#].*$/, '').replace(/\/+$/, '')
	let rev: string | undefined
	const at = /@([^/@\s]+)$/.exec(s)
	if (at) {
		rev = decodeURIComponent(at[1])
		s = s.slice(0, at.index)
	}
	const parts = s.split('/').filter(Boolean)
	if (!parts.length) return null
	let type: HfRepoType = 'model'
	if (TYPES[parts[0].toLowerCase()] && parts.length >= 2) type = TYPES[parts.shift()!.toLowerCase()]
	else if (!explicit && RESERVED.has(parts[0].toLowerCase())) return null

	let idParts: string[]
	if (type === 'collection') {
		if (parts.length < 2) return null
		idParts = parts.slice(0, 2)
	} else {
		// `org/name[/tree|blob|resolve/<rev>/...]`
		const marker = parts.findIndex((p, i) => i >= 1 && (p === 'tree' || p === 'blob' || p === 'resolve' || p === 'commit'))
		const head = marker >= 0 ? parts.slice(0, marker) : parts
		if (marker >= 0 && parts[marker + 1] && !rev) rev = decodeURIComponent(parts[marker + 1])
		if (head.length === 2) idParts = head
		else if (head.length === 1 && explicit && type === 'model') idParts = head
		else return null
	}
	if (!idParts.every((p) => SEG.test(p))) return null
	const ref: HfRef = { kind: 'huggingface', id: idParts.join('/'), options: { type } }
	if (rev && type !== 'collection') ref.ref = rev
	return ref
}

/** Canonical web URL for a repo / collection. */
export function hfUrl(type: HfRepoType, id: string, base = 'https://huggingface.co'): string {
	const prefix = type === 'dataset' ? 'datasets/' : type === 'space' ? 'spaces/' : type === 'collection' ? 'collections/' : ''
	return `${base}/${prefix}${id}`
}
