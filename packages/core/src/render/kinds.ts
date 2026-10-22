/**
 * Headless renderers for the non-flowchart kinds: sequence diagrams and ERDs.
 * Mirrors apps/web/src/canvas/SequenceLayer.tsx and ErdLayer.tsx.
 */

import type { Cardinality, DiagramIR, DiagramLayout, IREdge, IRNode, LaidOutEdge, LaidOutNode, Point, SequenceLayout } from '../ir'
import { ICON_SIZE, type Measure } from '../layout/sizing'
import { ERD_FIELD_FONT, ERD_HEAD_FONT, entityMetrics, fieldBadges } from '../layout/erd'
import { ERD_HEAD_H } from '../layout/erdRoute'
import { edgeColor, groupColors, mix, nodeColors, resolveColor, SURFACES, type RenderTheme } from './colors'
import { arrowHead, roundedPolyline, roundedRect } from './geometry'
import type { IconResolver } from './svg'
import { el, escapeXml, f, iconGlyph, lines } from './xml'

export interface KindCtx {
	theme: RenderTheme
	mode: DiagramIR['style']['colorMode']
	measure: Measure
	filter?: string
	icon?: IconResolver
}

// ---------------------------------------------------------------------------
// Sequence

const NUM_W = 22

function participant(node: IRNode, box: LaidOutNode, c: KindCtx, foot: boolean) {
	const col = nodeColors(node.style?.color, c.mode, c.theme)
	const s = SURFACES[c.theme]
	const label = node.label ?? node.key
	const tw = c.measure(label, 14).w
	const total = node.icon ? ICON_SIZE + 8 + tw : tw
	const sx = box.w / 2 - total / 2
	const out = [
		el('path', { d: roundedRect(box.w, box.h, 8), fill: col.fill === 'none' ? s.bg : col.fill, 'fill-opacity': col.fill === 'none' ? 0.001 : undefined, stroke: col.stroke, 'stroke-width': c.mode === 'outline' ? 2 : 1.5, filter: c.filter }),
	]
	if (node.icon) out.push(iconGlyph(node.icon, sx, box.h / 2 - ICON_SIZE / 2, ICON_SIZE, col.icon, c.icon))
	out.push(el('text', { x: node.icon ? sx + ICON_SIZE + 8 : box.w / 2, y: box.h / 2, 'text-anchor': node.icon ? 'start' : 'middle', 'font-size': 14, 'font-weight': 500, fill: col.text, 'dominant-baseline': 'central' }, escapeXml(label)))
	return el('g', { 'data-node': foot ? undefined : node.key, 'data-foot': foot ? node.key : undefined, transform: `translate(${f(box.x)},${f(box.y)})` }, out)
}

function message(m: SequenceLayout['messages'][number], c: KindCtx) {
	const s = SURFACES[c.theme]
	const color = edgeColor(m.color, c.theme)
	const hasEnd = m.arrow.end === 'arrow'
	const hasStart = m.arrow.start === 'arrow'
	let d: string
	const heads: string[] = []
	if (m.self) {
		const y2 = m.y2 ?? m.y + 22
		const r = m.x1 + 34
		d = `M${f(m.x1)},${f(m.y)} H${f(r - 6)} Q${f(r)},${f(m.y)} ${f(r)},${f(m.y + 6)} V${f(y2 - 6)} Q${f(r)},${f(y2)} ${f(r - 6)},${f(y2)} H${f(m.x1 + (hasEnd ? 8 : 0))}`
		if (hasEnd) heads.push(arrowHead({ x: m.x1 + 20, y: y2 }, { x: m.x1, y: y2 }, 9))
	} else {
		const dir = Math.sign(m.x2 - m.x1) || 1
		d = `M${f(m.x1 + (hasStart ? dir * 8 : 0))},${f(m.y)} H${f(m.x2 - (hasEnd ? dir * 8 : 0))}`
		if (hasEnd) heads.push(arrowHead({ x: m.x1, y: m.y }, { x: m.x2, y: m.y }, 9))
		if (hasStart) heads.push(arrowHead({ x: m.x2, y: m.y }, { x: m.x1, y: m.y }, 9))
	}
	const out = [el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': m.dash === 'dotted' ? '6 5' : undefined, 'stroke-linecap': 'round' })]
	for (const h of heads) out.push(el('path', { d: h, fill: color, stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round' }))
	if (m.labelAt && (m.label || m.number !== undefined)) {
		const lw = m.label ? c.measure(m.label, 12) : { w: 0, h: 14 }
		const numbered = m.number !== undefined
		const total = lw.w + (numbered ? NUM_W : 0)
		const left = m.labelAt.x - total / 2
		const y = m.labelAt.y
		out.push(el('rect', { x: left - 4, y: y - lw.h / 2 - 1, width: total + 8, height: lw.h + 2, rx: 4, fill: s.bg, opacity: 0.85 }))
		if (numbered) {
			out.push(el('circle', { 'data-number': m.number, cx: left + 8, cy: y, r: 8, fill: color }))
			out.push(el('text', { x: left + 8, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 9.5, 'font-weight': 700, fill: s.bg }, String(m.number)))
		}
		if (m.label) out.push(lines(m.label, left + (numbered ? NUM_W : 0), y, 12, 500, s.text, 'start'))
	}
	return el('g', { 'data-message': m.index }, out)
}

function blockFrame(b: SequenceLayout['blocks'][number], c: KindCtx) {
	const s = SURFACES[c.theme]
	const tint = resolveColor(b.color)
	const g = groupColors(b.color, undefined, c.theme)
	const stroke = tint ? g.stroke : s.muted
	const text = tint ? g.text : s.groupText
	const tabFill = tint ? g.fill : s.groupFill
	const kwW = c.measure(b.type, 11).w + 16
	const tabH = 20
	const out = [
		el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, fill: tint ? mix(tabFill, s.bg, 0.5) : 'none', 'fill-opacity': tint ? 0.6 : undefined, stroke, 'stroke-width': 1.2 }),
		el('path', { d: `M${f(b.x + 6)},${f(b.y)} H${f(b.x + kwW)} V${f(b.y + tabH - 6)} L${f(b.x + kwW - 6)},${f(b.y + tabH)} H${f(b.x)} V${f(b.y + 6)} Q${f(b.x)},${f(b.y)} ${f(b.x + 6)},${f(b.y)} Z`, fill: tabFill, stroke, 'stroke-width': 1.2 }),
		el('text', { x: b.x + 8, y: b.y + tabH / 2, 'font-size': 11, 'font-weight': 700, fill: text, 'dominant-baseline': 'central' }, escapeXml(b.type)),
	]
	const first = b.sections[0]
	if (first?.label) out.push(el('text', { x: b.x + kwW + 10, y: b.y + tabH / 2, 'font-size': 12, 'font-weight': 500, fill: text, 'dominant-baseline': 'central' }, escapeXml(`[${first.label}]`)))
	for (const sec of b.sections.slice(1)) {
		out.push(el('line', { 'data-section': '', x1: b.x, y1: sec.y, x2: b.x + b.w, y2: sec.y, stroke, 'stroke-width': 1.1, 'stroke-dasharray': '6 4' }))
		if (sec.label) out.push(el('text', { x: b.x + 10, y: sec.y + 13, 'font-size': 12, 'font-weight': 500, fill: text, 'dominant-baseline': 'central' }, escapeXml(`[${sec.label}]`)))
	}
	return el('g', { 'data-block': b.type }, out)
}

export function renderSequence(ir: DiagramIR, layout: DiagramLayout, c: KindCtx): string[] {
	const seq = layout.sequence
	if (!seq) return []
	const s = SURFACES[c.theme]
	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const out: string[] = []
	for (const b of seq.blocks) out.push(blockFrame(b, c))
	for (const l of seq.lifelines) out.push(el('line', { 'data-lifeline': l.key, x1: l.x, y1: l.y1, x2: l.x, y2: l.y2, stroke: s.muted, 'stroke-width': 1.2, 'stroke-dasharray': '5 5', opacity: 0.7 }))
	for (const a of seq.activations) {
		const col = nodeColors(byKey.get(a.key)?.style?.color, c.mode === 'bold' ? 'pastel' : c.mode, c.theme)
		out.push(el('rect', { 'data-activation': a.key, x: a.x - 5, y: a.y1, width: 10, height: a.y2 - a.y1, rx: 2, fill: col.fill === 'none' ? s.bg : col.fill, stroke: col.stroke, 'stroke-width': 1.2 }))
	}
	for (const n of seq.notes) {
		const col = n.color ? nodeColors(n.color, 'pastel', c.theme) : { fill: s.groupFill, stroke: s.muted, text: s.text }
		const fold = 8
		out.push(
			el('g', { 'data-note': '', transform: `translate(${f(n.x)},${f(n.y)})` }, [
				el('path', { d: `M0,0 H${f(n.w - fold)} L${f(n.w)},${fold} V${f(n.h)} H0 Z`, fill: col.fill === 'none' ? s.bg : col.fill, stroke: col.stroke, 'stroke-width': 1 }),
				el('path', { d: `M${f(n.w - fold)},0 V${fold} H${f(n.w)}`, fill: 'none', stroke: col.stroke, 'stroke-width': 1 }),
				lines(n.text, n.w / 2, n.h / 2, 12, 500, col.text),
			]),
		)
	}
	for (const m of seq.messages) out.push(message(m, c))
	for (const p of seq.participants) {
		const box = layout.nodes[p.key]
		if (!box) continue
		const node = byKey.get(p.key) ?? { key: p.key }
		out.push(participant(node, box, c, false), participant(node, { ...box, y: p.footY }, c, true))
	}
	return out
}

// ---------------------------------------------------------------------------
// ERD

function entity(node: IRNode, box: LaidOutNode, c: KindCtx) {
	const s = SURFACES[c.theme]
	const tinted = !!resolveColor(node.style?.color)
	const col = nodeColors(node.style?.color, c.mode, c.theme)
	const headFill = tinted || c.mode === 'bold' ? col.fill : s.groupFill
	const headText = tinted || c.mode === 'bold' ? col.text : s.text
	const stroke = tinted ? col.stroke : s.nodeStroke
	const m = entityMetrics(node, c.measure)
	const fields = node.fields ?? []
	const rows = box.fields ?? []
	const r = 8
	const hasRows = rows.length > 0
	const out = [
		el('path', { d: roundedRect(box.w, box.h, r), fill: s.nodeFill, stroke, 'stroke-width': 1.4, filter: c.filter }),
		el('path', { d: hasRows ? `M0,${ERD_HEAD_H} V${r} Q0,0 ${r},0 H${f(box.w - r)} Q${f(box.w)},0 ${f(box.w)},${r} V${ERD_HEAD_H} Z` : roundedRect(box.w, box.h, r), fill: headFill === 'none' ? s.nodeFill : headFill, stroke: 'none' }),
	]
	if (hasRows) out.push(el('line', { x1: 0, y1: ERD_HEAD_H, x2: box.w, y2: ERD_HEAD_H, stroke, 'stroke-width': 1.2 }))
	out.push(el('path', { d: roundedRect(box.w, box.h, r), fill: 'none', stroke, 'stroke-width': 1.4 }))
	if (node.icon) out.push(iconGlyph(node.icon, 12, ERD_HEAD_H / 2 - 9, 18, tinted ? col.icon : headText, c.icon))
	out.push(el('text', { x: node.icon ? 38 : 14, y: ERD_HEAD_H / 2, 'font-size': ERD_HEAD_FONT, 'font-weight': 650, fill: headText, 'dominant-baseline': 'central' }, escapeXml(node.label ?? node.key)))
	rows.forEach((row, i) => {
		const fld = fields.find((x) => x.name === row.name) ?? fields[i]
		if (!fld) return
		const cy = row.y + row.h / 2
		const badges = fieldBadges(fld.meta)
		const parts: string[] = []
		if (i > 0) parts.push(el('line', { x1: 10, y1: row.y, x2: box.w - 10, y2: row.y, stroke: s.labelBorder, 'stroke-width': 1 }))
		parts.push(el('text', { x: m.nameX, y: cy, 'font-size': ERD_FIELD_FONT, 'font-weight': badges.includes('PK') ? 650 : 500, fill: s.text, 'dominant-baseline': 'central' }, escapeXml(fld.name)))
		if (fld.type) parts.push(el('text', { x: m.typeX, y: cy, 'font-size': ERD_FIELD_FONT, fill: s.muted, 'dominant-baseline': 'central' }, escapeXml(fld.type)))
		badges.forEach((b, j) => {
			const bx = box.w - 12 - (badges.length - j) * 28 + 4
			parts.push(
				el('g', { 'data-badge': b, transform: `translate(${f(bx)},${f(cy - 8)})` }, [
					el('rect', { width: 24, height: 16, rx: 4, fill: b === 'PK' ? s.text : 'none', stroke: b === 'PK' ? s.text : s.muted, 'stroke-width': 1 }),
					el('text', { x: 12, y: 8.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 8.5, 'font-weight': 700, fill: b === 'PK' ? s.bg : s.muted }, escapeXml(b)),
				]),
			)
		})
		out.push(el('g', { 'data-field': fld.name }, parts))
	})
	return el('g', { 'data-node': node.key, transform: `translate(${f(box.x)},${f(box.y)})` }, out)
}

const unit = (a: Point, b: Point) => {
	const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
	return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

/** Crow's-foot marker at `tip` (on the entity border); `toward` is the next point along the line. */
export function crowsFoot(tip: Point, toward: Point, many: boolean): string {
	const u = unit(tip, toward)
	const v = { x: -u.y, y: u.x }
	const at = (d: number, side: number) => `${f(tip.x + u.x * d + v.x * side)},${f(tip.y + u.y * d + v.y * side)}`
	let d = `M${at(18, -6)} L${at(18, 6)}`
	if (many) d += ` M${at(0, -7)} L${at(13, 0)} L${at(0, 7)} M${at(0, 0)} L${at(13, 0)}`
	else d += ` M${at(12, -6)} L${at(12, 6)}`
	return d
}

function relationship(edge: IREdge, laid: LaidOutEdge, c: KindCtx, notation: 'crows-feet' | 'chen') {
	const s = SURFACES[c.theme]
	const color = edgeColor(edge.style?.color, c.theme)
	const pts = laid.points
	if (pts.length < 2) return ''
	const card: Cardinality = edge.cardinality ?? '1-1'
	const fromMany = card[0] === 'n'
	const toMany = card[2] === 'n'
	const dash = edge.style?.dash ?? edge.line.dash
	const [a, a2, b2, b] = [pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]]
	const out = [el('path', { d: roundedPolyline(pts, 8), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': dash === 'dotted' ? '2 5' : dash === 'dashed' ? '7 5' : undefined, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })]
	if (notation === 'crows-feet') {
		out.push(el('path', { 'data-cardinality': card, d: `${crowsFoot(a, a2, fromMany)} ${crowsFoot(b, b2, toMany)}`, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
	} else {
		const tag = (tip: Point, toward: Point, many: boolean, alt: boolean) => {
			const u = unit(tip, toward)
			return el('text', { x: tip.x + u.x * 14 - u.y * 10, y: tip.y + u.y * 14 + u.x * 10, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 11, 'font-weight': 700, fill: color }, many ? (alt ? 'M' : 'N') : '1')
		}
		out.push(tag(a, a2, fromMany, false), tag(b, b2, toMany, fromMany))
	}
	if (edge.label && laid.labelAt) {
		const m = c.measure(edge.label, 12)
		const shape =
			notation === 'chen'
				? el('path', { d: `M${f(-m.w / 2 - 18)},0 L0,${f(-m.h / 2 - 10)} L${f(m.w / 2 + 18)},0 L0,${f(m.h / 2 + 10)} Z`, fill: s.labelBg, stroke: color, 'stroke-width': 1.2 })
				: el('rect', { x: -m.w / 2 - 6, y: -m.h / 2 - 3, width: m.w + 12, height: m.h + 6, rx: (m.h + 6) / 2, fill: s.labelBg, stroke: s.labelBorder, 'stroke-width': 1 })
		out.push(el('g', { transform: `translate(${f(laid.labelAt.x)},${f(laid.labelAt.y)})` }, [shape, el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 12, 'font-weight': 500, fill: s.text }, escapeXml(edge.label))]))
	}
	return el('g', { 'data-edge': edge.key }, out)
}

export function renderErd(ir: DiagramIR, layout: DiagramLayout, c: KindCtx): string[] {
	const notation = ir.erd?.notation ?? 'crows-feet'
	const out: string[] = []
	for (const e of ir.edges) {
		const le = layout.edges[e.key]
		if (le) out.push(relationship(e, le, c, notation))
	}
	for (const n of ir.nodes) {
		const box = layout.nodes[n.key]
		if (box) out.push(entity(n, box, c))
	}
	return out
}
