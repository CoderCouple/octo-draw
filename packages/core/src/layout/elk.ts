/**
 * Lazily loaded ELK engine shared by every layout. The dynamic import keeps
 * the ~1.4 MB elkjs bundle out of anything that only parses/prints DSL, and
 * lets bundlers split it into its own chunk (the web app runs it in a worker).
 */

export interface ElkEngine {
	/** Each caller passes its own structural ELK graph type. */
	layout: <G>(g: G) => Promise<G>
}

let engine: Promise<ElkEngine> | null = null

export function getElk(): Promise<ElkEngine> {
	if (!engine) {
		engine = import('elkjs/lib/elk.bundled.js').then((m) => {
			const ELK = ((m as { default?: unknown }).default ?? m) as new () => ElkEngine
			return new ELK()
		})
		engine.catch(() => {
			engine = null
		})
	}
	return engine
}
