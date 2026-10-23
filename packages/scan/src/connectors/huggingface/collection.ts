/** Collections: one node per item type on the root, a page per type listing the items with links. */

import { asStr } from '../../util'
import type { HfClient } from './client'
import { humanCount, Page } from './graph'
import { hfUrl } from './parse'

export interface CollectionItem {
	type: 'model' | 'dataset' | 'space' | 'paper' | 'collection' | string
	id: string
	title?: string
	pipeline_tag?: string
	downloads?: number
	likes?: number
	upvotes?: number
	numParameters?: number
	sdk?: string
	note?: { text?: string }
	slug?: string
}

export interface CollectionMeta {
	slug: string
	title?: string
	description?: string
	owner?: { name?: string }
	items: CollectionItem[]
	upvotes?: number
}

export async function collectCollection(hf: HfClient, id: string): Promise<CollectionMeta> {
	return hf.api<CollectionMeta>(`/api/collections/${id.split('/').map(encodeURIComponent).join('/')}`, `collection ${id}`)
}

const TYPE_TITLE: Record<string, string> = { model: 'Models', dataset: 'Datasets', space: 'Spaces', paper: 'Papers', collection: 'Collections' }
const TYPE_ICON: Record<string, string> = { model: 'huggingface', dataset: 'database', space: 'app', paper: 'document', collection: 'layers' }

function itemLink(it: CollectionItem, endpoint: string): string | undefined {
	if (it.type === 'paper') return `${endpoint}/papers/${it.id}`
	if (it.type === 'model' || it.type === 'dataset' || it.type === 'space') return hfUrl(it.type, it.id, endpoint)
	if (it.type === 'collection') return hfUrl('collection', it.slug ?? it.id, endpoint)
	return undefined
}

function itemSrc(it: CollectionItem): string | undefined {
	if (it.type === 'model') return `hf:${it.id}`
	if (it.type === 'dataset') return `hf:datasets/${it.id}`
	if (it.type === 'space') return `hf:spaces/${it.id}`
	if (it.type === 'collection') return `hf:collections/${it.slug ?? it.id}`
	return undefined
}

function itemLabel(it: CollectionItem): string {
	const bits = [it.type === 'paper' ? (it.title ?? it.id) : it.id]
	if (it.numParameters) bits.push(`${humanCount(it.numParameters)} params`)
	if (it.pipeline_tag) bits.push(it.pipeline_tag)
	if (it.sdk) bits.push(it.sdk)
	if (it.downloads) bits.push(`${humanCount(it.downloads)} downloads`)
	if (it.type === 'paper' && it.upvotes) bits.push(`${it.upvotes} upvotes`)
	return bits.join(' · ')
}

export function renderCollection(c: CollectionMeta, id: string, srcBase: string, maxItems = 40, endpoint = 'https://huggingface.co') {
	const root = new Page('', 'right')
	const pages: Page[] = []
	const coll = root.node(id, { label: `${c.title ?? id}${c.owner?.name ? ` · by ${c.owner.name}` : ''} · ${c.items.length} items`, icon: 'huggingface', color: 'blue', link: hfUrl('collection', id, endpoint), src: srcBase })
	const byType = new Map<string, CollectionItem[]>()
	for (const it of c.items) {
		const t = asStr(it.type) ?? 'item'
		if (!byType.has(t)) byType.set(t, [])
		byType.get(t)!.push(it)
	}
	for (const [type, items] of byType) {
		const name = TYPE_TITLE[type] ?? `${type[0].toUpperCase()}${type.slice(1)}s`
		root.node(name, { label: `${name} (${items.length})`, icon: TYPE_ICON[type] ?? 'file', drill: name, src: `${srcBase}#${type}` })
		root.edge(coll, name)
		const p = new Page(name, 'down')
		const shown = items.slice(0, maxItems)
		const g = p.group(`${name} in ${c.title ?? id}`, { src: `${srcBase}#${type}` })
		for (const it of shown) p.node(`${type} ${it.id}`, { label: itemLabel(it) + (it.note?.text ? ` — ${it.note.text.slice(0, 80)}` : ''), icon: TYPE_ICON[type], parent: g, link: itemLink(it, endpoint), src: itemSrc(it) })
		if (items.length > shown.length) p.node(`More ${type}`, { label: `+ ${items.length - shown.length} more`, parent: g, src: `${srcBase}#${type}` })
		pages.push(p)
	}
	const header = [`source: ${hfUrl('collection', id, endpoint)}`, ...(c.description ? [`description: ${c.description.slice(0, 160)}`] : [])]
	const notes = [...byType].map(([t, xs]) => `${xs.length} ${t}(s)`)
	return { root, pages, header, notes, confidence: 1 }
}
