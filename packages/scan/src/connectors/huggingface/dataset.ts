/**
 * Dataset repos: configs → splits (rows, bytes) and features, from the
 * datasets-server `/info` (falling back to the card's `dataset_info`), plus
 * size, modality, task and license; optionally the most downloaded models
 * trained on it (capped).
 */

import { asArr, asObj, asStr, isObj, type Obj } from '../../util'
import { cardOf, licenseOf, strList, tagValues } from './card'
import type { HfClient } from './client'
import { humanBytes, humanCount, icon, Page, pageTitle, shortName } from './graph'
import { hfUrl } from './parse'

export interface DatasetMeta {
	id: string
	tags?: string[]
	cardData?: unknown
	gated?: false | 'auto' | 'manual' | boolean
	downloads?: number
	likes?: number
	description?: string
	siblings?: { rfilename: string }[]
	usedStorage?: number
}

export interface FeatureSpec {
	name: string
	type: string
}

export interface SplitSpec {
	name: string
	rows?: number
	bytes?: number
}

export interface DatasetConfig {
	name: string
	splits: SplitSpec[]
	features: FeatureSpec[]
	bytes?: number
	downloadBytes?: number
}

export interface DatasetFacts {
	meta: DatasetMeta
	configs: DatasetConfig[]
	/** Where the config info came from. */
	from: 'datasets-server' | 'card' | 'files' | 'none'
	trainedModels: { id: string; downloads?: number }[]
	warnings: string[]
}

/** datasets-server feature JSON or card `dtype` → short type text. */
export function featureType(v: unknown): string {
	if (typeof v === 'string') return v
	if (Array.isArray(v)) return `list<${featureType(v[0])}>`
	if (!isObj(v)) return '?'
	if (isObj(v.class_label)) {
		const names = Object.values(asObj(asObj(v.class_label).names)).map(String)
		return `ClassLabel(${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''})`
	}
	const t = asStr(v._type)
	if (t === 'Value') return asStr(v.dtype) ?? 'value'
	if (t === 'ClassLabel') {
		const names = asArr(v.names).map(String)
		return `ClassLabel(${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''})`
	}
	if (t === 'Sequence' || t === 'List' || t === 'LargeList') return `list<${featureType(v.feature)}>`
	if (t) return t
	if (v.dtype !== undefined) return featureType(v.dtype)
	if (v.list !== undefined) return `list<${featureType(v.list)}>`
	if (v.sequence !== undefined) return `list<${featureType(v.sequence)}>`
	if (v.struct !== undefined) return 'struct'
	return 'struct'
}

/** datasets-server `/info` → configs. */
export function configsFromInfo(info: unknown): DatasetConfig[] {
	const di = asObj(asObj(info).dataset_info)
	return Object.entries(di).map(([name, raw]) => {
		const c = asObj(raw)
		const features = Object.entries(asObj(c.features)).map(([fname, fv]) => ({ name: fname, type: featureType(fv) }))
		const splits = Object.values(asObj(c.splits)).map((s) => {
			const so = asObj(s)
			return { name: asStr(so.name) ?? '?', rows: typeof so.num_examples === 'number' ? so.num_examples : undefined, bytes: typeof so.num_bytes === 'number' ? so.num_bytes : undefined }
		})
		return { name, splits, features, bytes: typeof c.dataset_size === 'number' ? c.dataset_size : undefined, downloadBytes: typeof c.download_size === 'number' ? c.download_size : undefined }
	})
}

/** Card `dataset_info` (object or list) + `configs` → configs. */
export function configsFromCard(card: Obj): DatasetConfig[] {
	const infos = Array.isArray(card.dataset_info) ? card.dataset_info : isObj(card.dataset_info) ? [card.dataset_info] : []
	const out: DatasetConfig[] = infos.map((raw) => {
		const c = asObj(raw)
		return {
			name: asStr(c.config_name) ?? 'default',
			features: asArr(c.features).map((f) => ({ name: asStr(asObj(f).name) ?? '?', type: featureType(asObj(f).dtype ?? asObj(f)) })),
			splits: asArr(c.splits).map((s) => ({ name: asStr(asObj(s).name) ?? '?', rows: typeof asObj(s).num_examples === 'number' ? (asObj(s).num_examples as number) : undefined, bytes: typeof asObj(s).num_bytes === 'number' ? (asObj(s).num_bytes as number) : undefined })),
			bytes: typeof c.dataset_size === 'number' ? c.dataset_size : undefined,
			downloadBytes: typeof c.download_size === 'number' ? c.download_size : undefined,
		}
	})
	for (const cfg of asArr(card.configs)) {
		const co = asObj(cfg)
		const name = asStr(co.config_name) ?? 'default'
		if (out.some((c) => c.name === name)) continue
		const splits = asArr(co.data_files).map((d) => ({ name: asStr(asObj(d).split) ?? 'train' }))
		out.push({ name, splits, features: [] })
	}
	return out
}

export async function collectDataset(hf: HfClient, id: string, rev: string | undefined, maxTrained: number): Promise<DatasetFacts> {
	const meta = await hf.repo<DatasetMeta>('dataset', id, rev)
	const warnings: string[] = []
	let configs: DatasetConfig[] = []
	let from: DatasetFacts['from'] = 'none'
	const info = await hf.datasetsServer<Obj>(`/info?dataset=${encodeURIComponent(id)}`)
	if (info) {
		configs = configsFromInfo(info)
		if (configs.length) from = 'datasets-server'
		if (asArr(info.failed).length) warnings.push(`datasets-server could not process ${asArr(info.failed).length} config(s)`)
	}
	if (!configs.length) {
		configs = configsFromCard(cardOf(meta))
		if (configs.length) from = 'card'
	}
	if (!configs.length) {
		// last resort: the split list from datasets-server
		const splits = await hf.datasetsServer<Obj>(`/splits?dataset=${encodeURIComponent(id)}`)
		const by = new Map<string, SplitSpec[]>()
		for (const s of asArr(splits?.splits)) {
			const so = asObj(s)
			const c = asStr(so.config) ?? 'default'
			if (!by.has(c)) by.set(c, [])
			by.get(c)!.push({ name: asStr(so.split) ?? '?' })
		}
		configs = [...by].map(([name, sp]) => ({ name, splits: sp, features: [] }))
		if (configs.length) from = 'files'
	}
	if (!configs.length) warnings.push(meta.gated ? `${id} is gated: configs and features need HF_TOKEN for an account with access` : 'no config / split information (the datasets-server has not processed this dataset)')
	let trainedModels: DatasetFacts['trainedModels'] = []
	if (maxTrained > 0) {
		const list = await hf.tryApi<{ id: string; downloads?: number }[]>(`/api/models?filter=${encodeURIComponent(`dataset:${id}`)}&sort=downloads&direction=-1&limit=${maxTrained}`)
		trainedModels = (list ?? []).slice(0, maxTrained).map((m) => ({ id: m.id, downloads: m.downloads }))
	}
	return { meta, configs, from, trainedModels, warnings }
}

/** Modalities from `modality:` tags, or guessed from feature types. */
function modalities(f: DatasetFacts): string[] {
	const tags = tagValues(f.meta.tags ?? [], 'modality')
	if (tags.length) return tags
	const types = f.configs.flatMap((c) => c.features.map((x) => x.type.toLowerCase()))
	const out = new Set<string>()
	for (const t of types) {
		if (t.includes('image')) out.add('image')
		else if (t.includes('audio')) out.add('audio')
		else if (t.includes('video')) out.add('video')
		else if (t === 'string' || t.includes('string')) out.add('text')
	}
	return [...out]
}

const MOD_ICON: Record<string, string[]> = { text: ['file-text', 'document'], image: ['image', 'eye'], audio: ['mic', 'audio-lines'], video: ['video'], tabular: ['table'], timeseries: ['metrics'], geospatial: ['globe'], '3d': ['box'] }

export interface DatasetRender {
	root: Page
	pages: Page[]
	header: string[]
	notes: string[]
	confidence: number
}

const MAX_CONFIGS = 12

/** Page for one config: splits and features. */
export function configPage(c: DatasetConfig, srcBase: string, name: string): Page {
	const p = new Page(name, 'right')
	const src = (x: string) => `${srcBase}#config/${c.name}/${x}`
	const g = p.group('Splits', { label: `Splits of ${c.name}`, src: src('splits') })
	for (const s of c.splits) p.node(`split ${s.name}`, { label: `${s.name}${s.rows !== undefined ? ` · ${s.rows.toLocaleString('en-US')} rows` : ''}${s.bytes ? ` · ${humanBytes(s.bytes)}` : ''}`, shape: 'cylinder', parent: g, src: src(`split/${s.name}`) })
	if (c.features.length) {
		const fg = p.group('Features', { label: `Features (${c.features.length} columns)`, src: src('features') })
		for (const f of c.features.slice(0, 30)) p.node(`feature ${f.name}`, { label: `${f.name}: ${f.type}`, parent: fg, src: src(`feature/${f.name}`) })
		if (c.features.length > 30) p.node('More features', { label: `+ ${c.features.length - 30} more columns`, parent: fg, src: src('features') })
		p.edge(g, fg, 'rows have', { dotted: true })
	}
	return p
}

export function renderDataset(f: DatasetFacts, srcBase: string, endpoint = 'https://huggingface.co'): DatasetRender {
	const m = f.meta
	const card = cardOf(m)
	const tags = m.tags ?? []
	const root = new Page('', 'right')
	const pages: Page[] = []
	const total = f.configs.reduce((s, c) => s + (c.bytes ?? 0), 0)
	const rows = f.configs.reduce((s, c) => s + c.splits.reduce((t, x) => t + (x.rows ?? 0), 0), 0)
	const size = tagValues(tags, 'size_categories')[0] ?? strList(card.size_categories)[0]
	const mods = modalities(f)
	const ds = root.node(m.id, {
		label: `${asStr(card.pretty_name) ?? shortName(m.id)}${rows ? ` · ${humanCount(rows)} rows` : size ? ` · ${size} rows` : ''}${total ? ` · ${humanBytes(total)}` : ''}${m.gated ? ' · gated' : ''}`,
		icon: 'huggingface',
		color: 'green',
		shape: 'cylinder',
		link: hfUrl('dataset', m.id, endpoint),
		src: srcBase,
	})
	for (const mod of mods) {
		const k = root.node(`Modality ${mod}`, { label: `Modality: ${mod}`, shape: 'oval', icon: icon(...(MOD_ICON[mod] ?? []), 'document') ?? undefined, src: `${srcBase}#modality/${mod}` })
		root.edge(ds, k, undefined, { dotted: true, plain: true })
	}
	const tasks = [...new Set([...strList(card.task_categories), ...tagValues(tags, 'task_categories')])]
	if (tasks.length) {
		root.node('Tasks', { label: `Tasks: ${tasks.slice(0, 4).join(', ')}`, icon: 'tag', src: `${srcBase}#tasks` })
		root.edge(ds, 'Tasks', 'for')
	}
	const license = licenseOf(card, tags)
	if (license) {
		root.node('License', { label: `License: ${license}`, icon: 'lock', shape: 'document', src: `${srcBase}#license` })
		root.edge(ds, 'License', undefined, { dotted: true, plain: true })
	}
	const langs = strList(card.language)
	if (langs.length) root.node('Languages', { label: `Languages: ${langs.slice(0, 8).join(', ')}${langs.length > 8 ? ` +${langs.length - 8}` : ''}`, icon: 'globe', src: `${srcBase}#languages` })
	if (langs.length) root.edge(ds, 'Languages', undefined, { dotted: true, plain: true })

	// configs: one node each on the root, a page each (one level)
	const shown = f.configs.slice(0, MAX_CONFIGS)
	if (shown.length) {
		const g = root.group('Configs', { label: `Configs (${f.configs.length})`, src: `${srcBase}#configs` })
		for (const c of shown) {
			const rowsC = c.splits.reduce((t, x) => t + (x.rows ?? 0), 0)
			const pageName = pageTitle(`Config ${c.name}`)
			root.node(pageName, { label: `${c.name} · ${c.splits.map((s) => s.name).join(' / ')}${rowsC ? ` · ${humanCount(rowsC)} rows` : ''}`, parent: g, drill: pageName, src: `${srcBase}#config/${c.name}` })
			pages.push(configPage(c, srcBase, pageName))
		}
		if (f.configs.length > MAX_CONFIGS) root.node('More configs', { label: `+ ${f.configs.length - MAX_CONFIGS} more configs`, parent: g, src: `${srcBase}#configs` })
		root.edge(ds, g, 'configs')
	}
	if (f.trainedModels.length) {
		const g = root.group('Trained models', { label: 'Models trained on it (top by downloads)', src: `${srcBase}#models` })
		for (const tm of f.trainedModels) root.node(`model ${tm.id}`, { label: `${tm.id}${tm.downloads ? ` · ${humanCount(tm.downloads)} downloads` : ''}`, icon: 'huggingface', parent: g, link: hfUrl('model', tm.id, endpoint), src: `hf:${tm.id}` })
		root.edge(ds, g, 'trains')
	}
	const header = [`source: ${hfUrl('dataset', m.id, endpoint)}`, `configs from: ${f.from}`, ...(m.downloads !== undefined ? [`downloads (30d): ${m.downloads.toLocaleString('en-US')} · likes: ${m.likes ?? 0}`] : [])]
	const notes = [`${f.configs.length} config(s), ${f.configs.reduce((s, c) => s + c.splits.length, 0)} split(s)`, ...(mods.length ? [`modality: ${mods.join(', ')}`] : []), ...(size ? [`size category: ${size}`] : [])]
	return { root, pages, header, notes, confidence: f.from === 'datasets-server' ? 0.95 : f.from === 'card' ? 0.8 : f.from === 'files' ? 0.6 : 0.4 }
}
