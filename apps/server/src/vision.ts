/**
 * Two-pass vision import: image → nodes JSON → edges JSON → DiagramIR → octo DSL.
 *
 *   pass 1  nodes (id, label, shape, bbox 0–1000, parent group) — structured outputs
 *   pass 2  image again + node list → edges (endpoint ids, direction, label, points)
 *   pass 3  (only when endpoints could not be matched) repair with the diagnostics
 *
 * Endpoints are snapped to known nodes (exact id → case/label match → the node
 * under / nearest the endpoint point). Node bboxes become layout pins so the
 * import keeps the image's arrangement. Sequence diagrams, ERDs, non-diagrams
 * and any failure fall back to the single-pass DSL transcription in `ai.ts`.
 */

import {
	emptyIR,
	pinsFromRects,
	printOcto,
	type DiagramIR,
	type IREdge,
	type IRNode,
	type NodeShape,
	type Point,
} from '@octo-draw/core'
import { z } from 'zod'
import { assertNotRefused, vision as visionSingle, type ImageMediaType } from './ai'
import { echoContent, textOf, type Message, type MessageParam, type StreamFn } from './claude'
import {
	VISION_COLORS,
	VISION_EDGES_SCHEMA,
	VISION_EDGES_SYSTEM,
	VISION_KINDS,
	VISION_NODES_SCHEMA,
	VISION_NODES_SYSTEM,
	VISION_NODES_USER,
	VISION_SHAPES,
	visionEdgesRepair,
	visionEdgesUser,
} from './visionPrompts'

// ---------------------------------------------------------------------------
// Model output validation (lenient: the schema is enforced server-side, this
// guards against truncation and old models)

const num = z.coerce.number().catch(0)
const BBox = z.object({ x: num, y: num, w: num, h: num })
const Pt = z.object({ x: num, y: num })

export const NodesOutput = z.object({
	is_diagram: z.boolean().catch(true),
	kind: z.enum(VISION_KINDS).catch('flowchart'),
	direction: z.enum(['right', 'down', 'left', 'up']).catch('down'),
	title: z.string().nullish(),
	nodes: z.array(
		z.object({
			id: z.coerce.string(),
			label: z.coerce.string().catch(''),
			shape: z.string().catch('rectangle'),
			bbox: BBox.nullish(),
			parent: z.string().nullish(),
			is_container: z.boolean().catch(false),
			color: z.string().nullish(),
			icon: z.string().nullish(),
			confidence: z.number().nullish(),
		}),
	),
})
export type NodesOutput = z.infer<typeof NodesOutput>

export const EdgesOutput = z.object({
	edges: z.array(
		z.object({
			from: z.coerce.string(),
			to: z.coerce.string(),
			direction: z.enum(['forward', 'both', 'none']).catch('forward'),
			label: z.string().nullish(),
			dashed: z.boolean().catch(false),
			from_point: Pt.nullish(),
			to_point: Pt.nullish(),
			confidence: z.number().nullish(),
		}),
	),
})
export type EdgesOutput = z.infer<typeof EdgesOutput>

export class VisionPassError extends Error {}

/** Parses a structured-output reply. Tolerates a stray fence or prose around the JSON. */
export function parseJsonReply<T>(message: Message, schema: z.ZodType<T>): T {
	if (message.stop_reason === 'max_tokens') throw new VisionPassError('model output was truncated')
	const text = textOf(message).trim()
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		const a = text.indexOf('{')
		const b = text.lastIndexOf('}')
		if (a < 0 || b <= a) throw new VisionPassError('reply was not JSON')
		try {
			raw = JSON.parse(text.slice(a, b + 1))
		} catch {
			throw new VisionPassError('reply was not JSON')
		}
	}
	const r = schema.safeParse(raw)
	if (!r.success) throw new VisionPassError(`reply did not match the schema: ${r.error.issues[0]?.message ?? ''}`)
	return r.data
}

// ---------------------------------------------------------------------------
// Image size (for the aspect ratio of normalised bboxes)

export function imageSize(base64: string): { width: number; height: number } | null {
	let b: Buffer
	try {
		b = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
	} catch {
		return null
	}
	if (b.length < 24) return null
	// PNG
	if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
	// GIF
	if (b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
	// WebP
	if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
		const chunk = b.toString('ascii', 12, 16)
		if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
		if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
		if (chunk === 'VP8L' && b.length >= 25) {
			const bits = b.readUInt32LE(21)
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
		}
		return null
	}
	// JPEG: walk the segments to a SOF marker
	if (b[0] === 0xff && b[1] === 0xd8) {
		let i = 2
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++
				continue
			}
			const marker = b[i + 1]
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
			}
			i += 2 + b.readUInt16BE(i + 2)
		}
	}
	return null
}

// ---------------------------------------------------------------------------
// JSON → IR

export interface VisionConversion {
	ir: DiagramIR
	pins: Record<string, Point>
	confidence: number
	warnings: string[]
	/** Edges whose endpoints could not be matched (input for the repair pass). */
	unresolved: string[]
	/** Model node id → IR node key. */
	keyOf: Map<string, string>
}

const SHAPES = new Set<string>(VISION_SHAPES)
const COLORS = new Set<string>(VISION_COLORS)
/** Longest image side in canvas units. */
export const CANVAS_SPAN = 1400
/** Max distance (0–1000 units) from an endpoint point to a node border for snapping. */
const SNAP_DIST = 60

const clamp01 = (x: number | null | undefined, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d)
const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, ' ').trim()

type VNode = NodesOutput['nodes'][number]
type VEdge = EdgesOutput['edges'][number]

export function visionToIR(
	nodesOut: NodesOutput,
	edgesOut: EdgesOutput,
	image?: { width: number; height: number } | null,
): VisionConversion {
	const warnings: string[] = []
	const ir = emptyIR(nodesOut.kind === 'architecture' ? 'architecture' : 'flowchart')
	ir.direction = nodesOut.direction
	if (nodesOut.title?.trim()) ir.title = nodesOut.title.trim()

	// --- nodes: unique ids, unique keys (= labels), shapes, colours
	const byId = new Map<string, VNode>()
	const keyOf = new Map<string, string>()
	const usedKeys = new Set<string>()
	const nodeOf = new Map<string, IRNode>()
	for (const raw of nodesOut.nodes) {
		let id = raw.id.trim()
		if (!id) {
			warnings.push(`Dropped a node without an id (${JSON.stringify(raw.label)})`)
			continue
		}
		if (byId.has(id)) {
			let n = 2
			while (byId.has(`${id}_${n}`)) n++
			warnings.push(`Duplicate node id ${id} renamed to ${id}_${n}`)
			id = `${id}_${n}`
		}
		const v = { ...raw, id }
		byId.set(id, v)
		const label = (v.label || id).replace(/\s+/g, ' ').trim()
		let key = label
		for (let n = 2; usedKeys.has(key); n++) key = `${label} ${n}`
		usedKeys.add(key)
		keyOf.set(id, key)
		const node: IRNode = { key }
		if (key !== label) node.label = label
		if (SHAPES.has(v.shape) && v.shape !== 'rectangle') node.shape = v.shape as NodeShape
		if (v.color && COLORS.has(v.color)) node.style = { color: v.color }
		if (v.icon && /^[a-z0-9][a-z0-9-]*$/.test(v.icon)) node.icon = v.icon
		nodeOf.set(id, node)
		ir.nodes.push(node)
	}

	// --- containment (no cycles; a parent must be a known node)
	const parentId = new Map<string, string>()
	for (const v of byId.values()) {
		if (!v.parent) continue
		if (!byId.has(v.parent) || v.parent === v.id) {
			warnings.push(`Node ${v.id} has unknown parent ${v.parent}`)
			continue
		}
		parentId.set(v.id, v.parent)
	}
	for (const id of [...parentId.keys()]) {
		const seen = new Set([id])
		for (let p = parentId.get(id); p; p = parentId.get(p)) {
			if (seen.has(p)) {
				parentId.delete(id)
				warnings.push(`Ignored a containment cycle at ${id}`)
				break
			}
			seen.add(p)
		}
	}
	for (const [child, p] of parentId) {
		nodeOf.get(child)!.parent = keyOf.get(p)
		nodeOf.get(p)!.isContainer = true
	}
	// Order: containers before their children keeps printOcto's grouping readable.
	ir.nodes.sort((a, b) => depth(a) - depth(b))
	function depth(n: IRNode): number {
		let d = 0
		let p = n.parent
		while (p && d < 50) {
			d++
			p = ir.nodes.find((x) => x.key === p)?.parent
		}
		return d
	}

	// --- edges with endpoint snapping
	const unresolved: string[] = []
	const lookup = buildLookup(byId)
	const pairCount = new Map<string, number>()
	const seenEdges = new Set<string>()
	let edgeConf = 0
	for (const e of edgesOut.edges) {
		const from = resolveEndpoint(e.from, e.from_point, lookup, byId)
		const to = resolveEndpoint(e.to, e.to_point, lookup, byId)
		if (!from.id || !to.id) {
			unresolved.push(
				`edge ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}${e.label ? ` (${JSON.stringify(e.label)})` : ''}: unknown ${!from.id ? 'from' : 'to'} id`,
			)
			continue
		}
		for (const r of [from, to]) if (r.snapped) warnings.push(r.snapped)
		const a = keyOf.get(from.id)!
		const b = keyOf.get(to.id)!
		const label = e.label?.replace(/\s+/g, ' ').trim() || undefined
		const sig = `${a}\u0000${b}\u0000${label ?? ''}\u0000${e.direction}`
		if (seenEdges.has(sig)) {
			warnings.push(`Dropped a duplicate edge ${a} -> ${b}`)
			continue
		}
		seenEdges.add(sig)
		const pair = `${a}->${b}`
		const n = pairCount.get(pair) ?? 0
		pairCount.set(pair, n + 1)
		const edge: IREdge = {
			key: `${pair}#${n}`,
			from: a,
			to: b,
			arrow: { start: e.direction === 'both' ? 'arrow' : 'none', end: e.direction === 'none' ? 'none' : 'arrow' },
			line: { dash: e.dashed ? 'dotted' : 'solid' },
		}
		if (label) edge.label = label
		ir.edges.push(edge)
		edgeConf += clamp01(e.confidence, 0.8)
	}

	// --- pins from bboxes (aspect-correct when the image size is known)
	const W = image?.width && image.height ? image.width : 1
	const H = image?.width && image.height ? image.height : 1
	const unit = CANVAS_SPAN / Math.max(W, H)
	const rects: Record<string, { x: number; y: number; w: number; h: number }> = {}
	for (const v of byId.values()) {
		if (!v.bbox) continue
		const { x, y, w, h } = v.bbox
		if (w <= 0 || h <= 0) continue
		rects[keyOf.get(v.id)!] = { x, y, w, h }
	}
	const pins = pinsFromRects(ir, rects, { scaleX: (W / 1000) * unit, scaleY: (H / 1000) * unit })

	// --- confidence
	const nodeConf = byId.size ? [...byId.values()].reduce((s, v) => s + clamp01(v.confidence, 0.8), 0) / byId.size : 0
	const total = edgesOut.edges.length
	const edgeScore = total ? (edgeConf / Math.max(1, ir.edges.length)) * (ir.edges.length / total) : 1
	const penalty = Math.max(0.5, 1 - 0.03 * warnings.length)
	const confidence = Math.round((ir.nodes.length ? (0.5 * nodeConf + 0.5 * edgeScore) * penalty : 0) * 1000) / 1000

	return { ir, pins, confidence, warnings, unresolved, keyOf }
}

interface Lookup {
	byLower: Map<string, string[]>
}

function buildLookup(byId: Map<string, VNode>): Lookup {
	const byLower = new Map<string, string[]>()
	const add = (k: string, id: string) => {
		const l = byLower.get(k) ?? []
		if (!l.includes(id)) l.push(id)
		byLower.set(k, l)
	}
	for (const v of byId.values()) {
		add(norm(v.id), v.id)
		if (v.label) add(norm(v.label), v.id)
	}
	return { byLower }
}

/**
 * Snaps an edge endpoint to a node id: exact id, then a unique case-insensitive
 * id/label match, then the node under (or nearest to) the endpoint point,
 * then a unique partial label match.
 */
export function resolveEndpoint(
	ref: string,
	point: { x: number; y: number } | null | undefined,
	lookup: Lookup,
	byId: Map<string, VNode>,
): { id?: string; snapped?: string } {
	const r = ref.trim()
	if (byId.has(r)) return { id: r }
	const hits = lookup.byLower.get(norm(r))
	if (hits?.length === 1) return { id: hits[0], snapped: `Matched endpoint ${JSON.stringify(ref)} to node ${hits[0]} by name` }
	if (point) {
		let best: { id: string; d: number; area: number } | undefined
		for (const v of byId.values()) {
			if (!v.bbox) continue
			const { x, y, w, h } = v.bbox
			const dx = Math.max(x - point.x, 0, point.x - (x + w))
			const dy = Math.max(y - point.y, 0, point.y - (y + h))
			const d = Math.hypot(dx, dy)
			const area = w * h
			// inside beats outside; among insiders the smallest (innermost) box wins
			if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) < 1e-9 && area < best.area)) best = { id: v.id, d, area }
		}
		if (best && best.d <= SNAP_DIST) return { id: best.id, snapped: `Snapped endpoint ${JSON.stringify(ref)} to node ${best.id} by position` }
	}
	const n = norm(r)
	if (n.length >= 3) {
		const partial = [...byId.values()].filter((v) => {
			const l = norm(v.label || '')
			return l && (l.includes(n) || n.includes(l))
		})
		if (partial.length === 1) return { id: partial[0].id, snapped: `Matched endpoint ${JSON.stringify(ref)} to node ${partial[0].id} by partial name` }
	}
	return {}
}

// ---------------------------------------------------------------------------
// Pipeline

export interface VisionResult {
	code: string
	pins?: Record<string, Point>
	confidence?: number
	warnings?: string[]
	diagnostics?: string
	pipeline: 'two-pass' | 'single-pass'
}

export type VisionMode = 'auto' | 'single'

interface VisionInput {
	imageBase64: string
	mediaType: ImageMediaType
}

/** Thrown internally when the image should go through the single-pass DSL path instead. */
class Fallback extends Error {}

export async function visionTwoPass(stream: StreamFn, input: VisionInput): Promise<VisionResult> {
	const data = input.imageBase64.replace(/^data:[^;]+;base64,/, '')
	const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: input.mediaType, data } }

	// Pass 1: nodes
	const first = await stream({
		system: VISION_NODES_SYSTEM,
		messages: [{ role: 'user', content: [image, { type: 'text', text: VISION_NODES_USER }] }],
		effort: 'medium',
		outputFormat: { type: 'json_schema', schema: VISION_NODES_SCHEMA as unknown as Record<string, unknown> },
	})
	assertNotRefused(first)
	const nodes = parseJsonReply(first, NodesOutput)
	if (!nodes.is_diagram) throw new Fallback('not a diagram')
	if (nodes.kind === 'sequence' || nodes.kind === 'erd') throw new Fallback(`${nodes.kind} diagrams use the DSL transcription`)
	if (!nodes.nodes.length) throw new Fallback('no nodes found')

	// Pass 2: edges
	const promptNodes = nodes.nodes.map((n) => ({
		id: n.id,
		label: n.label,
		bbox: { x: Math.round(n.bbox?.x ?? 0), y: Math.round(n.bbox?.y ?? 0), w: Math.round(n.bbox?.w ?? 0), h: Math.round(n.bbox?.h ?? 0) },
		is_container: n.is_container,
	}))
	const edgeMessages: MessageParam[] = [{ role: 'user', content: [image, { type: 'text', text: visionEdgesUser(promptNodes) }] }]
	const edgeFormat = { type: 'json_schema' as const, schema: VISION_EDGES_SCHEMA as unknown as Record<string, unknown> }
	const warnings: string[] = []
	let edges: EdgesOutput = { edges: [] }
	const second = await stream({ system: VISION_EDGES_SYSTEM, messages: edgeMessages, effort: 'medium', outputFormat: edgeFormat })
	if (second.stop_reason === 'refusal') warnings.push('The model declined to list the connections; only nodes were imported')
	else edges = parseJsonReply(second, EdgesOutput)

	const imgSize = imageSize(data)
	let conv = visionToIR(nodes, edges, imgSize)

	// Pass 3: repair unmatched endpoints once
	if (conv.unresolved.length && second.stop_reason !== 'refusal') {
		edgeMessages.push({ role: 'assistant', content: echoContent(second.content) })
		edgeMessages.push({ role: 'user', content: visionEdgesRepair(conv.unresolved, [...conv.keyOf.keys()]) })
		try {
			const third = await stream({ system: VISION_EDGES_SYSTEM, messages: edgeMessages, effort: 'medium', outputFormat: edgeFormat })
			if (third.stop_reason !== 'refusal') {
				const repaired = visionToIR(nodes, parseJsonReply(third, EdgesOutput), imgSize)
				if (repaired.unresolved.length < conv.unresolved.length) conv = repaired
			}
		} catch (err) {
			if (!(err instanceof VisionPassError)) throw err
			warnings.push(`Edge repair failed: ${err.message}`)
		}
	}
	for (const u of conv.unresolved) warnings.push(`Dropped ${u}`)

	return {
		code: printOcto(conv.ir),
		pins: conv.pins,
		confidence: conv.confidence,
		warnings: [...warnings, ...conv.warnings],
		pipeline: 'two-pass',
	}
}

/**
 * `auto`: two-pass structured pipeline, falling back to the single-pass DSL
 * transcription for sequence diagrams / ERDs / non-diagrams or when a pass
 * returns unusable JSON. Refusals propagate (→ 422). `single`: old path only.
 */
export async function visionImport(stream: StreamFn, input: VisionInput, mode: VisionMode = 'auto'): Promise<VisionResult> {
	if (mode === 'auto') {
		try {
			return await visionTwoPass(stream, input)
		} catch (err) {
			if (!(err instanceof Fallback) && !(err instanceof VisionPassError)) throw err
			const single = await visionSingle(stream, input)
			return {
				code: single.code,
				diagnostics: single.diagnostics || undefined,
				warnings: err instanceof VisionPassError ? [`Two-pass import failed (${err.message}); used direct transcription`] : undefined,
				pipeline: 'single-pass',
			}
		}
	}
	const single = await visionSingle(stream, input)
	return { code: single.code, diagnostics: single.diagnostics || undefined, pipeline: 'single-pass' }
}
