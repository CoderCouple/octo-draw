/**
 * tldraw v5 snapshot interop (for migrating Octonote canvases).
 *
 * Works on plain JSON records shaped like tldraw's `@tldraw/tlschema` v5.5
 * (store snapshot `{ store, schema }` or editor snapshot `{ document, session }`).
 * Written from the record format; no tldraw code is used at runtime.
 *
 * fromTldrawSnapshot: geo → nodes (shape mapped), frames and dashed/unfilled
 * geo boxes that contain other boxes → groups (by containment), arrows bound
 * at both ends → edges, everything else (text, draw, line, note, image, …)
 * → freehand shapes. Node positions become pins, so the imported diagram keeps
 * the canvas arrangement.
 *
 * toTldrawSnapshot: best-effort inverse. Groups become dashed geo boxes (the
 * convention Octonote's mermaid importer uses), edges become bound arrows.
 */

import type { DiagramIR, DiagramLayout, Direction, IREdge, IRNode, NodeShape, Point } from '../ir'
import { NODE_SHAPES } from '../ir'
import type { FreePoint, FreeShape } from '../free'
import { freeShapeBounds } from '../free'
import { createDocument, type OctoDocument } from '../doc'
import { parseOcto } from '../dsl/parse'
import { printOcto } from '../dsl/print'
import { estimateText, nodeSize } from '../layout/sizing'
import { PALETTE } from '../render/colors'
import { decodePoints, encodePoints } from './b64points'

export interface TldrawRecord {
	id: string
	typeName: string
	[key: string]: unknown
}

export interface TldrawStoreSnapshot {
	store: Record<string, TldrawRecord>
	schema: { schemaVersion: number; sequences: Record<string, number> }
}

/** Store snapshot, editor snapshot (`{ document, session }`), or a bare record list. */
export type TldrawSnapshot = TldrawStoreSnapshot | { document: TldrawStoreSnapshot; session?: unknown } | TldrawRecord[]

export interface FromTldrawOptions {
	/** Page to import (default: the first page by index). */
	pageId?: string
	title?: string
	id?: string
	/** Called for things that could not be converted exactly. */
	onWarning?: (message: string) => void
}

export interface ToTldrawOptions {
	/** Page name. Default 'Page 1'. */
	pageName?: string
}

/** Schema versions of tldraw 5.5.x; loadSnapshot migrates forward from these. */
export const TLDRAW_SCHEMA = {
	schemaVersion: 2,
	sequences: {
		'com.tldraw.store': 5,
		'com.tldraw.asset': 1,
		'com.tldraw.camera': 1,
		'com.tldraw.document': 2,
		'com.tldraw.instance': 26,
		'com.tldraw.instance_page_state': 5,
		'com.tldraw.page': 1,
		'com.tldraw.instance_presence': 6,
		'com.tldraw.pointer': 1,
		'com.tldraw.shape': 4,
		'com.tldraw.user': 1,
		'com.tldraw.asset.image': 6,
		'com.tldraw.asset.video': 5,
		'com.tldraw.asset.bookmark': 2,
		'com.tldraw.shape.arrow': 8,
		'com.tldraw.shape.bookmark': 2,
		'com.tldraw.shape.draw': 5,
		'com.tldraw.shape.embed': 4,
		'com.tldraw.shape.frame': 1,
		'com.tldraw.shape.geo': 12,
		'com.tldraw.shape.group': 0,
		'com.tldraw.shape.highlight': 4,
		'com.tldraw.shape.image': 5,
		'com.tldraw.shape.line': 5,
		'com.tldraw.shape.note': 13,
		'com.tldraw.shape.text': 4,
		'com.tldraw.shape.video': 4,
		'com.tldraw.binding.arrow': 1,
	},
}

// ---------------------------------------------------------------------------
// Shared helpers

type Rec = Record<string, any>
interface Box {
	x: number
	y: number
	w: number
	h: number
}

/** tldraw rich text (TipTap JSON) → plain text; paragraphs and hard breaks become newlines. */
export function richTextToPlain(rt: unknown): string {
	const walk = (n: any): string => {
		if (!n || typeof n !== 'object') return ''
		if (n.type === 'text') return typeof n.text === 'string' ? n.text : ''
		if (n.type === 'hardBreak') return '\n'
		const kids: any[] = Array.isArray(n.content) ? n.content : []
		const block = (k: any) => k && typeof k === 'object' && k.type !== 'text' && k.type !== 'hardBreak'
		if (kids.some(block)) return kids.map(walk).join('\n')
		return kids.map(walk).join('')
	}
	return walk(rt)
}

/** Plain text → tldraw rich text (one paragraph per line). */
export function plainToRichText(text: string) {
	return {
		type: 'doc',
		content: text.split('\n').map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
	}
}

function shapeText(props: Rec): string {
	if (props.richText) return richTextToPlain(props.richText)
	if (typeof props.text === 'string') return props.text
	return ''
}

const GEO_TO_SHAPE: Record<string, NodeShape> = {
	rectangle: 'rectangle',
	ellipse: 'ellipse',
	oval: 'oval',
	diamond: 'diamond',
	rhombus: 'parallelogram',
	'rhombus-2': 'parallelogram',
	hexagon: 'hexagon',
	octagon: 'hexagon',
	pentagon: 'hexagon',
	triangle: 'triangle',
	trapezoid: 'trapezoid',
	star: 'star',
	cloud: 'cloud',
}

const SHAPE_TO_GEO: Record<NodeShape, string> = {
	rectangle: 'rectangle',
	oval: 'oval',
	ellipse: 'ellipse',
	diamond: 'diamond',
	cylinder: 'rectangle',
	hexagon: 'hexagon',
	parallelogram: 'rhombus',
	document: 'rectangle',
	trapezoid: 'trapezoid',
	triangle: 'triangle',
	star: 'star',
	cloud: 'cloud',
}

const TL_GEOS = new Set(['cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart'])

/** tldraw color style → octo DSL color (black/white stay monochrome). */
const TL_TO_COLOR: Record<string, string | undefined> = {
	black: undefined,
	white: undefined,
	grey: 'gray',
	'light-violet': 'violet',
	violet: 'purple',
	blue: 'blue',
	'light-blue': 'lightblue',
	yellow: 'yellow',
	orange: 'orange',
	green: 'green',
	'light-green': 'lime',
	'light-red': 'pink',
	red: 'red',
}

const COLOR_TO_TL: Record<string, string> = {
	gray: 'grey',
	grey: 'grey',
	violet: 'light-violet',
	purple: 'violet',
	indigo: 'violet',
	blue: 'blue',
	lightblue: 'light-blue',
	cyan: 'light-blue',
	teal: 'green',
	green: 'green',
	lime: 'light-green',
	yellow: 'yellow',
	orange: 'orange',
	brown: 'orange',
	red: 'red',
	pink: 'light-red',
	black: 'black',
	white: 'white',
}

/** tldraw color → freehand ink (hex or `ink`). */
function tlInk(color: unknown): string {
	if (color === 'black' || typeof color !== 'string') return 'ink'
	if (color === 'white') return 'paper'
	if (color === 'grey') return '#9B9A97'
	const c = TL_TO_COLOR[color]
	return c ? PALETTE[c] : 'ink'
}

/** freehand ink → tldraw color (nearest palette entry). */
function inkToTl(color: string): string {
	if (color === 'ink') return 'black'
	if (color === 'paper') return 'white'
	const hex = color.toLowerCase()
	if (hex === '#9b9a97') return 'grey'
	for (const [name, v] of Object.entries(PALETTE)) if (v === hex) return COLOR_TO_TL[name] ?? 'black'
	return 'black'
}

const SIZE_TO_LEVEL: Record<string, number> = { s: 1, m: 2, l: 3, xl: 4 }
const LEVEL_TO_SIZE = ['s', 'm', 'l', 'xl']

function contains(outer: Box, inner: Box, slack = 1) {
	return inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack
}

function normalize(input: unknown): TldrawRecord[] {
	if (Array.isArray(input)) return input.filter((r) => r && typeof r === 'object') as TldrawRecord[]
	if (!input || typeof input !== 'object') throw new Error('not a tldraw snapshot')
	const o = input as Rec
	if (o.document && typeof o.document === 'object' && o.document.store) return Object.values(o.document.store) as TldrawRecord[]
	if (o.store && typeof o.store === 'object') return Object.values(o.store) as TldrawRecord[]
	if (Array.isArray(o.records)) return o.records as TldrawRecord[]
	throw new Error('not a tldraw snapshot (expected { store } or { document: { store } })')
}

/** True when `value` looks like a tldraw snapshot (used by format detection). */
export function isTldrawSnapshot(value: unknown): boolean {
	try {
		return normalize(value).some((r) => r.typeName === 'shape' || r.typeName === 'page')
	} catch {
		return false
	}
}

// ---------------------------------------------------------------------------
// tldraw → octo

export function fromTldrawSnapshot(snapshot: unknown, opts: FromTldrawOptions = {}): OctoDocument {
	const warn = opts.onWarning ?? (() => {})
	const records = normalize(snapshot)
	const byId = new Map(records.map((r) => [r.id, r as Rec]))
	const pages = records.filter((r) => r.typeName === 'page').sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? '')))
	const pageId = opts.pageId ?? pages[0]?.id ?? 'page:page'
	const assets = new Map(records.filter((r) => r.typeName === 'asset').map((r) => [r.id, r as Rec]))

	// Absolute page transform of each shape (parents may be frames or groups).
	const absCache = new Map<string, { x: number; y: number; rot: number; page: string } | null>()
	const abs = (id: string, seen = new Set<string>()): { x: number; y: number; rot: number; page: string } | null => {
		if (absCache.has(id)) return absCache.get(id)!
		const s = byId.get(id)
		if (!s || s.typeName !== 'shape' || seen.has(id)) return null
		seen.add(id)
		const x = Number(s.x) || 0
		const y = Number(s.y) || 0
		const rot = Number(s.rotation) || 0
		let out: { x: number; y: number; rot: number; page: string } | null
		const parent = byId.get(s.parentId)
		if (parent?.typeName === 'shape') {
			const p = abs(parent.id, seen)
			if (!p) out = null
			else {
				const c = Math.cos(p.rot)
				const sn = Math.sin(p.rot)
				out = { x: p.x + x * c - y * sn, y: p.y + x * sn + y * c, rot: p.rot + rot, page: p.page }
			}
		} else out = { x, y, rot, page: String(s.parentId) }
		absCache.set(id, out)
		return out
	}

	const shapes = records
		.filter((r) => r.typeName === 'shape' && abs(r.id)?.page === pageId)
		.sort((a, b) => String(a.index ?? '').localeCompare(String(b.index ?? ''))) as Rec[]

	const rotated = shapes.filter((s) => Math.abs(abs(s.id)!.rot % (2 * Math.PI)) > 1e-3 && s.type !== 'arrow')
	if (rotated.length) warn(`${rotated.length} rotated shape(s) imported without rotation`)

	const boxOf = (s: Rec): Box => {
		const a = abs(s.id)!
		const p = s.props ?? {}
		return { x: a.x, y: a.y, w: Number(p.w) || 0, h: (Number(p.h) || 0) + (Number(p.growY) || 0) }
	}

	// 1. Diagram candidates: geo boxes and frames.
	// Geo boxes we exported from the freehand layer (meta.octo.id) go back to it.
	const isFreeGeo = (s: Rec) => s.type === 'geo' && typeof s.meta?.octo?.id === 'string' && s.meta?.octo?.key === undefined
	const geos = shapes.filter((s) => s.type === 'geo' && !isFreeGeo(s))
	const frames = shapes.filter((s) => s.type === 'frame')
	const boxed = [...geos, ...frames]
	const containers = new Set<string>(frames.map((f) => f.id))
	for (const g of geos) {
		const p = g.props ?? {}
		const looksLikeGroup = p.dash === 'dashed' || p.dash === 'dotted' || p.fill === 'none'
		if (!looksLikeGroup || (p.geo ?? 'rectangle') !== 'rectangle') continue
		const b = boxOf(g)
		if (boxed.some((o) => o !== g && contains(b, boxOf(o)) && b.w * b.h > boxOf(o).w * boxOf(o).h)) containers.add(g.id)
	}

	// 2. Keys from labels (unique; identity survives a round-trip via meta.octo.key).
	const used = new Set<string>()
	const keyOf = new Map<string, string>()
	const labelOf = new Map<string, string>()
	let anon = 0
	for (const s of boxed) {
		const isGroup = containers.has(s.id)
		const raw = s.type === 'frame' ? String(s.props?.name ?? '') : shapeText(s.props ?? {})
		const label = raw.trim()
		const metaKey = typeof s.meta?.octo?.key === 'string' ? (s.meta.octo.key as string) : undefined
		let key = metaKey ?? label.replace(/\s*\n\s*/g, ' ')
		if (!key) key = `${isGroup ? 'Group' : 'Box'} ${++anon}`
		if (used.has(key)) {
			let n = 2
			while (used.has(`${key} (${n})`)) n++
			key = `${key} (${n})`
		}
		used.add(key)
		keyOf.set(s.id, key)
		labelOf.set(s.id, label)
	}

	// 3. Parents: an enclosing frame (by parentId) or the smallest container that contains the box.
	const parentOf = new Map<string, string>()
	for (const s of boxed) {
		const b = boxOf(s)
		const area = b.w * b.h
		let best: Rec | undefined
		let bestArea = Infinity
		const direct = byId.get(s.parentId)
		if (direct && containers.has(direct.id) && keyOf.has(direct.id)) best = direct
		else
			for (const c of boxed) {
				if (c === s || !containers.has(c.id)) continue
				const cb = boxOf(c)
				const ca = cb.w * cb.h
				if (ca <= area || ca >= bestArea || !contains(cb, b)) continue
				best = c
				bestArea = ca
			}
		if (best) parentOf.set(s.id, best.id)
	}

	// 4. Nodes.
	const nodes: IRNode[] = []
	const centers = new Map<string, Point>()
	for (const s of boxed) {
		const p = s.props ?? {}
		const key = keyOf.get(s.id)!
		const label = labelOf.get(s.id)!
		const node: IRNode = { key }
		if (label !== key) node.label = label
		if (containers.has(s.id)) node.isContainer = true
		else {
			const geo = String(p.geo ?? 'rectangle')
			const shape = GEO_TO_SHAPE[geo]
			if (typeof s.meta?.octo?.shape === 'string' && (NODE_SHAPES as readonly string[]).includes(s.meta.octo.shape)) node.shape = s.meta.octo.shape
			else if (shape && shape !== 'rectangle') node.shape = shape
			else if (!shape) {
				node.ext = { geo }
				warn(`geo "${geo}" has no octo shape; imported as a rectangle`)
			}
		}
		const color = TL_TO_COLOR[String(p.color ?? 'black')]
		// grey is the conventional (uncolored) look of group boxes
		if (color && !(node.isContainer && color === 'gray')) node.style = { color }
		if (typeof p.url === 'string' && p.url) node.link = p.url
		const parent = parentOf.get(s.id)
		if (parent) node.parent = keyOf.get(parent)
		nodes.push(node)
		const b = boxOf(s)
		centers.set(key, { x: b.x + b.w / 2, y: b.y + b.h / 2 })
	}

	// 5. Edges from arrows bound at both ends; the rest become freehand arrows.
	const bindingsFor = new Map<string, Rec[]>()
	for (const r of records as Rec[]) {
		if (r.typeName !== 'binding' || r.type !== 'arrow') continue
		const list = bindingsFor.get(r.fromId) ?? []
		list.push(r)
		bindingsFor.set(r.fromId, list)
	}
	const edges: IREdge[] = []
	const free: FreeShape[] = []
	const pairCount = new Map<string, number>()
	const freeMeta = (s: Rec, extra: Rec = {}) => ({ tldraw: { id: s.id, type: s.type, ...extra } })
	for (const s of shapes.filter((x) => x.type === 'arrow')) {
		const p = s.props ?? {}
		const terminal = (t: 'start' | 'end'): string | undefined => {
			const b = bindingsFor.get(s.id)?.find((x) => x.props?.terminal === t)
			if (b) return b.toId
			const legacy = p[t]
			return legacy && legacy.type === 'binding' ? legacy.boundShapeId : undefined
		}
		const from = keyOf.get(terminal('start') ?? '')
		const to = keyOf.get(terminal('end') ?? '')
		const label = shapeText(p).trim()
		const dash: 'solid' | 'dotted' = p.dash === 'dashed' || p.dash === 'dotted' ? 'dotted' : 'solid'
		const color = TL_TO_COLOR[String(p.color ?? 'black')]
		if (from && to) {
			const pair = `${from}->${to}`
			const n = pairCount.get(pair) ?? 0
			pairCount.set(pair, n + 1)
			const metaKey = typeof s.meta?.octo?.key === 'string' ? (s.meta.octo.key as string) : undefined
			const edge: IREdge = {
				key: metaKey && !/->.*#\d+$/.test(metaKey) ? metaKey : `${pair}#${n}`,
				from,
				to,
				arrow: { start: p.arrowheadStart && p.arrowheadStart !== 'none' ? 'arrow' : 'none', end: p.arrowheadEnd === undefined || p.arrowheadEnd !== 'none' ? 'arrow' : 'none' },
				line: { dash },
			}
			if (label) edge.label = label
			if (color && color !== 'gray') edge.style = { color }
			// The DSL has no dotted operator with a start arrowhead; keep the dash as a prop.
			if (dash === 'dotted' && edge.arrow.start === 'arrow') edge.style = { ...edge.style, dash: 'dotted' }
			edges.push(edge)
			continue
		}
		const a = abs(s.id)!
		const start = p.start && typeof p.start.x === 'number' ? p.start : { x: 0, y: 0 }
		const end = p.end && typeof p.end.x === 'number' ? p.end : { x: 0, y: 0 }
		free.push({
			id: typeof s.meta?.octo?.id === 'string' ? (s.meta.octo.id as string) : freeId(s.id),
			type: 'arrow',
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			points: [[a.x + start.x, a.y + start.y, 0.5], [a.x + end.x, a.y + end.y, 0.5]],
			color: tlInk(p.color),
			size: SIZE_TO_LEVEL[p.size] ?? 2,
			meta: freeMeta(s, label ? { label } : {}),
		})
		if (from || to) warn(`arrow ${s.id} is bound at one end only; imported as a drawing`)
	}

	// 6. Everything else → freehand.
	for (const s of shapes) {
		if ((s.type === 'geo' && !isFreeGeo(s)) || s.type === 'frame' || s.type === 'arrow' || s.type === 'group') continue
		const p = s.props ?? {}
		const a = abs(s.id)!
		const size = SIZE_TO_LEVEL[p.size] ?? 2
		const id = typeof s.meta?.octo?.id === 'string' ? (s.meta.octo.id as string) : freeId(s.id)
		switch (s.type) {
			case 'geo':
				free.push({ id, type: p.geo === 'ellipse' ? 'ellipse' : 'rect', x: a.x, y: a.y, w: Number(p.w) || 0, h: Number(p.h) || 0, color: tlInk(p.color), size, meta: freeMeta(s) })
				break
			case 'text': {
				const text = shapeText(p)
				const lines = text.split('\n').length
				free.push({ id, type: 'text', x: a.x, y: a.y, w: Number(p.w) || estimateText(text, 20).w, h: lines * 26, text, color: tlInk(p.color), size, meta: freeMeta(s) })
				break
			}
			case 'draw':
			case 'highlight': {
				const sx = (Number(p.scaleX) || 1) * (Number(p.scale) || 1)
				const sy = (Number(p.scaleY) || 1) * (Number(p.scale) || 1)
				const points: FreePoint[] = []
				for (const seg of Array.isArray(p.segments) ? p.segments : []) {
					const pts = typeof seg.path === 'string' ? decodePoints(seg.path, seg.dim === 2 ? 2 : 3) : Array.isArray(seg.points) ? seg.points.map((q: Rec) => ({ x: q.x, y: q.y, z: q.z ?? 0.5 })) : []
					for (const q of pts) points.push([round(a.x + q.x * sx), round(a.y + q.y * sy), round(q.z ?? 0.5)])
				}
				if (!points.length) break
				free.push({ id, type: 'pen', x: 0, y: 0, w: 0, h: 0, points, color: tlInk(p.color), size: s.type === 'highlight' ? 4 : size, pressure: !!p.isPen || undefined, meta: freeMeta(s) })
				break
			}
			case 'line': {
				const pts = Object.values((p.points ?? {}) as Record<string, Rec>).sort((x, y) => String(x.index).localeCompare(String(y.index)))
				if (pts.length < 2) break
				const sc = Number(p.scale) || 1
				free.push({ id, type: 'pen', x: 0, y: 0, w: 0, h: 0, points: pts.map((q) => [round(a.x + q.x * sc), round(a.y + q.y * sc), 0.5] as FreePoint), color: tlInk(p.color), size, meta: freeMeta(s) })
				break
			}
			case 'note': {
				const sc = Number(p.scale) || 1
				free.push({ id, type: 'sticky', x: a.x, y: a.y, w: 200 * sc, h: (200 + (Number(p.growY) || 0)) * sc, text: shapeText(p), color: p.color === 'yellow' || !p.color ? 'ink' : tlInk(p.color), size: 1, meta: freeMeta(s) })
				break
			}
			case 'image': {
				const asset = p.assetId ? assets.get(p.assetId) : undefined
				const src = asset?.props?.src ?? (p.url || undefined)
				const shape: FreeShape = { id, type: 'image', x: a.x, y: a.y, w: Number(p.w) || 100, h: Number(p.h) || 100, color: 'ink', size: 1, meta: freeMeta(s) }
				if (typeof src === 'string' && src) shape.src = src
				else warn(`image ${s.id} has no source; imported as an empty image`)
				free.push(shape)
				break
			}
			default: {
				// video, embed, bookmark, custom shapes: keep a placeholder box and the source.
				const w = Number(p.w) || 100
				const h = Number(p.h) || 100
				const asset = p.assetId ? assets.get(p.assetId) : undefined
				const src = asset?.props?.src ?? p.url
				free.push({ id, type: 'rect', x: a.x, y: a.y, w, h, color: 'ink', size: 1, meta: freeMeta(s, src ? { src } : {}) })
				if (!['video', 'embed', 'bookmark'].includes(s.type)) warn(`unknown shape type "${s.type}" imported as a placeholder box`)
			}
		}
	}

	// 7. IR → code; leaf nodes are pinned so the canvas arrangement is kept (centers align).
	const ir: DiagramIR = { version: 1, kind: 'flowchart', direction: inferDirection(edges, centers), style: {}, nodes, edges }
	const title = opts.title ?? (String(pages.find((p) => p.id === pageId)?.name ?? '') || 'Imported canvas')
	const pins: Record<string, Point> = {}
	for (const n of nodes) {
		if (n.isContainer) continue
		const c = centers.get(n.key)!
		const sz = nodeSize(n, estimateText)
		pins[n.key] = { x: round(c.x - sz.w / 2), y: round(c.y - sz.h / 2) }
	}
	return createDocument({ id: opts.id, title, code: printOcto(ir), pins, shapes: free })
}

const round = (n: number) => Math.round(n * 100) / 100
const freeId = (tlId: string) => tlId.replace(/^shape:/, '')

function inferDirection(edges: IREdge[], centers: Map<string, Point>): Direction {
	let right = 0
	let left = 0
	let down = 0
	let up = 0
	for (const e of edges) {
		const a = centers.get(e.from)
		const b = centers.get(e.to)
		if (!a || !b) continue
		const dx = b.x - a.x
		const dy = b.y - a.y
		if (Math.abs(dx) > Math.abs(dy)) dx > 0 ? right++ : left++
		else dy > 0 ? down++ : up++
	}
	const best = Math.max(right, left, down, up)
	if (best === 0 || best === down) return 'down'
	if (best === right) return 'right'
	if (best === up) return 'up'
	return 'left'
}

// ---------------------------------------------------------------------------
// octo → tldraw

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** n-th fractional index key, ascending: a0..az, b00..bzz, c000.. */
export function indexKey(n: number): string {
	let width = 1
	let rest = n
	while (rest >= 62 ** width) {
		rest -= 62 ** width
		width++
	}
	let s = ''
	for (let i = 0; i < width; i++) {
		s = DIGITS[rest % 62] + s
		rest = Math.floor(rest / 62)
	}
	return String.fromCharCode(96 + width) + s
}

export function toTldrawSnapshot(doc: Pick<OctoDocument, 'code' | 'shapes' | 'title'>, layout: DiagramLayout, opts: ToTldrawOptions = {}): TldrawStoreSnapshot {
	const ir = parseOcto(doc.code).ir
	const pageId = 'page:page'
	const store: Record<string, TldrawRecord> = {}
	const put = (r: TldrawRecord) => (store[r.id] = r)
	put({ id: 'document:document', typeName: 'document', gridSize: 10, name: doc.title ?? '', meta: {} })
	put({ id: pageId, typeName: 'page', name: opts.pageName ?? 'Page 1', index: 'a1', meta: {} })

	let z = 0
	const base = (id: string, type: string, x: number, y: number, props: Rec, meta: Rec = {}): TldrawRecord => ({
		id,
		typeName: 'shape',
		type,
		x: round(x),
		y: round(y),
		rotation: 0,
		index: indexKey(z++),
		parentId: pageId,
		isLocked: false,
		opacity: 1,
		meta,
		props,
	})
	const geoProps = (geo: string, w: number, h: number, label: string, o: Rec = {}) => ({
		geo,
		dash: o.dash ?? 'draw',
		url: o.url ?? '',
		w: round(w),
		h: round(h),
		growY: 0,
		scale: 1,
		flipX: false,
		flipY: false,
		labelColor: o.color ?? 'black',
		color: o.color ?? 'black',
		fill: o.fill ?? 'semi',
		size: o.size ?? 's',
		font: 'sans',
		align: o.align ?? 'middle',
		verticalAlign: o.verticalAlign ?? 'middle',
		richText: plainToRichText(label),
	})
	const tlColor = (c: string | undefined) => (c ? (COLOR_TO_TL[c.toLowerCase()] ?? 'black') : 'black')

	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const shapeIdOf = new Map<string, string>()
	const laid = Object.values(layout.nodes).filter((n) => byKey.has(n.key))
	const groups = laid.filter((n) => n.isContainer).sort((a, b) => a.depth - b.depth)
	const leaves = laid.filter((n) => !n.isContainer)
	let i = 0
	for (const g of groups) {
		const node = byKey.get(g.key)!
		const id = `shape:group-${i++}`
		shapeIdOf.set(g.key, id)
		put(base(id, 'geo', g.x, g.y, geoProps('rectangle', g.w, g.h, node.label ?? node.key, { color: node.style?.color ? tlColor(node.style.color) : 'grey', fill: 'none', dash: 'dashed', align: 'start', verticalAlign: 'start' }), { octo: { key: node.key } }))
	}
	for (const n of leaves) {
		const node = byKey.get(n.key)!
		const id = `shape:node-${i++}`
		shapeIdOf.set(n.key, id)
		const shape = node.shape ?? 'rectangle'
		const geo = node.ext?.geo && TL_GEOS.has(node.ext.geo) ? node.ext.geo : SHAPE_TO_GEO[shape]
		const meta: Rec = { octo: { key: node.key, ...(node.shape && SHAPE_TO_GEO[node.shape] !== node.shape ? { shape: node.shape } : {}) } }
		put(base(id, 'geo', n.x, n.y, geoProps(geo, n.w, n.h, node.label ?? node.key, { color: tlColor(node.style?.color), url: node.link }), meta))
	}

	ir.edges.forEach((e, k) => {
		const le = layout.edges[e.key]
		const from = shapeIdOf.get(e.from)
		const to = shapeIdOf.get(e.to)
		if (!le || le.points.length < 2 || !from || !to) return
		const p0 = le.points[0]
		const p1 = le.points[le.points.length - 1]
		const id = `shape:edge-${k}`
		const dash = e.style?.dash ?? e.line.dash
		put(
			base(
				id,
				'arrow',
				p0.x,
				p0.y,
				{
					kind: le.points.length > 2 ? 'elbow' : 'arc',
					labelColor: 'black',
					color: e.style?.color ? tlColor(e.style.color) : 'black',
					fill: 'none',
					dash: dash === 'dotted' ? 'dotted' : dash === 'dashed' ? 'dashed' : 'solid',
					size: 's',
					arrowheadStart: e.arrow.start === 'arrow' ? 'arrow' : 'none',
					arrowheadEnd: e.arrow.end === 'arrow' ? 'arrow' : 'none',
					font: 'sans',
					start: { x: 0, y: 0 },
					end: { x: round(p1.x - p0.x), y: round(p1.y - p0.y) },
					bend: 0,
					richText: plainToRichText(e.label ?? ''),
					labelPosition: 0.5,
					scale: 1,
					elbowMidPoint: 0.5,
				},
				{ octo: { key: e.key } },
			),
		)
		for (const terminal of ['start', 'end'] as const) {
			const bid = `binding:edge-${k}-${terminal}`
			put({ id: bid, typeName: 'binding', type: 'arrow', fromId: id, toId: terminal === 'start' ? from : to, meta: {}, props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } })
		}
	})

	for (const s of doc.shapes ?? []) {
		const id = `shape:free-${s.id}`
		const color = inkToTl(s.color)
		const size = LEVEL_TO_SIZE[Math.max(0, Math.min(3, Math.round(s.size) - 1))]
		const meta = { octo: { id: s.id } }
		switch (s.type) {
			case 'rect':
			case 'ellipse': {
				const b = freeShapeBounds(s)
				put(base(id, 'geo', b.x, b.y, geoProps(s.type === 'rect' ? 'rectangle' : 'ellipse', b.w || 1, b.h || 1, '', { color, fill: 'none', dash: 'solid', size }), meta))
				break
			}
			case 'text':
				put(base(id, 'text', s.x, s.y, { color, size, font: 'sans', textAlign: 'start', w: round(Math.max(8, s.w)), richText: plainToRichText(s.text ?? ''), scale: s.scale ?? 1, autoSize: true }, meta))
				break
			case 'sticky': {
				const sc = Math.max(0.1, s.w / 200)
				put(base(id, 'note', s.x, s.y, { color: s.color === 'ink' ? 'yellow' : color, labelColor: 'black', size: 'm', font: 'sans', fontSizeAdjustment: 1, align: 'middle', verticalAlign: 'middle', growY: Math.max(0, round(s.h / sc - 200)), url: '', richText: plainToRichText(s.text ?? ''), scale: round(sc), textLastEditedBy: null }, meta))
				break
			}
			case 'image': {
				let assetId: string | null = null
				if (s.src) {
					assetId = `asset:free-${s.id}`
					const mime = s.src.match(/^data:([^;,]+)/)?.[1] ?? null
					put({ id: assetId, typeName: 'asset', type: 'image', props: { w: round(s.w), h: round(s.h), name: s.id, isAnimated: false, mimeType: mime, src: s.src }, meta: {} })
				}
				put(base(id, 'image', s.x, s.y, { w: round(Math.max(1, s.w)), h: round(Math.max(1, s.h)), playing: true, url: '', assetId, crop: null, flipX: false, flipY: false, altText: '' }, meta))
				break
			}
			case 'arrow': {
				const p = s.points ?? []
				if (p.length < 2) break
				const [a, b] = [p[0], p[p.length - 1]]
				put(
					base(id, 'arrow', a[0], a[1], {
						kind: 'arc',
						labelColor: 'black',
						color,
						fill: 'none',
						dash: 'solid',
						size,
						arrowheadStart: 'none',
						arrowheadEnd: 'arrow',
						font: 'sans',
						start: { x: 0, y: 0 },
						end: { x: round(b[0] - a[0]), y: round(b[1] - a[1]) },
						bend: 0,
						richText: plainToRichText(''),
						labelPosition: 0.5,
						scale: 1,
						elbowMidPoint: 0.5,
					}, meta),
				)
				break
			}
			case 'pen': {
				const p = s.points ?? []
				if (!p.length) break
				const ox = Math.min(...p.map((q) => q[0]))
				const oy = Math.min(...p.map((q) => q[1]))
				const path = encodePoints(p.map(([x, y, pr]) => ({ x: x - ox, y: y - oy, z: pr })), 3)
				put(base(id, 'draw', ox, oy, { color, fill: 'none', dash: 'draw', size, segments: [{ type: 'free', path }], isComplete: true, isClosed: false, isPen: !!s.pressure, scale: 1, scaleX: 1, scaleY: 1 }, meta))
				break
			}
		}
	}

	return { store, schema: JSON.parse(JSON.stringify(TLDRAW_SCHEMA)) }
}
