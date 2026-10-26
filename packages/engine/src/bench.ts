import { readFileSync } from 'node:fs'
import { layoutDiagram, parseOctoPages, type DiagramIR, type DiagramLayout } from '@octo-draw/core'
import { applyPins } from '@octo-draw/core/src/layout/layout'
import { EXAMPLES } from '../../../apps/web/src/examples'
import { routeEdges } from './route'
import { routeMetrics, type RouteMetrics } from './metrics'

export { syntheticOcto } from './synthetic'

/** One diagram page to compare routers on. */
export interface BenchCase {
	name: string
	ir: DiagramIR
}

export function benchCases(): BenchCase[] {
	const out: BenchCase[] = []
	const add = (prefix: string, code: string) => {
		for (const p of parseOctoPages(code).pages) {
			if (p.ir.kind === 'sequence' || !p.ir.edges.length) continue
			out.push({ name: p.name ? `${prefix}/${p.name}` : prefix, ir: p.ir })
		}
	}
	for (const ex of EXAMPLES) add(ex.id, ex.code)
	add('deep', readFileSync(new URL('../fixtures/deep.octo', import.meta.url), 'utf8'))
	return out
}

export interface BenchRow {
	name: string
	nodes: number
	edges: number
	elk: RouteMetrics & { ms: number }
	eraser: RouteMetrics & { ms: number; fallback: number }
	drag: {
		node: string
		/** core's applyPins: ELK layout with the dragged node's edges re-routed by core's simple router */
		elkPins: RouteMetrics & { ms: number }
		/** Eraser: only touched edges re-routed, the rest adopted (pinUnaffectedRoutes) */
		eraserPartial: RouteMetrics & { ms: number; rerouted: number; adopted: number; unchangedAdopted: boolean }
		/** Eraser: everything re-routed after the move, for reference */
		eraserFull: RouteMetrics & { ms: number }
	}
	deterministic: boolean
}

/** Pick the leaf node with the most edges (the most interesting thing to drag). */
function dragTarget(ir: DiagramIR): string {
	const deg = new Map<string, number>()
	for (const e of ir.edges) {
		deg.set(e.from, (deg.get(e.from) ?? 0) + 1)
		deg.set(e.to, (deg.get(e.to) ?? 0) + 1)
	}
	const leaves = ir.nodes.filter((n) => !n.isContainer && !ir.nodes.some((c) => c.parent === n.key))
	leaves.sort((a, b) => (deg.get(b.key) ?? 0) - (deg.get(a.key) ?? 0))
	return leaves[0].key
}

export async function runBench(c: BenchCase, repeats = 3): Promise<BenchRow> {
	let elkMs = Infinity
	let layout!: DiagramLayout
	for (let i = 0; i < repeats; i++) {
		const t = performance.now()
		layout = await layoutDiagram(c.ir)
		elkMs = Math.min(elkMs, performance.now() - t)
	}
	let full = routeEdges(layout, c.ir)
	let eraserMs = full.ms
	for (let i = 1; i < repeats; i++) {
		const again = routeEdges(layout, c.ir)
		eraserMs = Math.min(eraserMs, again.ms)
		full = again
	}
	const second = routeEdges(layout, c.ir)
	const deterministic = JSON.stringify(second.edges) === JSON.stringify(full.edges)

	// drag: move one node 200px right
	const node = dragTarget(c.ir)
	const box = layout.nodes[node]
	const t0 = performance.now()
	const pinned = applyPins(c.ir, layout, { [node]: { x: box.x + 200, y: box.y } })
	const pinMs = performance.now() - t0
	const partial = routeEdges(pinned, c.ir, { touched: { nodes: [node] }, previous: full.edges })
	const refull = routeEdges(pinned, c.ir)
	const adoptedKeys = Object.entries(partial.status).filter(([, s]) => s === 'adopted').map(([k]) => k)
	const unchangedAdopted = adoptedKeys.every((k) => JSON.stringify(partial.edges[k]?.points) === JSON.stringify(full.edges[k]?.points))
	return {
		name: c.name,
		nodes: c.ir.nodes.length,
		edges: c.ir.edges.length,
		elk: { ...routeMetrics(c.ir, layout), ms: elkMs },
		eraser: { ...routeMetrics(c.ir, layout, full.edges), ms: eraserMs, fallback: Object.values(full.status).filter((s) => s === 'fallback').length },
		drag: {
			node,
			elkPins: { ...routeMetrics(c.ir, pinned), ms: pinMs },
			eraserPartial: {
				...routeMetrics(c.ir, pinned, partial.edges),
				ms: partial.ms,
				rerouted: Object.values(partial.status).filter((s) => s !== 'adopted').length,
				adopted: adoptedKeys.length,
				unchangedAdopted,
			},
			eraserFull: { ...routeMetrics(c.ir, pinned, refull.edges), ms: refull.ms },
		},
		deterministic,
	}
}
