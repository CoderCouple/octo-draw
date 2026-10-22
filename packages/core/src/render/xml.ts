/** Tiny string-based SVG builder shared by the headless renderers. */

import type { IconNode } from './svg'

export const f = (n: number) => String(Math.round(n * 100) / 100)

export function escapeXml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export type Attrs = Record<string, string | number | undefined | null | false>

export function attrs(a: Attrs): string {
	let out = ''
	for (const [k, v] of Object.entries(a)) {
		if (v === undefined || v === null || v === false) continue
		out += ` ${k}="${escapeXml(typeof v === 'number' ? f(v) : v)}"`
	}
	return out
}

export function el(tag: string, a: Attrs, children?: string | string[]): string {
	const body = Array.isArray(children) ? children.join('') : (children ?? '')
	return body ? `<${tag}${attrs(a)}>${body}</${tag}>` : `<${tag}${attrs(a)}/>`
}

export function lines(text: string, x: number, y: number, size: number, weight: number, fill: string, anchor: 'middle' | 'start' = 'middle') {
	const ls = text.split('\n')
	const lh = size * 1.3
	const top = y - ((ls.length - 1) * lh) / 2
	const spans = ls.map((l, i) => el('tspan', { x, y: top + i * lh }, escapeXml(l) || ' '))
	return el('text', { x, 'text-anchor': anchor, 'font-size': size, 'font-weight': weight, fill, 'dominant-baseline': 'central' }, spans)
}

export function iconGlyph(name: string, x: number, y: number, size: number, color: string, resolve?: (name: string) => IconNode | null | undefined) {
	const icon = resolve?.(name)
	if (!icon) {
		const text = name.replace(/^(aws|gcp|azure)-/, '').slice(0, 5).toUpperCase()
		return el('g', { transform: `translate(${f(x)},${f(y)})`, 'data-icon': name }, [
			el('rect', { width: size, height: size, rx: 4, fill: 'none', stroke: color, 'stroke-width': 1.2 }),
			el('text', { x: size / 2, y: size / 2 + 2.6, 'text-anchor': 'middle', 'font-size': text.length > 3 ? 6 : 7.5, 'font-weight': 700, fill: color }, escapeXml(text)),
		])
	}
	const parts = icon.map(([tag, a]) => {
		const clean: Attrs = {}
		for (const [k, v] of Object.entries(a)) if (k !== 'key') clean[k] = v
		return el(tag, clean)
	})
	return el(
		'svg',
		{ x, y, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', overflow: 'visible', 'data-icon': name },
		parts,
	)
}

