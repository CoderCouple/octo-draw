/** Structured description of a diagram for agents: IR (without source spans) plus summary stats. */

import { parseOcto, type DiagramIR } from '@octo-draw/core'

export interface DiagramStats {
	kind: DiagramIR['kind']
	direction: DiagramIR['direction']
	title?: string
	nodes: number
	groups: number
	edges: number
	labelledEdges: number
	/** Leaf nodes with no edges at all. */
	isolated: string[]
	/** Nodes with no incoming edges (entry points). */
	sources: string[]
	/** Nodes with no outgoing edges. */
	sinks: string[]
	/** Up to 5 most connected nodes. */
	hubs: { key: string; degree: number }[]
	maxDepth: number
	errors: number
	warnings: number
}

export function describeDiagram(code: string): { ir: DiagramIR; stats: DiagramStats; summary: string } {
	const { ir, diagnostics } = parseOcto(code)
	const clean: DiagramIR = {
		...ir,
		nodes: ir.nodes.map(({ span: _s, ...n }) => n),
		edges: ir.edges.map(({ span: _s, ...e }) => e),
	}
	const leaves = ir.nodes.filter((n) => !n.isContainer)
	const inDeg = new Map<string, number>()
	const outDeg = new Map<string, number>()
	for (const e of ir.edges) {
		outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1)
		inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
	}
	const deg = (k: string) => (inDeg.get(k) ?? 0) + (outDeg.get(k) ?? 0)
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const depth = (k: string) => {
		let d = 0
		for (let p = byKey.get(k)?.parent; p && d < 50; p = byKey.get(p)?.parent) d++
		return d
	}
	const connected = leaves.filter((n) => deg(n.key) > 0)
	const stats: DiagramStats = {
		kind: ir.kind,
		direction: ir.direction,
		title: ir.title,
		nodes: leaves.length,
		groups: ir.nodes.length - leaves.length,
		edges: ir.edges.length,
		labelledEdges: ir.edges.filter((e) => e.label).length,
		isolated: leaves.filter((n) => deg(n.key) === 0).map((n) => n.key),
		sources: connected.filter((n) => !inDeg.get(n.key)).map((n) => n.key),
		sinks: connected.filter((n) => !outDeg.get(n.key)).map((n) => n.key),
		hubs: connected
			.map((n) => ({ key: n.key, degree: deg(n.key) }))
			.sort((a, b) => b.degree - a.degree)
			.slice(0, 5),
		maxDepth: ir.nodes.reduce((m, n) => Math.max(m, depth(n.key)), 0),
		errors: diagnostics.filter((d) => d.severity === 'error').length,
		warnings: diagnostics.filter((d) => d.severity === 'warning').length,
	}
	const parts = [
		`${stats.title ? `"${stats.title}": ` : ''}${stats.kind}, direction ${stats.direction}`,
		`${stats.nodes} nodes, ${stats.groups} groups, ${stats.edges} edges (${stats.labelledEdges} labelled)`,
	]
	if (stats.sources.length) parts.push(`entry points: ${stats.sources.slice(0, 8).join(', ')}`)
	if (stats.hubs.length) parts.push(`most connected: ${stats.hubs.map((h) => `${h.key} (${h.degree})`).join(', ')}`)
	if (stats.isolated.length) parts.push(`unconnected: ${stats.isolated.slice(0, 8).join(', ')}`)
	if (stats.errors) parts.push(`${stats.errors} parse error${stats.errors > 1 ? 's' : ''}`)
	return { ir: clean, stats, summary: parts.join('; ') }
}
