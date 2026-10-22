/// <reference lib="webworker" />
import type { DiagramIR, DiagramLayout } from '@octo-draw/core'
import { layoutBase } from '@octo-draw/core/src/layout/layout'
import { makeMeasure } from './text'

// elkjs' bundled build assumes "no document + self" means it *is* ELK's own
// worker and takes over self.onmessage; a stub document keeps it in-process.
;(self as unknown as { document: object }).document ??= {}

export interface LayoutRequest {
	id: number
	ir: DiagramIR
}
export type LayoutResponse = { id: number; layout: DiagramLayout } | { id: number; error: string }

self.onmessage = async (e: MessageEvent<LayoutRequest>) => {
	const { id, ir } = e.data
	try {
		const layout = await layoutBase(ir, { measureText: makeMeasure(ir.style.typeface) })
		self.postMessage({ id, layout } satisfies LayoutResponse)
	} catch (err) {
		self.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies LayoutResponse)
	}
}
