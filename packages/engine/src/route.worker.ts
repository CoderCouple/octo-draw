import type { DiagramIR, DiagramLayout } from '@octo-draw/core'
import { routeEdges, type RouteEdgesOptions } from './route'

/** Web Worker entry: `{ id, layout, ir, opts }` in, `{ id, result }` or `{ id, error }` out. */
export interface RouteRequest {
	id: number
	layout: DiagramLayout
	ir: DiagramIR
	opts?: Omit<RouteEdgesOptions, 'touched'> & { touched?: { nodes?: string[]; edges?: string[] } }
}

const ctx = self as unknown as { postMessage(msg: unknown): void; onmessage: ((ev: MessageEvent<RouteRequest>) => void) | null }

ctx.onmessage = (ev) => {
	const { id, layout, ir, opts } = ev.data
	try {
		ctx.postMessage({ id, result: routeEdges(layout, ir, opts) })
	} catch (err) {
		ctx.postMessage({ id, error: String((err as Error)?.stack ?? err) })
	}
}
