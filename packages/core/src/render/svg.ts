/**
 * Headless SVG renderer: DiagramIR + DiagramLayout (+ optional freehand
 * shapes) → a standalone SVG string. No DOM, no fonts loaded, no network —
 * usable from the server, the CLI and tests to produce thumbnails/exports.
 *
 * The output mirrors the web canvas (apps/web/src/canvas/DiagramLayer.tsx):
 * monochrome surfaces, hue tints for `color:` props, groups behind edges
 * behind nodes, freehand layer on top.
 */

import type { DiagramIR, DiagramLayout, IREdge, IRNode, LaidOutEdge, LaidOutNode } from '../ir'
import type { FreeShape } from '../free'
import { freeShapeBounds, freeSizeFor } from '../free'
import { estimateText, ICON_SIZE, iconPlacement, type Measure } from '../layout/sizing'
import { parseOcto } from '../dsl/parse'
import { layoutDiagram } from '../layout/layout'
import type { OctoDocument } from '../doc'
import { edgeColor, FONT_STACK, groupColors, inkColor, nodeColors, SURFACES, type RenderTheme } from './colors'
import { el, escapeXml, f, iconGlyph, lines, type Attrs } from './xml'
import { renderErd, renderSequence } from './kinds'
import { resolveIcon, type ResolvedIcon } from '../icons'
import { approachPoint, arrowHead, contentCenterY, roundedPolyline, roundedRect, shapePath, trimPolyline } from './geometry'

export { escapeXml } from './xml'

/** lucide-style icon node: a list of [tag, attributes] drawn in a 24×24 box. */
export type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][]

/** Maps a DSL icon name to a catalog icon (`resolveIcon`) or a raw lucide-style node; null → text badge. */
export type IconResolver = (name: string) => ResolvedIcon | IconNode | null | undefined

export interface RenderSvgOptions {
	theme?: RenderTheme
	/** Freehand shapes drawn on top of the diagram. */
	shapes?: FreeShape[]
	/** Space around the content, in px. Default 32. */
	padding?: number
	/** Fill the background with the theme color. Default true. */
	background?: boolean
	/**
	 * Resolve icon names to vector icons. Defaults to the built-in catalog
	 * (`resolveIcon`); `false` draws every icon as a text badge. Unknown names
	 * always render as a text badge.
	 */
	icon?: IconResolver | false
	/**
	 * Official vendor icons (registered icon packs) keep their vendor colors by
	 * default, even in monochrome themes; 'grayscale' desaturates them.
	 */
	officialIcons?: 'color' | 'grayscale'
	/** Text measurement (should match what layout used). Defaults to the headless estimate. */
	measureText?: Measure
	/** Output scale: width/height attributes are multiplied, viewBox is not. Default 1. */
	scale?: number
	/** Accessible title (<title>); defaults to the diagram title. */
	title?: string
}

interface Ctx {
	theme: RenderTheme
	mode: DiagramIR['style']['colorMode']
	measure: Measure
	filter?: string
	icon?: IconResolver
	/** Grayscale official vendor icons. */
	grayscale?: boolean
}

/** `color: brand` keeps the node surface neutral and draws its icon in the brand color. */
const isBrand = (color: string | undefined) => color?.trim().toLowerCase() === 'brand'

function renderNode(node: IRNode, box: LaidOutNode, c: Ctx) {
	const col = nodeColors(node.style?.color, c.mode, c.theme)
	const bg = SURFACES[c.theme].bg
	const { d, detail } = shapePath(node.shape, box.w, box.h)
	const label = node.label ?? node.key
	const cy = contentCenterY(node.shape, box.h)
	const size = 14
	const glyph = { brand: isBrand(node.style?.color), background: col.fill === 'none' ? bg : col.fill, grayscale: c.grayscale }
	const out: string[] = [
		el('path', { d, fill: col.fill === 'none' ? bg : col.fill, 'fill-opacity': col.fill === 'none' ? 0.001 : undefined, stroke: col.stroke, 'stroke-width': c.mode === 'outline' ? 2 : 1.5, filter: c.filter }),
	]
	if (detail) out.push(el('path', { d: detail, fill: 'none', stroke: col.stroke, 'stroke-width': 1.5 }))
	if (node.icon && iconPlacement(node.shape) === 'left') {
		const textW = c.measure(label, size).w
		const sx = box.w / 2 - (ICON_SIZE + 8 + textW) / 2
		out.push(iconGlyph(node.icon, sx, cy - ICON_SIZE / 2, ICON_SIZE, col.icon, c.icon, glyph))
		out.push(lines(label, sx + ICON_SIZE + 8, cy, size, 500, col.text, 'start'))
	} else if (node.icon) {
		const textH = label.split('\n').length * size * 1.3
		const top = cy - (ICON_SIZE + 6 + textH) / 2
		out.push(iconGlyph(node.icon, box.w / 2 - ICON_SIZE / 2, top, ICON_SIZE, col.icon, c.icon, glyph))
		out.push(lines(label, box.w / 2, top + ICON_SIZE + 6 + textH / 2, size, 500, col.text))
	} else {
		out.push(lines(label, box.w / 2, cy, size, 500, col.text))
	}
	const inner = el('g', { 'data-node': node.key, transform: `translate(${f(box.x)},${f(box.y)})` }, out)
	return node.link ? el('a', { href: node.link }, inner) : inner
}

function renderGroup(node: IRNode, box: LaidOutNode, c: Ctx) {
	const col = groupColors(node.style?.color, c.mode, c.theme)
	const bg = SURFACES[c.theme].bg
	const label = node.label ?? node.key
	const dotted = node.style?.dash === 'dotted' || node.ext?.dash === 'dotted'
	const out = [
		el('path', { d: roundedRect(box.w, box.h, 12), fill: col.fill === 'none' ? bg : col.fill, 'fill-opacity': col.fill === 'none' ? 0.001 : undefined, stroke: col.stroke, 'stroke-width': 1.2, 'stroke-dasharray': dotted ? '4 4' : undefined }),
	]
	if (node.icon) out.push(iconGlyph(node.icon, 14, 11, 16, col.text, c.icon, { brand: isBrand(node.style?.color), background: col.fill === 'none' ? bg : col.fill, grayscale: c.grayscale }))
	out.push(el('text', { x: 14 + (node.icon ? 22 : 0), y: 19, 'font-size': 13, 'font-weight': 600, fill: col.text, 'dominant-baseline': 'central' }, escapeXml(label)))
	return el('g', { 'data-group': node.key, transform: `translate(${f(box.x)},${f(box.y)})` }, out)
}

function renderEdge(edge: IREdge, laid: LaidOutEdge, c: Ctx) {
	const pts = laid.points
	if (pts.length < 2) return ''
	const s = SURFACES[c.theme]
	const color = edgeColor(edge.style?.color, c.theme)
	const hasEnd = edge.arrow.end === 'arrow'
	const hasStart = edge.arrow.start === 'arrow'
	const line = trimPolyline(pts, hasStart ? 6 : 0, hasEnd ? 6 : 0)
	const dash = edge.style?.dash ?? edge.line.dash
	const out = [
		el('path', { d: roundedPolyline(line, 10), fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': dash === 'dotted' ? '1.5 5' : dash === 'dashed' ? '7 5' : undefined, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
	]
	if (hasEnd) out.push(el('path', { d: arrowHead(approachPoint(pts, true), pts[pts.length - 1], 10), fill: color, stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round' }))
	if (hasStart) out.push(el('path', { d: arrowHead(approachPoint(pts, false), pts[0], 10), fill: color, stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round' }))
	if (edge.label && laid.labelAt) {
		const m = c.measure(edge.label, 12)
		out.push(
			el('g', { transform: `translate(${f(laid.labelAt.x)},${f(laid.labelAt.y)})` }, [
				el('rect', { x: -m.w / 2 - 6, y: -m.h / 2 - 3, width: m.w + 12, height: m.h + 6, rx: (m.h + 6) / 2, fill: s.labelBg, stroke: s.labelBorder, 'stroke-width': 1 }),
				lines(edge.label, 0, 0, 12, 500, s.text),
			]),
		)
	}
	return el('g', { 'data-edge': edge.key }, out)
}

/** Smooth centerline through pen points (quadratic through midpoints). */
function penPath(points: [number, number, number][]) {
	if (points.length === 1) {
		const [x, y] = points[0]
		return `M${f(x)},${f(y)} L${f(x + 0.01)},${f(y)}`
	}
	let d = `M${f(points[0][0])},${f(points[0][1])}`
	for (let i = 1; i < points.length - 1; i++) {
		const [x0, y0] = points[i]
		const [x1, y1] = points[i + 1]
		d += ` Q${f(x0)},${f(y0)} ${f((x0 + x1) / 2)},${f((y0 + y1) / 2)}`
	}
	const last = points[points.length - 1]
	return d + ` L${f(last[0])},${f(last[1])}`
}

/** Pastel fill for a sticky note: the ink color washed toward white (default yellow). */
export function stickyFill(color: string): string {
	const hex = color === 'ink' || !color.startsWith('#') ? '#facc15' : color
	if (hex.length !== 7) return '#FEF3A0'
	const m = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.32 + 255 * 0.68)
	return `rgb(${m(1)}, ${m(3)}, ${m(5)})`
}

/** Greedy word wrap with the headless text estimate. */
function wrap(text: string, maxW: number, size: number): string[] {
	const out: string[] = []
	for (const para of text.split('\n')) {
		let line = ''
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const next = line ? `${line} ${word}` : word
			if (!line || estimateText(next, size).w <= maxW) line = next
			else {
				out.push(line)
				line = word
			}
		}
		out.push(line)
	}
	return out
}

function renderFreeShape(s: FreeShape, theme: RenderTheme, fontFamily: string) {
	const color = inkColor(s.color, theme)
	const sw = freeSizeFor(s.type, s.size)
	const base = { 'data-shape': s.id, 'data-type': s.type }
	switch (s.type) {
		case 'pen':
			if (!s.points?.length) return ''
			return el('path', { ...base, d: penPath(s.points), fill: 'none', stroke: color, 'stroke-width': sw * 0.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
		case 'rect': {
			const b = freeShapeBounds(s)
			return el('rect', { ...base, x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, fill: 'none', stroke: color, 'stroke-width': sw })
		}
		case 'ellipse': {
			const b = freeShapeBounds(s)
			return el('ellipse', { ...base, cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, fill: 'none', stroke: color, 'stroke-width': sw })
		}
		case 'arrow': {
			const p = s.points
			if (!p || p.length < 2) return ''
			const a = { x: p[0][0], y: p[0][1] }
			const b = { x: p[p.length - 1][0], y: p[p.length - 1][1] }
			const line = trimPolyline([a, b], 0, sw * 2)
			return el('g', base, [
				el('path', { d: `M${f(line[0].x)},${f(line[0].y)} L${f(line[1].x)},${f(line[1].y)}`, stroke: color, 'stroke-width': sw, 'stroke-linecap': 'round', fill: 'none' }),
				el('path', { d: arrowHead(a, b, 8 + sw * 2), fill: color, stroke: color, 'stroke-width': 1, 'stroke-linejoin': 'round' }),
			])
		}
		case 'text': {
			const size = sw * (s.scale ?? 1)
			const ls = (s.text ?? '').split('\n')
			return el(
				'text',
				{ ...base, x: s.x, y: s.y, 'font-size': size, 'font-family': fontFamily, 'font-weight': 500, fill: color },
				ls.map((l, i) => el('tspan', { x: s.x, y: s.y + size * 1.25 * i + size }, escapeXml(l) || ' ')),
			)
		}
		case 'sticky': {
			const b = freeShapeBounds(s)
			const pad = Math.max(10, Math.min(b.w, b.h) * 0.08)
			let size = Math.max(12, Math.min(22, b.w / 9))
			let ls = wrap(s.text ?? '', b.w - pad * 2, size)
			while (size > 9 && ls.length * size * 1.3 > b.h - pad * 2) ls = wrap(s.text ?? '', b.w - pad * 2, --size)
			const lh = size * 1.3
			const top = b.y + b.h / 2 - ((ls.length - 1) * lh) / 2
			return el('g', base, [
				el('rect', { x: b.x, y: b.y + 3, width: b.w, height: b.h, rx: 4, fill: '#000', opacity: theme === 'dark' ? 0.35 : 0.07 }),
				el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, fill: stickyFill(s.color) }),
				el('text', { x: b.x + b.w / 2, 'font-size': size, fill: '#37352F', 'font-family': fontFamily, 'font-weight': 500, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, ls.map((l, i) => el('tspan', { x: b.x + b.w / 2, y: top + i * lh }, escapeXml(l) || ' '))),
			])
		}
		case 'image': {
			const b = freeShapeBounds(s)
			if (!s.src) return el('rect', { ...base, x: b.x, y: b.y, width: b.w, height: b.h, fill: 'none', stroke: SURFACES[theme].muted, 'stroke-dasharray': '4 4' })
			return el('image', { ...base, href: s.src, x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: 'none' })
		}
	}
	return ''
}

/** Content bounds of a layout plus free shapes (edge labels get a little slack). */
export function contentBounds(layout: DiagramLayout | null, shapes: FreeShape[] = []) {
	const boxes = shapes.map(freeShapeBounds)
	if (layout && layout.bounds.w > 0) {
		const b = layout.bounds
		boxes.push({ x: b.x - 20, y: b.y - 12, w: b.w + 40, h: b.h + 24 })
	}
	if (!boxes.length) return { x: 0, y: 0, w: 100, h: 100 }
	const x = Math.min(...boxes.map((b) => b.x))
	const y = Math.min(...boxes.map((b) => b.y))
	return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

export function renderDiagramSvg(ir: DiagramIR, layout: DiagramLayout, opts: RenderSvgOptions = {}): string {
	const theme = opts.theme ?? 'light'
	const s = SURFACES[theme]
	const pad = opts.padding ?? 32
	const scale = opts.scale ?? 1
	const shapes = opts.shapes ?? []
	const b = contentBounds(layout, shapes)
	const width = Math.ceil(b.w + pad * 2)
	const height = Math.ceil(b.h + pad * 2)
	const fontFamily = FONT_STACK[ir.style.typeface ?? 'clean']
	const styleMode = ir.style.styleMode ?? 'plain'
	const c: Ctx = {
		theme,
		mode: ir.style.colorMode,
		measure: opts.measureText ?? estimateText,
		filter: styleMode === 'shadow' ? 'url(#octo-shadow)' : styleMode === 'watercolor' ? 'url(#octo-watercolor)' : undefined,
		icon: opts.icon === false ? undefined : (opts.icon ?? resolveIcon),
		grayscale: opts.officialIcons === 'grayscale',
	}

	const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
	const laid = Object.values(layout.nodes)
	const groups = laid.filter((n) => n.isContainer).sort((a, b) => a.depth - b.depth)
	const leaves = laid.filter((n) => !n.isContainer)

	const parts: string[] = []
	const title = opts.title ?? ir.title
	if (title) parts.push(el('title', {}, escapeXml(title)))
	if (c.filter) {
		parts.push(
			el('defs', {}, [
				el('filter', { id: 'octo-shadow', x: '-20%', y: '-20%', width: '140%', height: '160%' }, el('feDropShadow', { dx: 0, dy: 2, stdDeviation: 2.5, 'flood-color': '#000000', 'flood-opacity': theme === 'dark' ? 0.5 : 0.08 })),
				el('filter', { id: 'octo-watercolor', x: '-10%', y: '-10%', width: '120%', height: '120%' }, [
					el('feTurbulence', { type: 'fractalNoise', baseFrequency: 0.035, numOctaves: 2, seed: 3, result: 'noise' }),
					el('feDisplacementMap', { in: 'SourceGraphic', in2: 'noise', scale: 4 }),
				]),
			]),
		)
	}
	if (opts.background !== false) parts.push(el('rect', { 'data-background': '', x: b.x - pad, y: b.y - pad, width, height, fill: s.bg }))

	const diagram: string[] = []
	if (ir.kind === 'sequence' && layout.sequence) diagram.push(...renderSequence(ir, layout, c))
	else if (ir.kind === 'erd') diagram.push(...renderErd(ir, layout, c))
	else {
		for (const g of groups) {
			const node = byKey.get(g.key)
			if (node) diagram.push(renderGroup(node, g, c))
		}
		for (const e of ir.edges) {
			const le = layout.edges[e.key]
			if (le) diagram.push(renderEdge(e, le, c))
		}
		for (const n of leaves) {
			const node = byKey.get(n.key)
			if (node) diagram.push(renderNode(node, n, c))
		}
	}
	parts.push(el('g', { 'data-layer': 'diagram', 'data-kind': ir.kind }, diagram))
	if (shapes.length) parts.push(el('g', { 'data-layer': 'freehand' }, shapes.map((sh) => renderFreeShape(sh, theme, fontFamily))))

	return el(
		'svg',
		{
			xmlns: 'http://www.w3.org/2000/svg',
			width: Math.ceil(width * scale),
			height: Math.ceil(height * scale),
			viewBox: `${f(b.x - pad)} ${f(b.y - pad)} ${width} ${height}`,
			'font-family': fontFamily,
			role: 'img',
			'data-theme': theme,
		},
		parts,
	)
}

/** Convenience: parse a document's code, lay it out with its pins, render it with its shapes. */
export async function renderDocumentSvg(doc: Pick<OctoDocument, 'code' | 'pins' | 'shapes' | 'title'>, opts: RenderSvgOptions = {}): Promise<string> {
	const { ir } = parseOcto(doc.code)
	const layout = await layoutDiagram(ir, { pinned: doc.pins, measureText: opts.measureText })
	return renderDiagramSvg(ir, layout, { shapes: doc.shapes, title: ir.title ?? doc.title, ...opts })
}
