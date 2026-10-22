import type { IRNode, LayoutOptions, NodeShape } from '../ir'

export const NODE_FONT_SIZE = 14
export const EDGE_FONT_SIZE = 12
export const GROUP_FONT_SIZE = 13
export const ICON_SIZE = 20
/** Padding inside containers: room for the title row on top. */
export const GROUP_PADDING = { top: 44, left: 20, bottom: 20, right: 20 }

export type Measure = NonNullable<LayoutOptions['measureText']>

/** Headless fallback: average glyph width of a clean sans font. */
export const estimateText: Measure = (text, fontSize) => {
	const lines = text.split('\n')
	let max = 0
	for (const line of lines) {
		let w = 0
		for (const ch of line) {
			if (/[A-Z@#%&MWmw]/.test(ch)) w += 0.72
			else if (/[ilj.,:;'|!]/.test(ch)) w += 0.3
			else if (ch === ' ') w += 0.3
			else if (ch.charCodeAt(0) > 0x2e80) w += 1
			else w += 0.56
		}
		max = Math.max(max, w)
	}
	return { w: Math.ceil(max * fontSize), h: Math.ceil(lines.length * fontSize * 1.3) }
}

export function nodeLabel(node: IRNode): string {
	return node.label ?? node.key
}

/**
 * Whether the icon is drawn to the left of the label (box-like shapes) or
 * stacked above it (round / pointy shapes). The renderer uses the same rule.
 */
export function iconPlacement(shape: NodeShape | undefined): 'left' | 'top' {
	switch (shape ?? 'rectangle') {
		case 'rectangle':
		case 'parallelogram':
		case 'hexagon':
		case 'document':
		case 'trapezoid':
			return 'left'
		default:
			return 'top'
	}
}

/** Size of a leaf node, derived from its label, icon and shape. */
export function nodeSize(node: IRNode, measure: Measure): { w: number; h: number } {
	if (node.geometry?.w && node.geometry?.h) return { w: node.geometry.w, h: node.geometry.h }
	const text = measure(nodeLabel(node), NODE_FONT_SIZE)
	const hasIcon = !!node.icon
	const shape = node.shape ?? 'rectangle'
	let cw = text.w
	let ch = text.h
	if (hasIcon) {
		if (iconPlacement(shape) === 'left') {
			cw += ICON_SIZE + 8
			ch = Math.max(ch, ICON_SIZE)
		} else {
			cw = Math.max(cw, ICON_SIZE)
			ch += ICON_SIZE + 6
		}
	}
	let w = cw + 32
	let h = ch + 26
	switch (shape) {
		case 'rectangle':
			w = Math.max(w, 120)
			h = Math.max(h, 48)
			break
		case 'oval':
			w = Math.max(w + 24, 120)
			h = Math.max(h, 48)
			break
		case 'ellipse':
			w = Math.max(w * 1.3, 120)
			h = Math.max(h * 1.3, 64)
			break
		case 'diamond':
			w = Math.max(cw * 1.8 + 40, 140)
			h = Math.max(ch * 2 + 40, 90)
			break
		case 'cylinder':
			w = Math.max(w, 110)
			h = Math.max(h + 24, 76)
			break
		case 'hexagon':
		case 'parallelogram':
		case 'trapezoid':
			w = Math.max(w + 36, 140)
			h = Math.max(h, 52)
			break
		case 'document':
			w = Math.max(w, 120)
			h = Math.max(h + 12, 60)
			break
		case 'triangle':
			w = Math.max(cw * 2 + 40, 130)
			h = Math.max(ch * 2 + 40, 100)
			break
		case 'star':
			w = Math.max(cw * 1.9 + 40, 130)
			h = Math.max(ch * 2 + 50, 120)
			break
		case 'cloud':
			w = Math.max(w * 1.35 + 20, 150)
			h = Math.max(h * 1.5, 84)
			break
	}
	return { w: Math.round(node.geometry?.w ?? w), h: Math.round(node.geometry?.h ?? h) }
}
