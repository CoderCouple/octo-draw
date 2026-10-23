/**
 * Tiny page builder for the Hugging Face connector: nodes and edges per page,
 * turned into DiagramIR and printed with core's formatter (so quoting is
 * always right), then assembled into one octo document with `page` sections.
 */

import { parseOcto, resolveIcon, type DiagramIR, type Direction, type IREdge, type IRNode, type NodeShape } from '@octo-draw/core'
import { emitOcto } from '../../emit'
import { cleanKey } from '../../util'

export interface HfNode {
	key: string
	label?: string
	icon?: string
	shape?: NodeShape
	color?: string
	link?: string
	parent?: string
	group?: boolean
	drill?: string
	/** Scanned origin (`hf:org/model#decoder.attn`) so the node can be expanded on demand. */
	src?: string
}

export interface HfEdge {
	from: string
	to: string
	label?: string
	dotted?: boolean
	plain?: boolean
}

export class Page {
	nodes: HfNode[] = []
	edges: HfEdge[] = []
	private keys = new Map<string, HfNode>()

	constructor(
		public name: string,
		public direction: Direction = 'right',
	) {}

	/** Adds a node (or merges props into an existing one with the same key). Returns the key. */
	node(key: string, props: Omit<HfNode, 'key'> = {}): string {
		const k = cleanKey(key) || 'node'
		const hit = this.keys.get(k.toLowerCase())
		if (hit) {
			for (const [p, v] of Object.entries(props)) if (v !== undefined && (hit as unknown as Record<string, unknown>)[p] === undefined) (hit as unknown as Record<string, unknown>)[p] = v
			return hit.key
		}
		const n: HfNode = { key: k, ...props }
		if (n.label !== undefined && cleanLabel(n.label) === k) delete n.label
		if (n.label !== undefined) n.label = cleanLabel(n.label)
		if (n.icon) n.icon = icon(n.icon) ?? undefined
		this.nodes.push(n)
		this.keys.set(k.toLowerCase(), n)
		return k
	}

	group(key: string, props: Omit<HfNode, 'key' | 'group'> = {}): string {
		return this.node(key, { ...props, group: true })
	}

	has(key: string): boolean {
		return this.keys.has(cleanKey(key).toLowerCase())
	}

	/** Unused key based on `want` (`Model`, `Model 2`, ...). */
	fresh(want: string): string {
		const base = cleanKey(want) || 'node'
		let k = base
		for (let n = 2; this.has(k); n++) k = `${base} ${n}`
		return k
	}

	edge(from: string, to: string, label?: string, opts: { dotted?: boolean; plain?: boolean } = {}) {
		if (from === to) return
		if (this.edges.some((e) => e.from === from && e.to === to && e.label === label)) return
		this.edges.push({ from, to, label, ...opts })
	}

	/** `a > b > c` chain. */
	chain(...keys: string[]) {
		for (let i = 1; i < keys.length; i++) this.edge(keys[i - 1], keys[i])
	}

	toIR(title?: string): DiagramIR {
		const known = new Set(this.nodes.map((n) => n.key))
		const nodes: IRNode[] = this.nodes.map((n) => {
			const out: IRNode = { key: n.key }
			if (n.label) out.label = n.label
			if (n.shape) out.shape = n.shape
			if (n.icon) out.icon = n.icon
			if (n.color) out.style = { color: n.color }
			if (n.link) out.link = n.link
			if (n.parent && known.has(n.parent) && n.parent !== n.key) out.parent = n.parent
			if (n.group) out.isContainer = true
			const ext: Record<string, string> = {}
			if (n.drill) ext.drill = n.drill
			if (n.src) ext.src = n.src
			if (Object.keys(ext).length) out.ext = ext
			return out
		})
		const counts = new Map<string, number>()
		const edges: IREdge[] = []
		for (const e of this.edges) {
			if (!known.has(e.from) || !known.has(e.to)) continue
			const pair = `${e.from}->${e.to}`
			const i = counts.get(pair) ?? 0
			counts.set(pair, i + 1)
			edges.push({
				key: `${pair}#${i}`,
				from: e.from,
				to: e.to,
				label: e.label ? cleanLabel(e.label) : undefined,
				arrow: { start: 'none', end: e.plain ? 'none' : 'arrow' },
				line: { dash: e.dotted ? 'dotted' : 'solid' },
			})
		}
		return { version: 1, kind: 'flowchart', direction: this.direction, style: {}, title, nodes, edges }
	}
}

let sourceSupport: boolean | undefined
/** Does core's parser know the `source <input>` directive (recursive drill-down v2)? */
export function sourceDirectiveSupported(): boolean {
	if (sourceSupport === undefined) sourceSupport = parseOcto('source hf:a/b\n').diagnostics.length === 0 && parseOcto('source hf:a/b\n').ir.nodes.length === 0
	return sourceSupport
}

/**
 * Root page plus sub-pages → one octo document. Header lines become `//`
 * comments under the title; `source` becomes the `source <input>` directive
 * (or a comment while core does not parse it yet).
 */
export function emitDocument(title: string, root: Page, pages: Page[], header: string[] = [], source?: string): string {
	const code = emitOcto({ name: '', ir: root.toIR(title) }, pages.filter((p) => p.nodes.length).map((p) => ({ name: p.name, ir: p.toIR() })), header)
	if (!source) return code
	const lines = code.split('\n')
	const at = lines[0]?.startsWith('title ') ? 1 : 0
	lines.splice(at, 0, sourceDirectiveSupported() ? `source ${source}` : `// source ${source}`)
	return lines.join('\n')
}

/** Page bodies (an expander result): first page bare, the rest as `page` sections. */
export function emitPages(pages: Page[]): string {
	const [first, ...rest] = pages
	if (!first) return ''
	return emitOcto({ name: first.name, ir: first.toIR() }, rest.filter((p) => p.nodes.length).map((p) => ({ name: p.name, ir: p.toIR() })))
}

/** Page names: no characters the `page` header or drill props would trip on. */
export const pageTitle = (s: string) => s.replace(/["[\]{},:#\n\r]/g, ' ').replace(/\/\//g, '/').replace(/\s+/g, ' ').trim() || 'page'

/** Labels are single-line; `[`/`]`/`{`/`}` would be quoted anyway but read badly. */
export function cleanLabel(s: string): string {
	return s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** First candidate that resolves in core's icon catalog (aliases and glyphs count), else null. */
export function icon(...candidates: (string | undefined | null)[]): string | null {
	for (const c of candidates) {
		if (!c) continue
		const r = resolveIcon(c)
		if (r) return c
	}
	return null
}

/** `7615616512` → `7.6B`, `494032768` → `494M`. */
export function humanCount(n: number): string {
	const abs = Math.abs(n)
	const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/0$/, '').replace(/\.0$/, ''))
	if (abs >= 1e12) return `${fmt(n / 1e12)}T`
	if (abs >= 1e9) return `${fmt(n / 1e9)}B`
	if (abs >= 1e6) return `${fmt(n / 1e6)}M`
	if (abs >= 1e3) return `${fmt(n / 1e3)}K`
	return String(n)
}

/** `152064` → `152,064`. */
export function num(n: number): string {
	return Math.round(n).toLocaleString('en-US')
}

export function humanBytes(n: number): string {
	const u = ['B', 'KB', 'MB', 'GB', 'TB']
	let i = 0
	let v = n
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024
		i++
	}
	return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`
}

/** Last path segment of a repo id (`Qwen/Qwen2.5-7B` → `Qwen2.5-7B`). */
export const shortName = (id: string) => id.slice(id.lastIndexOf('/') + 1)
