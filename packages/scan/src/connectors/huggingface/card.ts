/** Model / dataset / space card metadata: YAML front matter and the Hub's tag conventions. */

import { asArr, asObj, asStr, isObj, parseYaml, uniq, type Obj } from '../../util'

/** YAML front matter of a README (`---\n...\n---`), or `{}`. */
export function parseFrontMatter(readme: string): Obj {
	const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(readme)
	if (!m) return {}
	const v = parseYaml(m[1])
	return isObj(v) ? v : {}
}

/** A string or list field as a list of non-empty strings. */
export function strList(v: unknown): string[] {
	if (typeof v === 'string') return v.trim() ? [v.trim()] : []
	return asArr(v).map(asStr).filter((s): s is string => !!s && !!s.trim()).map((s) => s.trim())
}

export type BaseRelation = 'finetune' | 'adapter' | 'quantized' | 'merge' | 'base'

export interface BaseModel {
	id: string
	relation: BaseRelation
}

/**
 * Base models from `cardData.base_model` and `base_model:<relation>:<id>` tags
 * (the Hub adds the tags; `base_model_relation` in the card overrides).
 */
export function baseModels(card: Obj, tags: string[]): BaseModel[] {
	const rel = new Map<string, BaseRelation>()
	for (const t of tags) {
		const m = /^base_model:(finetune|adapter|quantized|merge):(.+)$/.exec(t)
		if (m) rel.set(m[2].toLowerCase(), m[1] as BaseRelation)
	}
	// Hub-resolved relation tags are canonical (they follow repo renames); the card is the fallback
	const ids = rel.size ? [...new Set(tags.map((t) => /^base_model:(?:finetune|adapter|quantized|merge):(.+)$/.exec(t)?.[1]).filter((x): x is string => !!x))] : strList(card.base_model)
	if (!rel.size) {
		for (const t of tags) {
			const m = /^base_model:(.+)$/.exec(t)
			if (m && !ids.some((i) => i.toLowerCase() === m[1].toLowerCase())) ids.push(m[1])
		}
	}
	const forced = asStr(card.base_model_relation) as BaseRelation | undefined
	const out: BaseModel[] = []
	for (const id of uniq(ids)) {
		if (!/^[\w.-]+(\/[\w.-]+)?$/.test(id)) continue
		const relation = forced && ['finetune', 'adapter', 'quantized', 'merge'].includes(forced) ? forced : (rel.get(id.toLowerCase()) ?? (ids.length > 1 ? 'merge' : 'base'))
		out.push({ id, relation })
	}
	return out
}

/** Dataset ids from `cardData.datasets` and `dataset:<id>` tags. */
export function datasetsOf(card: Obj, tags: string[]): string[] {
	const out = strList(card.datasets)
	for (const t of tags) if (t.startsWith('dataset:')) out.push(t.slice(8))
	const seen = new Set<string>()
	return out.filter((d) => {
		const k = d.toLowerCase()
		if (seen.has(k)) return false
		seen.add(k)
		return true
	})
}

/** `license` from the card or a `license:<id>` tag. */
export function licenseOf(card: Obj, tags: string[]): string | undefined {
	const l = strList(card.license)[0] ?? tags.find((t) => t.startsWith('license:'))?.slice(8)
	if (!l) return undefined
	if (l === 'other') return asStr(card.license_name) ?? 'other'
	return l
}

/** `tag:value` tags of a prefix (`modality:text` → `text`). */
export function tagValues(tags: string[], prefix: string): string[] {
	return tags.filter((t) => t.startsWith(prefix + ':')).map((t) => t.slice(prefix.length + 1))
}

export function cardOf(meta: { cardData?: unknown }): Obj {
	return asObj(meta.cardData)
}
