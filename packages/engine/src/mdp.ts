import { emptyIR, type Cardinality, type DiagramIR, type DiagramLayout, type IREdge, type IRNode, type NodeShape } from '@octo-draw/core'
import { octoIconName, parseOctoIconName } from './icons'

/**
 * octo DiagramIR <-> MDP (Model Diagramming Protocol, Eraser stock profile 0.3.0).
 *
 * Mapping:
 * - leaf node with `icon` and no `shape` -> `Icon` (icon-only, label under the glyph)
 * - other leaf nodes -> `Shape` (`shape`, `icon`, `texts[0]` = label, `color`)
 * - containers -> `Group` (`title.text`, `title.icon`, `color`), children carry `containerId`
 * - ERD entities -> `DatabaseTable`, ERD edges -> `DatabaseRelationship`
 * - edges -> `Relationship` (`label`, `lineStyle`, `startArrowhead` / `endArrowhead`, `color`)
 * - geometry from the layout (x/y/width/height; MDP coordinates must be >= 0, so the layout is
 *   shifted when its bounds go negative)
 *
 * Everything MDP has no slot for goes in a sidecar, `doc.octo` (see `OctoSidecar`). Stock tag
 * schemas are `additionalProperties: false`, so per-element extras cannot live on the element; a
 * top-level unknown key only draws a `W_UNKNOWN_KEY` warning, but `validateMdp` strips it anyway.
 */

export type MdpElement = Record<string, unknown> & { tag: string; id: string }
export interface MdpDoc {
	entities: MdpElement[]
	connections: MdpElement[]
	/** octo-only data, keyed by element id. Not part of MDP; stripped before validation. */
	octo?: OctoSidecar
}

/** Per-element data MDP cannot hold. */
export interface OctoElementExtra {
	/** the IR key when it differs from the MDP id (never, today: ids are keys) */
	key?: string
	link?: string
	ext?: Record<string, string>
	/** octo shapes with no stock equivalent (`cloud`) */
	shape?: NodeShape
	/** octo palette names the stock palette lacks (`lightblue`, `gray`, ...) and `brand` */
	color?: string
	pinned?: boolean
}

export interface OctoSidecar {
	version: 1
	kind: DiagramIR['kind']
	direction: DiagramIR['direction']
	style: DiagramIR['style']
	title?: string
	sequence?: DiagramIR['sequence']
	erd?: DiagramIR['erd']
	/** dx/dy added to layout coordinates to make them non-negative */
	offset?: { x: number; y: number }
	elements?: Record<string, OctoElementExtra>
	/** IR order of nodes/edges, so a round trip keeps declaration order */
	order?: { nodes: string[]; edges: string[] }
}

/** Shapes the stock `Shape` tag accepts. octo's `cloud` has no equivalent. */
const STOCK_SHAPES = new Set(['rectangle', 'parallelogram', 'trapezoid', 'diamond', 'cylinder', 'hexagon', 'circle', 'ellipse', 'oval', 'triangle', 'document', 'star'])
/** Stock palette tokens (`x-palette` props accept these or any strict CSS color). */
const STOCK_PALETTE = new Set(['white', 'yellow', 'green', 'blue', 'purple', 'red', 'orange', 'black'])
const CSS_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Glyph square for `Icon` entities (the corpus uses 50). */
export const ICON_ENTITY_SIZE = 44

const CARD_TO_REL:Record<Cardinality, string> = { '1-1': 'one-to-one', '1-n': 'one-to-many', 'n-1': 'many-to-one', 'n-n': 'many-to-many' }
const REL_TO_CARD: Record<string, Cardinality> = Object.fromEntries(Object.entries(CARD_TO_REL).map(([k, v]) => [v, k as Cardinality]))

/** Labels are plain text in octo; MDP text props are markdown. Escape markdown punctuation. */
export function escapeMarkdown(s: string): string {
	return s
		.replace(/([\\`*_[\]<>~|])/g, '\\$1')
		.replace(/^(\s*)([#>+-])/gm, '$1\\$2')
		.replace(/^(\s*\d+)\./gm, '$1\\.')
}
export function unescapeMarkdown(s: string): string {
	return s.replace(/\\([\\`*_[\]<>~|#+\-.])/g, '$1')
}

/** Splits an octo color into the MDP prop (or nothing) and the sidecar value (or nothing). */
function mapColor(color: string | undefined): { mdp?: string; extra?: string } {
	if (!color) return {}
	const c = color.toLowerCase()
	if (STOCK_PALETTE.has(c) || CSS_HEX.test(c)) return { mdp: c }
	return { extra: color }
}

function nodeExtra(n: IRNode, ir: DiagramIR, colorExtra?: string, shapeExtra?: NodeShape): OctoElementExtra | null {
	const x: OctoElementExtra = {}
	if (n.link) x.link = n.link
	if (n.ext && Object.keys(n.ext).length) x.ext = { ...n.ext }
	if (colorExtra) x.color = colorExtra
	if (shapeExtra) x.shape = shapeExtra
	if (n.geometry?.pinned) x.pinned = true
	void ir
	return Object.keys(x).length ? x : null
}

export interface IrToMdpOptions {
	/** Keep the layout's edge polylines as authored `points` (render adopts orthogonal ones). Default false. */
	includeRoutes?: boolean
}

export function irToMdp(ir: DiagramIR, layout: DiagramLayout, opts: IrToMdpOptions = {}): MdpDoc {
	const dx = Math.max(0, -Math.floor(layout.bounds.x))
	const dy = Math.max(0, -Math.floor(layout.bounds.y))
	const keys = new Set(ir.nodes.map((n) => n.key))
	const parents = new Set(ir.nodes.filter((n) => n.parent && keys.has(n.parent)).map((n) => n.parent!))
	const extras: Record<string, OctoElementExtra> = {}
	const typeface = ir.style.typeface
	const styleMode = ir.style.styleMode
	const entities: MdpElement[] = []
	const geom = (key: string) => {
		const b = layout.nodes[key]
		if (!b) return {}
		return { x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: Math.round(b.w), height: Math.round(b.h) }
	}

	// containers before members keeps paint order sensible for consumers that ignore z-index
	const depth = (n: IRNode) => {
		let d = 0
		let p = n.parent
		while (p && keys.has(p) && d < 64) {
			d++
			p = ir.nodes.find((m) => m.key === p)?.parent
		}
		return d
	}
	const ordered = [...ir.nodes].sort((a, b) => depth(a) - depth(b))

	for (const n of ordered) {
		const label = n.label ?? n.key
		const container = !!n.isContainer || parents.has(n.key)
		const color = mapColor(n.style?.color)
		const brand = n.style?.color === 'brand'
		const base: MdpElement = { tag: 'Shape', id: n.key, ...geom(n.key) }
		if (n.parent && keys.has(n.parent)) base.containerId = n.parent
		let shapeExtra: NodeShape | undefined
		if (ir.kind === 'erd' && !container) {
			base.tag = 'DatabaseTable'
			base.label = label
			if (n.icon) base.icon = octoIconName(n.icon, brand)
			if (n.fields?.length) base.fields = n.fields.map((f) => ({ name: f.name, ...(f.type ? { type: f.type } : {}), ...(f.meta?.length ? { meta: f.meta.join(' ') } : {}) }))
			if (color.mdp) base.color = color.mdp
			// DatabaseTable sizes itself from its rows; our ERD row geometry is not authored
			delete base.height
		} else if (container) {
			base.tag = 'Group'
			base.title = { text: escapeMarkdown(label), ...(n.icon ? { icon: octoIconName(n.icon, brand) } : {}), ...(typeface ? { typeface } : {}) }
			if (color.mdp) base.color = color.mdp
			if (styleMode) base.styleMode = styleMode
		} else if (n.icon && !n.shape) {
			base.tag = 'Icon'
			base.icon = octoIconName(n.icon, brand)
			// An Icon's width/height is the glyph square (its label hangs below as external text).
			// octo's layout box is a label-wide rectangle: centre a fixed glyph in it instead.
			const b = layout.nodes[n.key]
			if (b) {
				const s = Math.min(ICON_ENTITY_SIZE, Math.round(b.w), Math.round(b.h))
				Object.assign(base, { x: Math.round(b.x + dx + (b.w - s) / 2), y: Math.round(b.y + dy + Math.max(0, (b.h - s - 18) / 2)), width: s, height: s })
			}
			base.texts = [{ text: escapeMarkdown(label), ...(typeface ? { typeface } : {}) }]
			// Icon.color is x-css-color (no palette tokens): resolve tokens ourselves
			if (color.mdp) base.color = color.mdp
		} else {
			base.tag = 'Shape'
			if (n.shape) {
				if (STOCK_SHAPES.has(n.shape)) base.shape = n.shape
				else shapeExtra = n.shape
			}
			if (n.icon) base.icon = octoIconName(n.icon, brand)
			base.texts = [{ text: escapeMarkdown(label), ...(typeface ? { typeface } : {}) }]
			if (color.mdp) base.color = color.mdp
			if (styleMode) base.styleMode = styleMode
			if (n.style?.dash && n.style.dash !== 'solid') base.borderStyle = n.style.dash
		}
		const extra = nodeExtra(n, ir, color.extra, shapeExtra)
		if (extra) extras[n.key] = extra
		entities.push(base)
	}

	const connections: MdpElement[] = []
	if (ir.kind !== 'sequence') {
		for (const e of ir.edges) {
			if (!keys.has(e.from) || !keys.has(e.to)) continue
			const c: MdpElement = { tag: ir.kind === 'erd' ? 'DatabaseRelationship' : 'Relationship', id: e.key, from: e.from, to: e.to }
			if (e.label) c.label = escapeMarkdown(e.label)
			const dash = e.style?.dash && e.style.dash !== 'solid' ? e.style.dash : e.line.dash === 'dotted' ? 'dotted' : undefined
			if (dash) c.lineStyle = dash
			if (c.tag === 'Relationship') {
				if (e.arrow.start === 'arrow') c.startArrowhead = 'triangle'
				if (e.arrow.end === 'none') c.endArrowhead = null
			} else {
				if (e.fromField) c.fromField = e.fromField
				if (e.toField) c.toField = e.toField
				if (e.cardinality) c.relType = CARD_TO_REL[e.cardinality]
			}
			const color = mapColor(e.style?.color)
			if (color.mdp) c.color = color.mdp
			if (color.extra) extras[e.key] = { ...extras[e.key], color: color.extra }
			const route = layout.edges[e.key]
			if (opts.includeRoutes && route && route.points.length >= 2) {
				const o = route.points[0]
				c.x = Math.round(o.x + dx)
				c.y = Math.round(o.y + dy)
				c.points = route.points.map((p) => ({ x: Math.round(p.x - o.x), y: Math.round(p.y - o.y) }))
			}
			connections.push(c)
		}
	}

	const octo: OctoSidecar = {
		version: 1,
		kind: ir.kind,
		direction: ir.direction,
		style: { ...ir.style },
		order: { nodes: ir.nodes.map((n) => n.key), edges: ir.edges.map((e) => e.key) },
	}
	if (ir.title) octo.title = ir.title
	if (ir.sequence) octo.sequence = ir.sequence
	if (ir.erd) octo.erd = ir.erd
	if (dx || dy) octo.offset = { x: dx, y: dy }
	if (Object.keys(extras).length) octo.elements = extras
	return { entities, connections, octo }
}

/** The doc's own entity geometry as an octo `DiagramLayout` (what routing should run against). */
export function layoutFromMdp(doc: MdpDoc): DiagramLayout {
	const containers = new Set(doc.entities.map((e) => e.containerId).filter((c): c is string => typeof c === 'string'))
	const nodes: DiagramLayout['nodes'] = {}
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	for (const e of doc.entities) {
		const x = Number(e.x ?? 0)
		const y = Number(e.y ?? 0)
		const w = Number(e.width ?? 120)
		const h = Number(e.height ?? 60)
		nodes[e.id] = { key: e.id, x, y, w, h, isContainer: e.tag === 'Group' || containers.has(e.id), depth: 0 }
		minX = Math.min(minX, x)
		minY = Math.min(minY, y)
		maxX = Math.max(maxX, x + w)
		maxY = Math.max(maxY, y + h)
	}
	return { nodes, edges: {}, bounds: Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 } }
}

/** Write polylines (absolute coordinates, keyed by connection id) into the doc as authored `points`. */
export function withRoutes(doc: MdpDoc, routes: Record<string, { points: { x: number; y: number }[] }>): MdpDoc {
	return {
		...doc,
		connections: doc.connections.map((c) => {
			const r = routes[c.id]
			if (!r || r.points.length < 2) return c
			const o = r.points[0]
			return { ...c, x: Math.max(0, Math.round(o.x)), y: Math.max(0, Math.round(o.y)), points: r.points.map((p) => ({ x: Math.round(p.x) - Math.max(0, Math.round(o.x)), y: Math.round(p.y) - Math.max(0, Math.round(o.y)) })) }
		}),
	}
}

/** A text run's plain text (stock `texts[]` entries are `{ text }` objects). */
function firstText(el: Record<string, unknown>): string | undefined {
	const texts = el.texts as { text?: string }[] | undefined
	if (Array.isArray(texts) && texts.length) return texts.map((t) => (typeof t?.text === 'string' ? t.text : '')).join('\n')
	if (typeof el.text === 'string') return el.text
	if (typeof el.label === 'string') return el.label
	const title = el.title as { text?: string } | undefined
	if (title && typeof title.text === 'string') return title.text
	return undefined
}

const SHAPE_FROM_MDP: Record<string, NodeShape> = { circle: 'ellipse' }

/** MDP doc (stock profile) -> octo IR. Tags with no octo equivalent become plain nodes with `ext.mdpTag`. */
export function mdpToIr(doc: MdpDoc | { elements: MdpElement[] }): DiagramIR {
	let entities: MdpElement[]
	let connections: MdpElement[]
	if ('elements' in doc && Array.isArray(doc.elements)) {
		connections = doc.elements.filter((e) => typeof e.from === 'string' && typeof e.to === 'string')
		entities = doc.elements.filter((e) => !connections.includes(e))
	} else {
		entities = (doc as MdpDoc).entities
		connections = (doc as MdpDoc).connections
	}
	const octo = (doc as MdpDoc).octo
	const extras = octo?.elements ?? {}
	const kind = octo?.kind ?? (entities.some((e) => e.tag === 'DatabaseTable') ? 'erd' : 'flowchart')
	const ir = emptyIR(kind)
	if (octo) {
		ir.direction = octo.direction
		ir.style = { ...octo.style }
		if (octo.title) ir.title = octo.title
		if (octo.sequence) ir.sequence = octo.sequence
		if (octo.erd) ir.erd = octo.erd
	}
	const dx = octo?.offset?.x ?? 0
	const dy = octo?.offset?.y ?? 0
	const containerIds = new Set(entities.map((e) => e.containerId).filter((c): c is string => typeof c === 'string'))

	for (const el of entities) {
		const x = extras[el.id] ?? {}
		const node: IRNode = { key: x.key ?? el.id }
		const text = firstText(el)
		const plain = text === undefined ? undefined : el.tag === 'DatabaseTable' ? text : unescapeMarkdown(text)
		if (plain !== undefined && plain !== node.key) node.label = plain
		const iconName = (el.tag === 'Group' ? (el.title as { icon?: string } | undefined)?.icon : el.icon) as string | undefined
		let brand = false
		if (typeof iconName === 'string') {
			const p = parseOctoIconName(iconName)
			node.icon = p.icon
			brand = p.brand
		}
		if (typeof el.containerId === 'string') node.parent = el.containerId
		if (el.tag === 'Group' || el.tag === 'Lane' || el.tag === 'Pool' || el.isContainer === true || containerIds.has(el.id)) node.isContainer = true
		if (el.tag === 'Shape') {
			const s = typeof el.shape === 'string' ? el.shape : undefined
			// a Shape that carries an icon stays a box (octo would draw icon + no shape as Icon)
			node.shape = x.shape ?? (s ? (SHAPE_FROM_MDP[s] ?? (s as NodeShape)) : node.icon ? 'rectangle' : undefined)
			if (s && SHAPE_FROM_MDP[s]) node.ext = { ...node.ext, mdpShape: s }
			if (el.borderStyle === 'dashed' || el.borderStyle === 'dotted') node.style = { ...node.style, dash: el.borderStyle }
		} else if (x.shape) node.shape = x.shape
		const color = x.color ?? (brand ? 'brand' : typeof el.color === 'string' ? el.color : typeof el.bgColor === 'string' ? el.bgColor : undefined)
		if (color) node.style = { ...node.style, color }
		if (el.tag === 'DatabaseTable' && Array.isArray(el.fields)) {
			node.fields = (el.fields as { name: string; type?: string; meta?: string }[]).map((f) => ({
				name: f.name,
				...(f.type ? { type: f.type } : {}),
				...(f.meta ? { meta: f.meta.split(/[\s,]+/).filter(Boolean).map((m) => m.toLowerCase()) } : {}),
			}))
		}
		if (!['Shape', 'Icon', 'Group', 'DatabaseTable'].includes(el.tag)) node.ext = { ...node.ext, mdpTag: el.tag }
		if (x.link) node.link = x.link
		if (x.ext) node.ext = { ...node.ext, ...x.ext }
		if (typeof el.x === 'number' && typeof el.y === 'number') {
			node.geometry = { x: el.x - dx, y: el.y - dy }
			if (typeof el.width === 'number') node.geometry.w = el.width
			if (typeof el.height === 'number') node.geometry.h = el.height
			if (x.pinned) node.geometry.pinned = true
		}
		ir.nodes.push(node)
	}

	const ordinal = new Map<string, number>()
	for (const c of connections) {
		const from = String(c.from)
		const to = String(c.to)
		const pair = `${from}->${to}`
		const n = ordinal.get(pair) ?? 0
		ordinal.set(pair, n + 1)
		const x = extras[c.id] ?? {}
		const lineStyle = c.lineStyle as string | undefined
		const edge: IREdge = {
			key: typeof c.id === 'string' && c.id ? c.id : `${pair}#${n}`,
			from,
			to,
			arrow: {
				start: c.startArrowhead ? 'arrow' : 'none',
				// stock default endArrowhead is 'triangle'; DatabaseRelationship draws none by default
				end: c.endArrowhead === null || (c.tag === 'DatabaseRelationship' && !c.endArrowhead) ? 'none' : 'arrow',
			},
			line: { dash: lineStyle === 'dotted' || lineStyle === 'dashed' ? 'dotted' : 'solid' },
		}
		if (lineStyle === 'dashed') edge.style = { dash: 'dashed' }
		if (typeof c.label === 'string') edge.label = unescapeMarkdown(c.label)
		const color = x.color ?? (typeof c.color === 'string' ? c.color : undefined)
		if (color) edge.style = { ...edge.style, color }
		if (typeof c.fromField === 'string') edge.fromField = c.fromField
		if (typeof c.toField === 'string') edge.toField = c.toField
		if (typeof c.relType === 'string' && REL_TO_CARD[c.relType]) edge.cardinality = REL_TO_CARD[c.relType]
		ir.edges.push(edge)
	}

	if (octo?.order) {
		const ni = new Map(octo.order.nodes.map((k, i) => [k, i]))
		const ei = new Map(octo.order.edges.map((k, i) => [k, i]))
		ir.nodes.sort((a, b) => (ni.get(a.key) ?? 1e9) - (ni.get(b.key) ?? 1e9))
		ir.edges.sort((a, b) => (ei.get(a.key) ?? 1e9) - (ei.get(b.key) ?? 1e9))
	}
	return ir
}
