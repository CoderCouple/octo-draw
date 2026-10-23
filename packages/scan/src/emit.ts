/** Architecture graphs → DiagramIR → octo text with `page` sections. */

import { printOcto, type DiagramIR, type IREdge, type IRNode } from '@octo-draw/core'
import type { ArchGraph, ArchNode } from './types'

export interface EmittedPage {
	name: string
	ir: DiagramIR
}

export function graphToIR(g: ArchGraph, opts: { title?: string; source?: string } = {}): DiagramIR {
	const keys = new Set(g.nodes.map((n) => n.key))
	const nodes: IRNode[] = g.nodes.map((n: ArchNode) => {
		const ext: Record<string, string> = {}
		if (n.drill) ext.drill = n.drill
		if (n.src !== undefined) ext.src = n.src
		const out: IRNode = { key: n.key }
		if (n.label !== undefined && n.label !== n.key) out.label = n.label
		if (n.shape) out.shape = n.shape
		if (n.icon) out.icon = n.icon
		if (n.color) out.style = { color: n.color }
		if (n.parent && keys.has(n.parent) && n.parent !== n.key) out.parent = n.parent
		if (n.isContainer) out.isContainer = true
		if (n.link) out.link = n.link
		if (Object.keys(ext).length) out.ext = ext
		return out
	})
	const counts = new Map<string, number>()
	const edges: IREdge[] = []
	for (const e of g.edges) {
		if (!keys.has(e.from) || !keys.has(e.to)) continue
		const pair = `${e.from}->${e.to}`
		const n = counts.get(pair) ?? 0
		counts.set(pair, n + 1)
		edges.push({
			key: `${pair}#${n}`,
			from: e.from,
			to: e.to,
			label: e.label,
			arrow: { start: 'none', end: e.plain ? 'none' : 'arrow' },
			line: { dash: e.dotted ? 'dotted' : 'solid' },
		})
	}
	const ir: DiagramIR = { version: 1, kind: 'flowchart', direction: 'right', style: {}, title: opts.title, nodes, edges }
	if (opts.source) ir.source = opts.source
	return ir
}

/** Root page first (with title), then `page <Name>` sections. */
export function emitOcto(root: EmittedPage, pages: EmittedPage[], header: string[] = []): string {
	const parts: string[] = []
	const rootText = printOcto(root.ir).trimEnd()
	if (header.length) {
		// comments go right after the title line
		const lines = rootText.split('\n')
		const at = lines[0]?.startsWith('title ') ? 1 : 0
		lines.splice(at, 0, ...header.map((h) => `// ${h.replace(/\r?\n/g, ' ')}`))
		parts.push(lines.join('\n'))
	} else parts.push(rootText)
	for (const p of pages) parts.push(`page ${pageName(p.name)}\n${printOcto({ ...p.ir, title: undefined }).trimEnd()}`)
	return parts.join('\n\n') + '\n'
}

/** Page names are written bare when safe, quoted otherwise. */
export function pageName(name: string): string {
	const n = name.replace(/\r?\n/g, ' ')
	return /^\s|\s$|["[\]{},:]|\/\/|#/.test(n) || n === '' ? `"${n.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : n
}
