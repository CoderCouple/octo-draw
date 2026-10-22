/**
 * ERD layout: ELK layered places the entity tables (sized by their attribute
 * rows); relationships are then routed attribute row to attribute row.
 */
import { getElk } from './elk'
import type { DiagramIR, DiagramLayout, IRNode, LaidOutEdge, LaidOutNode, LayoutOptions } from '../ir'
import { computeBounds } from './pins'
import { ERD_HEAD_H, ERD_ROW_H, routeErdEdge } from './erdRoute'
import { ICON_SIZE, estimateText, nodeLabel, type Measure } from './sizing'

export const ERD_HEAD_FONT = 13
export const ERD_FIELD_FONT = 12
export const ERD_BADGE_W = 24

interface ElkNode {
	id: string
	width?: number
	height?: number
	x?: number
	y?: number
	layoutOptions?: Record<string, string>
	children?: ElkNode[]
	edges?: { id: string; sources: string[]; targets: string[] }[]
}

const ELK_DIRECTION = { down: 'DOWN', up: 'UP', right: 'RIGHT', left: 'LEFT' } as const

/** Badges drawn for a field's meta flags (pk / fk / uk / ...). */
export function fieldBadges(meta: string[] | undefined): string[] {
	return (meta ?? []).map((m) => (m === 'unique' ? 'uk' : m)).filter((m) => m.length <= 4).map((m) => m.toUpperCase())
}

/** Column metrics of an entity table; the renderer uses the same numbers. */
export function entityMetrics(node: IRNode, measure: Measure) {
	const fields = node.fields ?? []
	let nameW = 0
	let typeW = 0
	let badgeW = 0
	for (const f of fields) {
		nameW = Math.max(nameW, measure(f.name, ERD_FIELD_FONT).w)
		if (f.type) typeW = Math.max(typeW, measure(f.type, ERD_FIELD_FONT).w)
		badgeW = Math.max(badgeW, fieldBadges(f.meta).length * (ERD_BADGE_W + 4))
	}
	const head = measure(nodeLabel(node), ERD_HEAD_FONT).w + (node.icon ? ICON_SIZE + 6 : 0) + 28
	const body = 14 + nameW + (typeW ? 20 + typeW : 0) + (badgeW ? 14 + badgeW : 0) + 14
	const w = Math.round(Math.max(170, head, body))
	const h = ERD_HEAD_H + fields.length * ERD_ROW_H + (fields.length ? 4 : 0)
	return { w, h, nameX: 14, typeX: 14 + nameW + 20 }
}

export async function layoutErd(ir: DiagramIR, opts: LayoutOptions = {}): Promise<DiagramLayout> {
	const measure = opts.measureText ?? estimateText
	const nodes: Record<string, LaidOutNode> = {}
	const sizes = new Map(ir.nodes.map((n) => [n.key, entityMetrics(n, measure)]))
	const keys = [...sizes.keys()]
	const graph: ElkNode = {
		id: '__root__',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': ELK_DIRECTION[ir.direction] ?? 'RIGHT',
			'elk.spacing.nodeNode': '48',
			'elk.layered.spacing.nodeNodeBetweenLayers': '110',
			'elk.spacing.componentComponent': '70',
			'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
			'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
			'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
			'elk.padding': '[top=0,left=0,bottom=0,right=0]',
		},
		children: keys.map((k) => ({ id: k, width: sizes.get(k)!.w, height: sizes.get(k)!.h })),
		edges: ir.edges
			.filter((e) => e.from !== e.to && sizes.has(e.from) && sizes.has(e.to))
			.map((e, i) => ({ id: `${i}:${e.key}`, sources: [e.from], targets: [e.to] })),
	}
	let out: ElkNode | null = null
	try {
		out = await (await getElk()).layout(graph)
	} catch {
		out = null
	}
	const pos = new Map((out?.children ?? []).map((c) => [c.id, c]))
	let fx = 0
	for (const n of ir.nodes) {
		if (nodes[n.key]) continue
		const s = sizes.get(n.key)!
		const p = pos.get(n.key)
		const x = p?.x ?? fx
		if (!p) fx += s.w + 80
		nodes[n.key] = {
			key: n.key,
			x,
			y: p?.y ?? 0,
			w: s.w,
			h: s.h,
			isContainer: false,
			depth: 0,
			fields: (n.fields ?? []).map((f, i) => ({ name: f.name, y: ERD_HEAD_H + i * ERD_ROW_H, h: ERD_ROW_H })),
		}
	}
	const edges: Record<string, LaidOutEdge> = {}
	for (const e of ir.edges) {
		if (edges[e.key]) continue
		const r = routeErdEdge(e, nodes)
		if (r) edges[e.key] = r
	}
	return { nodes, edges, bounds: computeBounds(nodes, edges) }
}
