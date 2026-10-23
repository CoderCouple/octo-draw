import { LayoutManager, routeCorridorConnectionBatch, type LayoutConnection, type LayoutEntity, type NewConnection } from '@eraserlabs/layout'
import type { DiagramIR, DiagramLayout, IREdge, LaidOutEdge, Point } from '@octo-draw/core'
import { EDGE_FONT_SIZE, GROUP_PADDING, estimateText } from '@octo-draw/core/src/layout/sizing'

/**
 * Adapter from octo's `DiagramLayout` (ELK placement) to Eraser's corridor router
 * (`@eraserlabs/layout`). Placement stays ours; only the polylines come from Eraser.
 *
 * - Entities: every laid-out node, absolute coordinates, `containerId` from IR `parent`,
 *   `isContainer` from the IR (or from having children).
 * - Group title rows are passed as container `textPlacement`, which the router treats as
 *   blocking, so lines don't run through the title.
 * - Edge labels are sized with core's text estimate and handed to the router (`labels: true`),
 *   which places them and returns `labelAt`.
 * - `repairTimeBudgetMs` defaults to Infinity: the router's repair phase is wall-clock bound
 *   (100 ms default), so a finite budget makes results machine-dependent.
 */

export interface RouteEdgesOptions {
	/**
	 * Only re-route these edge keys (plus edges touching these node keys). Everything else is
	 * adopted at its current geometry from `previous` (Eraser's `pinUnaffectedRoutes`).
	 */
	touched?: { nodes?: Iterable<string>; edges?: Iterable<string> }
	/** Existing routes to adopt for untouched edges. Defaults to `layout.edges`. */
	previous?: Record<string, LaidOutEdge>
	/** Router repair budget in ms. Default Infinity (deterministic). */
	repairTimeBudgetMs?: number
	/** Ask the router to place labels. Default true. */
	labels?: boolean
	/** Run the repair composition. Default true (the render pipeline uses it). */
	repair?: boolean
}

export interface RouteEdgesResult {
	edges: Record<string, LaidOutEdge>
	/** Router status per edge key: 'valid' corridor route or 'fallback' direct geometry. */
	status: Record<string, 'valid' | 'fallback' | 'adopted'>
	/** Edges skipped (missing endpoints, self loops, sequence diagrams). */
	skipped: string[]
	ms: number
}

/** Title band of a group, relative to the group's top-left: the router keeps lines out of it. */
function titleBand(w: number) {
	return { relativeX: 0, relativeY: 0, width: Math.max(1, Math.round(w)), height: GROUP_PADDING.top - 8 }
}

export function buildEntities(ir: DiagramIR, layout: DiagramLayout): LayoutEntity[] {
	const keys = new Set(Object.keys(layout.nodes))
	const parents = new Set(ir.nodes.filter((n) => n.parent && keys.has(n.parent)).map((n) => n.parent!))
	const out: LayoutEntity[] = []
	for (const n of ir.nodes) {
		const box = layout.nodes[n.key]
		if (!box) continue
		const isContainer = !!n.isContainer || parents.has(n.key)
		const e: LayoutEntity = {
			id: n.key,
			x: Math.round(box.x),
			y: Math.round(box.y),
			width: Math.max(1, Math.round(box.w)),
			height: Math.max(1, Math.round(box.h)),
			containerId: n.parent && keys.has(n.parent) ? n.parent : null,
		}
		if (isContainer) {
			e.isContainer = true
			e.textPlacement = titleBand(box.w)
		}
		out.push(e)
	}
	return out
}

function labelBox(e: IREdge) {
	if (!e.label) return undefined
	const m = estimateText(e.label, EDGE_FONT_SIZE)
	return { x: 0, y: 0, width: m.w + 8, height: m.h + 4 }
}

function routable(e: IREdge, keys: Set<string>) {
	return e.from !== e.to && keys.has(e.from) && keys.has(e.to)
}

function baseConnection(e: IREdge): NewConnection {
	return {
		id: e.key,
		from: e.from,
		to: e.to,
		fromArrowhead: e.arrow.start !== 'none',
		toArrowhead: e.arrow.end !== 'none',
	}
}

function toAdopted(e: IREdge, prev: LaidOutEdge): LayoutConnection | null {
	if (prev.points.length < 2) return null
	const [o] = prev.points
	return {
		...(baseConnection(e) as LayoutConnection),
		x: Math.round(o.x),
		y: Math.round(o.y),
		points: prev.points.map((p) => [Math.round(p.x - o.x), Math.round(p.y - o.y)] as [number, number]),
	}
}

function isOrthogonal(points: Point[]) {
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1]
		const b = points[i]
		if (Math.round(a.x) !== Math.round(b.x) && Math.round(a.y) !== Math.round(b.y)) return false
	}
	return true
}

/** Route (or re-route) the diagram's edges around its laid-out nodes with Eraser's corridor router. */
export function routeEdges(layout: DiagramLayout, ir: DiagramIR, opts: RouteEdgesOptions = {}): RouteEdgesResult {
	const t0 = performance.now()
	const entities = buildEntities(ir, layout)
	const keys = new Set(entities.map((e) => e.id))
	const edges = ir.kind === 'sequence' ? [] : ir.edges
	const skipped = (ir.kind === 'sequence' ? ir.edges : edges.filter((e) => !routable(e, keys))).map((e) => e.key)
	const live = edges.filter((e) => routable(e, keys))

	const previous = opts.previous ?? layout.edges
	let selected: IREdge[] = live
	const adopted: LayoutConnection[] = []
	if (opts.touched) {
		const tn = new Set(opts.touched.nodes ?? [])
		const te = new Set(opts.touched.edges ?? [])
		// moving a container moves its descendants: their edges are touched too
		const descendants = new Set(tn)
		let grew = true
		while (grew) {
			grew = false
			for (const n of ir.nodes) {
				if (n.parent && descendants.has(n.parent) && !descendants.has(n.key)) {
					descendants.add(n.key)
					grew = true
				}
			}
		}
		selected = []
		for (const e of live) {
			const prev = previous[e.key]
			const touched = te.has(e.key) || descendants.has(e.from) || descendants.has(e.to)
			// the router only adopts orthogonal polylines; anything else gets re-routed
			const adoptable = !touched && prev && prev.points.length >= 2 && isOrthogonal(prev.points)
			const a = adoptable ? toAdopted(e, prev) : null
			if (a) adopted.push(a)
			else selected.push(e)
		}
	}

	const manager = new LayoutManager({ entities, connections: adopted })
	const results = selected.length
		? routeCorridorConnectionBatch({
				layoutManager: manager,
				connectionsToRoute: selected.map((e) => {
					const lb = opts.labels === false ? undefined : labelBox(e)
					return { ...baseConnection(e), x: 0, y: 0, points: [], ...(lb ? { textPlacement: lb } : {}) }
				}),
				options: {
					repair: opts.repair ?? true,
					labels: opts.labels ?? true,
					pinUnaffectedRoutes: true,
					repairTimeBudgetMs: opts.repairTimeBudgetMs ?? Number.POSITIVE_INFINITY,
				},
			})
		: []

	const status: RouteEdgesResult['status'] = {}
	for (const a of adopted) status[a.id] = 'adopted'
	for (const r of results ?? []) status[r.connectionId] = r.status

	const out: Record<string, LaidOutEdge> = {}
	for (const c of manager.getConnections()) {
		const points = c.points.map(([x, y]) => ({ x: c.x + x, y: c.y + y }))
		if (points.length < 2) continue
		const tp = c.textPlacement
		const prev = status[c.id] === 'adopted' ? previous[c.id] : undefined
		out[c.id] = {
			key: c.id,
			points,
			...(tp ? { labelAt: { x: tp.x + tp.width / 2, y: tp.y + tp.height / 2 } } : prev?.labelAt ? { labelAt: prev.labelAt } : {}),
		}
	}
	return { edges: out, status, skipped, ms: performance.now() - t0 }
}
