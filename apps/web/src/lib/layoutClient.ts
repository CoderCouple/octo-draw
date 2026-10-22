import type { DiagramIR, DiagramLayout } from '@octo-draw/core'
import type { LayoutRequest, LayoutResponse } from './layout.worker'
import { layoutBase } from '@octo-draw/core/src/layout/layout'
import { makeMeasure } from './text'

let worker: Worker | null = null
let failed = false
let seq = 0
const waiting = new Map<number, { resolve: (l: DiagramLayout) => void; reject: (e: Error) => void }>()

function getWorker(): Worker | null {
	if (worker || failed) return worker
	try {
		worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })
		worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
			const w = waiting.get(e.data.id)
			if (!w) return
			waiting.delete(e.data.id)
			if ('layout' in e.data) w.resolve(e.data.layout)
			else w.reject(new Error(e.data.error))
		}
		worker.onerror = (e) => {
			console.warn('layout worker failed; laying out on the main thread', e.message)
			failed = true
			worker?.terminate()
			worker = null
			for (const w of waiting.values()) w.reject(new Error('worker crashed'))
			waiting.clear()
		}
	} catch {
		failed = true
		worker = null
	}
	return worker
}

/** ELK layout off the main thread (falls back to a lazily loaded in-thread ELK). */
export async function layoutInWorker(ir: DiagramIR): Promise<DiagramLayout> {
	const w = getWorker()
	if (w) {
		try {
			return await new Promise<DiagramLayout>((resolve, reject) => {
				const id = ++seq
				waiting.set(id, { resolve, reject })
				w.postMessage({ id, ir } satisfies LayoutRequest)
			})
		} catch (err) {
			if (!failed) throw err
		}
	}
	return layoutBase(ir, { measureText: makeMeasure(ir.style.typeface) })
}
