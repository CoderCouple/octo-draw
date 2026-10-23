import { layoutDiagram, parseOctoPages, printOcto, printPageName, type DiagramIR, type LayoutOptions } from '@octo-draw/core'
import { irToMdp, mdpToIr, type IrToMdpOptions, type MdpDoc } from './mdp'

/**
 * Proposed v2 file format: an envelope of pages, each page one MDP document (stock profile)
 * plus its `octo` sidecar. Drill-down links stay as `ext.drill` on the node's sidecar entry.
 */
export interface OctoDocumentPage {
	/** '' is the root page */
	name: string
	mdp: MdpDoc
}

export interface OctoDocument {
	format: 'octo-draw/mdp'
	version: 1
	/** The MDP profile the page bodies validate against. */
	profile: { name: 'eraser-stock'; version: '0.3.0' }
	title?: string
	pages: OctoDocumentPage[]
}

export async function toOctoDocument(src: string, opts: { layout?: LayoutOptions; mdp?: IrToMdpOptions } = {}): Promise<OctoDocument> {
	const { pages } = parseOctoPages(src)
	const out: OctoDocumentPage[] = []
	for (const p of pages) {
		const layout = await layoutDiagram(p.ir, opts.layout)
		out.push({ name: p.name, mdp: irToMdp(p.ir, layout, opts.mdp) })
	}
	const title = pages[0]?.ir.title
	return { format: 'octo-draw/mdp', version: 1, profile: { name: 'eraser-stock', version: '0.3.0' }, ...(title ? { title } : {}), pages: out }
}

/** Pages back to IR (geometry kept on `node.geometry`). */
export function fromOctoDocument(doc: OctoDocument): { name: string; ir: DiagramIR }[] {
	return doc.pages.map((p) => ({ name: p.name, ir: mdpToIr(p.mdp) }))
}

/** Pages back to octo DSL (geometry dropped: the DSL has no positions). */
export function octoDocumentToDsl(doc: OctoDocument): string {
	return fromOctoDocument(doc)
		.map(({ name, ir }) => {
			const clean: DiagramIR = { ...ir, nodes: ir.nodes.map(({ geometry: _g, ...n }) => n) }
			const body = printOcto(clean)
			return name ? `page ${printPageName(name)}\n${body}` : body
		})
		.join('\n')
}
