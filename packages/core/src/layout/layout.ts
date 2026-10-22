import type {
	DiagramIR,
	DiagramLayout,
	Direction,
	IREdge,
	LaidOutEdge,
	LaidOutNode,
	LayoutOptions,
	Point,
} from '../ir'
import { nearestOnPolyline } from './route'
import { clipToShapes } from './clip'
import { applyPins, buildHierarchy, computeBounds, routeEdge, type Hierarchy } from './pins'
import { layoutSequence } from './sequence'
import { layoutErd } from './erd'
import { EDGE_FONT_SIZE, GROUP_FONT_SIZE, GROUP_PADDING, estimateText, nodeLabel, nodeSize, type Measure } from './sizing'

interface ElkLabel {
	text: string
	width: number
	height: number
	x?: number
	y?: number
}
interface ElkEdge {
	id: string
	sources: string[]
	targets: string[]
	labels?: ElkLabel[]
	sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[]
}
interface ElkNode {
	id: string
	width?: number
	height?: number
	x?: number
	y?: number
	layoutOptions?: Record<string, string>
	children?: ElkNode[]
	edges?: ElkEdge[]
}

import { getElk } from './elk'

export { applyPins, buildHierarchy, type Hierarchy } from './pins'

const ELK_DIRECTION: Record<Direction, string> = { down: 'DOWN', up: 'UP', right: 'RIGHT', left: 'LEFT' }

const SPACING: Record<string, string> = {
	'elk.spacing.nodeNode': '40',
	'elk.layered.spacing.nodeNodeBetweenLayers': '64',
	'elk.spacing.edgeNode': '20',
	'elk.spacing.edgeEdge': '14',
	'elk.layered.spacing.edgeNodeBetweenLayers': '24',
	'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
	'elk.spacing.edgeLabel': '4',
	'elk.spacing.componentComponent': '60',
}

/**
 * Lays out a diagram with ELK's layered algorithm: compound groups are laid
 * out hierarchically (one pass, edges may cross group borders), edges are
 * routed orthogonally, and everything comes back in absolute coordinates.
 * Nodes in `opts.pinned` are then moved to their pinned top-left (containers
 * carry their children), ancestors are refit, and touched edges re-routed.
 */
export async function layoutDiagram(ir: DiagramIR, opts: LayoutOptions = {}): Promise<DiagramLayout> {
	const base = await layoutBase(ir, opts)
	return opts.pinned && Object.keys(opts.pinned).length ? applyPins(ir, base, opts.pinned) : base
}

/** The ELK pass alone (no pins). */
export async function layoutBase(ir: DiagramIR, opts: LayoutOptions = {}): Promise<DiagramLayout> {
	if (ir.kind === 'sequence') return layoutSequence(ir, opts)
	if (ir.kind === 'erd') return layoutErd(ir, opts)
	const measure = opts.measureText ?? estimateText
	const direction = ir.direction ?? 'down'
	const h = buildHierarchy(ir)

	const buildNode = (key: string): ElkNode => {
		const node = h.byKey.get(key)!
		const kids = h.childrenOf.get(key)
		if (h.isContainer(key)) {
			const title = measure(nodeLabel(node), GROUP_FONT_SIZE)
			const minW = Math.ceil(Math.max(160, title.w + (node.icon ? 28 : 0) + GROUP_PADDING.left + GROUP_PADDING.right))
			const elk: ElkNode = {
				id: key,
				layoutOptions: {
					'elk.padding': `[top=${GROUP_PADDING.top},left=${GROUP_PADDING.left},bottom=${GROUP_PADDING.bottom},right=${GROUP_PADDING.right}]`,
					'elk.direction': ELK_DIRECTION[direction],
					'elk.nodeSize.constraints': 'MINIMUM_SIZE',
					'elk.nodeSize.minimum': `(${minW}, ${kids?.length ? 60 : 90})`,
					...SPACING,
				},
				children: (kids ?? []).map(buildNode),
			}
			if (!kids?.length) {
				elk.width = minW
				elk.height = 90
			}
			return elk
		}
		const size = nodeSize(node, measure)
		return { id: key, width: size.w, height: size.h }
	}
	const roots = ir.nodes.filter((n) => !h.parentOf.has(n.key)).map((n) => n.key)

	const elkEdges: IREdge[] = []
	const manualEdges: IREdge[] = []
	const seen = new Set<string>()
	for (const e of ir.edges) {
		if (!h.byKey.has(e.from) || !h.byKey.has(e.to) || seen.has(e.key)) continue
		seen.add(e.key)
		// ELK rejects edges between a container and its own descendants
		if (h.nested(e.from, e.to)) manualEdges.push(e)
		else elkEdges.push(e)
	}

	const graph: ElkNode = {
		id: '__root__',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': ELK_DIRECTION[direction],
			'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
			'elk.edgeRouting': 'ORTHOGONAL',
			'elk.json.edgeCoords': 'ROOT',
			'elk.json.shapeCoords': 'ROOT',
			'elk.edgeLabels.placement': 'CENTER',
			'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
			'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
			'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
			'elk.padding': '[top=0,left=0,bottom=0,right=0]',
			...SPACING,
		},
		children: roots.map(buildNode),
		edges: elkEdges.map((e) => {
			const edge: ElkEdge = { id: e.key, sources: [e.from], targets: [e.to] }
			if (e.label) {
				const m = measure(e.label, EDGE_FONT_SIZE)
				edge.labels = [{ text: e.label, width: m.w + 12, height: m.h + 6 }]
			}
			return edge
		}),
	}

	const nodes: Record<string, LaidOutNode> = {}
	const edges: Record<string, LaidOutEdge> = {}

	let out: ElkNode | null = null
	try {
		out = await (await getElk()).layout(graph)
	} catch {
		out = null
	}

	if (out) {
		const walk = (n: ElkNode) => {
			if (n.id !== '__root__') {
				nodes[n.id] = {
					key: n.id,
					x: n.x ?? 0,
					y: n.y ?? 0,
					w: n.width ?? 0,
					h: n.height ?? 0,
					isContainer: h.isContainer(n.id),
					depth: h.depth(n.id),
				}
			}
			n.children?.forEach(walk)
		}
		walk(out)
		const edgeById = new Map(elkEdges.map((e) => [e.key, e]))
		for (const e of out.edges ?? []) {
			const sections = e.sections ?? []
			if (!sections.length) continue
			const points: Point[] = []
			for (const s of sections) {
				if (!points.length) points.push(s.startPoint)
				points.push(...(s.bendPoints ?? []), s.endPoint)
			}
			const lbl = e.labels?.[0]
			const irEdge = edgeById.get(e.id)
			const pts = clipToShapes(
				points.map((p) => ({ x: p.x, y: p.y })),
				irEdge && nodes[irEdge.from],
				irEdge && nodes[irEdge.to],
				irEdge && h.byKey.get(irEdge.from)?.shape,
				irEdge && h.byKey.get(irEdge.to)?.shape,
			)
			// ELK puts labels beside the line; snap them onto it (drawn with a background chip)
			const labelAt =
				lbl && lbl.x !== undefined && lbl.y !== undefined
					? nearestOnPolyline(pts, { x: lbl.x + lbl.width / 2, y: lbl.y + lbl.height / 2 })
					: undefined
			edges[e.id] = { key: e.id, points: pts, labelAt }
		}
	} else {
		fallbackGrid(roots, h, measure, nodes)
	}

	for (const e of [...manualEdges, ...elkEdges]) {
		if (!edges[e.key]) {
			const r = routeEdge(e, nodes, h, direction)
			if (r) edges[e.key] = r
		}
	}
	return { nodes, edges, bounds: computeBounds(nodes, edges) }
}

/** Used only if ELK throws: rows of nodes, containers wrapping theirs. */
function fallbackGrid(roots: string[], h: Hierarchy, measure: Measure, out: Record<string, LaidOutNode>) {
	const place = (key: string, x: number, y: number): LaidOutNode => {
		if (!h.isContainer(key)) {
			const s = nodeSize(h.byKey.get(key)!, measure)
			return (out[key] = { key, x, y, w: s.w, h: s.h, isContainer: false, depth: h.depth(key) })
		}
		let cx = x + GROUP_PADDING.left
		let maxH = 0
		for (const c of h.childrenOf.get(key) ?? []) {
			const b = place(c, cx, y + GROUP_PADDING.top)
			cx += b.w + 40
			maxH = Math.max(maxH, b.h)
		}
		const w = Math.max(160, cx - 40 - x + GROUP_PADDING.right)
		const hh = Math.max(90, maxH + GROUP_PADDING.top + GROUP_PADDING.bottom)
		return (out[key] = { key, x, y, w, h: hh, isContainer: true, depth: h.depth(key) })
	}
	let x = 0
	for (const r of roots) x += place(r, x, 0).w + 60
}
