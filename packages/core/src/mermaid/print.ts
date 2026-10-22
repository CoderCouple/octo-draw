/** DiagramIR → mermaid `flowchart` text. */
import type { DiagramIR, IREdge, IRNode, NodeShape } from '../ir'
import { NAMED_COLORS, normalizeColor } from './parse'
import { sequenceToMermaid } from './sequence'
import { erdToMermaid } from './erd'

const DIR: Record<DiagramIR['direction'], string> = {
	down: 'TD',
	up: 'BT',
	right: 'LR',
	left: 'RL',
}

const RESERVED = new Set([
	'end',
	'subgraph',
	'graph',
	'flowchart',
	'style',
	'class',
	'classdef',
	'click',
	'linkstyle',
	'direction',
	'default',
	'call',
	'href',
])

const SHAPE_WRAP: Record<NodeShape, [string, string] | string> = {
	rectangle: ['[', ']'],
	oval: ['(', ')'],
	ellipse: ['((', '))'],
	diamond: ['{', '}'],
	cylinder: ['[(', ')]'],
	hexagon: ['{{', '}}'],
	parallelogram: ['[/', '/]'],
	trapezoid: ['[/', '\\]'],
	document: 'doc',
	triangle: 'tri',
	cloud: 'cloud',
	star: ['((', '))'],
}

function escLabel(s: string): string {
	return s.replace(/"/g, '#quot;').replace(/\|/g, '#124;').replace(/\r?\n/g, '<br>')
}

function isValidId(key: string): boolean {
	return /^[A-Za-z0-9_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*$/.test(key) && !RESERVED.has(key.toLowerCase())
}

function colorHex(c: string): string {
	return normalizeColor(c) ?? NAMED_COLORS[c.toLowerCase()] ?? c
}

export function toMermaid(ir: DiagramIR): string {
	if (ir.kind === 'sequence') return sequenceToMermaid(ir)
	if (ir.kind === 'erd') return erdToMermaid(ir)
	const ids = new Map<string, string>()
	const used = new Set<string>()
	const idFor = (key: string): string => {
		const known = ids.get(key)
		if (known) return known
		let base = isValidId(key) ? key : key.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'node'
		if (RESERVED.has(base.toLowerCase())) base = `${base}_`
		let id = base
		for (let n = 2; used.has(id); n++) id = `${base}_${n}`
		used.add(id)
		ids.set(key, id)
		return id
	}
	// Reserve ids in node order so valid keys keep their own id.
	for (const n of ir.nodes) if (isValidId(n.key)) idFor(n.key)
	for (const n of ir.nodes) idFor(n.key)

	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const containerKeys = new Set(ir.nodes.filter((n) => n.isContainer).map((n) => n.key))
	for (const n of ir.nodes) if (n.parent && byKey.has(n.parent)) containerKeys.add(n.parent)
	const children = new Map<string | undefined, IRNode[]>()
	for (const n of ir.nodes) {
		const p = n.parent && byKey.has(n.parent) && n.parent !== n.key ? n.parent : undefined
		const list = children.get(p) ?? []
		list.push(n)
		children.set(p, list)
	}

	const lines: string[] = []
	if (ir.title) lines.push('---', `title: ${JSON.stringify(ir.title)}`, '---')
	lines.push(`flowchart ${DIR[ir.direction] ?? 'TD'}`)

	const nodeDecl = (n: IRNode): string => {
		const id = idFor(n.key)
		const label = n.label ?? (id !== n.key ? n.key : undefined)
		if (!n.shape && label === undefined) return id
		const wrap = SHAPE_WRAP[n.shape ?? 'rectangle']
		const text = escLabel(label ?? n.key)
		if (typeof wrap === 'string') return `${id}@{ shape: ${wrap}${label !== undefined ? `, label: "${text}"` : ''} }`
		return `${id}${wrap[0]}"${text}"${wrap[1]}`
	}

	const visited = new Set<string>()
	const emit = (parent: string | undefined, depth: number) => {
		const indent = '\t'.repeat(depth)
		for (const n of children.get(parent) ?? []) {
			if (visited.has(n.key)) continue
			visited.add(n.key)
			if (containerKeys.has(n.key)) {
				const id = idFor(n.key)
				const label = n.label ?? (id !== n.key ? n.key : undefined)
				lines.push(`${indent}subgraph ${id}${label !== undefined ? ` ["${escLabel(label)}"]` : ''}`)
				emit(n.key, depth + 1)
				lines.push(`${indent}end`)
			} else {
				lines.push(indent + nodeDecl(n))
			}
		}
	}
	emit(undefined, 1)
	// Nodes in parent cycles never get visited from the root; emit them flat.
	for (const n of ir.nodes) if (!visited.has(n.key)) lines.push('\t' + nodeDecl(n))

	const edgeLine = (e: IREdge): string => {
		let from = e.from
		let to = e.to
		let start = e.arrow.start === 'arrow'
		let end = e.arrow.end === 'arrow'
		if (start && !end) {
			;[from, to] = [to, from]
			;[start, end] = [false, true]
		}
		const dotted = e.line.dash === 'dotted'
		const op = (start ? '<' : '') + (dotted ? (end ? '-.->' : '-.-') : end ? '-->' : '---')
		const label = e.label ? `|"${escLabel(e.label)}"|` : ''
		return `\t${idFor(from)} ${op}${label} ${idFor(to)}`
	}
	for (const e of ir.edges) lines.push(edgeLine(e))

	for (const n of ir.nodes) {
		const props: string[] = []
		if (n.style?.color) props.push(`fill:${colorHex(n.style.color)}`)
		if (n.style?.dash && n.style.dash !== 'solid') props.push('stroke-dasharray:5 5')
		if (props.length) lines.push(`\tstyle ${idFor(n.key)} ${props.join(',')}`)
	}
	ir.edges.forEach((e, i) => {
		if (e.style?.color) lines.push(`\tlinkStyle ${i} stroke:${colorHex(e.style.color)}`)
	})
	return lines.join('\n') + '\n'
}
