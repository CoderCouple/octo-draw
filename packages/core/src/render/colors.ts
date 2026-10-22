/**
 * Headless color rules: monochrome surfaces (Octonote tokens) plus hue tints
 * for nodes with a `color:` prop. Mirrors apps/web/src/lib/colors.ts, which
 * reads the same values from CSS variables at runtime.
 */

import type { ColorMode } from '../ir'

export type RenderTheme = 'light' | 'dark'

export const PALETTE: Record<string, string> = {
	blue: '#3b82f6',
	lightblue: '#38bdf8',
	cyan: '#06b6d4',
	teal: '#14b8a6',
	green: '#22c55e',
	lime: '#84cc16',
	yellow: '#eab308',
	orange: '#f97316',
	red: '#ef4444',
	pink: '#ec4899',
	purple: '#a855f7',
	violet: '#8b5cf6',
	indigo: '#6366f1',
	brown: '#a16207',
	gray: '#737373',
	grey: '#737373',
	black: '#0a0a0a',
	white: '#ffffff',
}

export interface Surface {
	bg: string
	dot: string
	nodeFill: string
	nodeStroke: string
	text: string
	muted: string
	edge: string
	groupFill: string
	groupStroke: string
	groupText: string
	labelBg: string
	labelBorder: string
}

export const SURFACES: Record<RenderTheme, Surface> = {
	light: { bg: '#FFFFFF', dot: '#E9E9E7', nodeFill: '#FFFFFF', nodeStroke: '#37352F', text: '#37352F', muted: '#73726E', edge: '#37352F', groupFill: '#F1F1EF', groupStroke: '#E9E9E7', groupText: '#73726E', labelBg: '#FFFFFF', labelBorder: '#E9E9E7' },
	dark: { bg: '#0A0A0B', dot: '#1C1C1E', nodeFill: '#0E0E0F', nodeStroke: '#EDEDEC', text: '#EDEDEC', muted: '#8E8E8C', edge: '#EDEDEC', groupFill: '#141415', groupStroke: '#1C1C1E', groupText: '#8E8E8C', labelBg: '#0A0A0B', labelBorder: '#1C1C1E' },
}

function normHex(n: string) {
	return n.length === 4 ? `#${n[1]}${n[1]}${n[2]}${n[2]}${n[3]}${n[3]}` : n
}

/** Palette name or #hex → lowercase 6-digit hex; anything else → undefined. */
export function resolveColor(name: string | undefined): string | undefined {
	if (!name) return undefined
	const n = name.trim().toLowerCase()
	if (PALETTE[n]) return PALETTE[n]
	if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(n)) return normHex(n)
	return undefined
}

function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace('#', '')
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex([r, g, b]: [number, number, number]) {
	return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
}

export function mix(a: string, b: string, t: number): string {
	if (!a.startsWith('#') || !b.startsWith('#')) return a
	const x = hexToRgb(normHex(a))
	const y = hexToRgb(normHex(b))
	return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t])
}

function luminance(hex: string) {
	const [r, g, b] = hexToRgb(hex).map((v) => {
		const c = v / 255
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export interface NodeColors {
	fill: string
	stroke: string
	text: string
	icon: string
}

export function nodeColors(color: string | undefined, mode: ColorMode | undefined, theme: RenderTheme): NodeColors {
	const s = SURFACES[theme]
	const c = resolveColor(color)
	const dark = theme === 'dark'
	if (!c) {
		if (mode === 'bold') return { fill: s.text, stroke: s.text, text: s.bg, icon: s.bg }
		if (mode === 'outline') return { fill: 'none', stroke: s.nodeStroke, text: s.text, icon: s.text }
		return { fill: s.nodeFill, stroke: s.nodeStroke, text: s.text, icon: s.text }
	}
	switch (mode) {
		case 'bold': {
			const on = luminance(c) > 0.4 ? '#0a0a0a' : '#ffffff'
			return { fill: c, stroke: mix(c, '#000000', 0.15), text: on, icon: on }
		}
		case 'outline':
			return { fill: 'none', stroke: c, text: s.text, icon: c }
		default:
			return {
				fill: dark ? mix(c, '#0a0a0a', 0.78) : mix(c, '#ffffff', 0.86),
				stroke: dark ? mix(c, '#0a0a0a', 0.2) : mix(c, '#ffffff', 0.2),
				text: s.text,
				icon: dark ? mix(c, '#ffffff', 0.2) : mix(c, '#000000', 0.1),
			}
	}
}

export function groupColors(color: string | undefined, mode: ColorMode | undefined, theme: RenderTheme) {
	const s = SURFACES[theme]
	const c = resolveColor(color)
	if (!c) return { fill: mode === 'outline' ? 'none' : s.groupFill, stroke: s.groupStroke, text: s.groupText }
	const dark = theme === 'dark'
	const ref = dark ? '#0a0a0a' : '#ffffff'
	return {
		fill: mode === 'outline' ? 'none' : mix(c, ref, mode === 'bold' ? 0.75 : 0.9),
		stroke: mix(c, ref, 0.4),
		text: mix(c, dark ? '#ffffff' : '#000000', 0.35),
	}
}

export function edgeColor(color: string | undefined, theme: RenderTheme) {
	return resolveColor(color) ?? SURFACES[theme].edge
}

/** Freehand ink: `ink` → theme foreground, `paper` → theme background, else as given. */
export function inkColor(c: string, theme: RenderTheme) {
	if (c === 'ink') return SURFACES[theme].text
	if (c === 'paper') return SURFACES[theme].bg
	return c
}

export const FONT_STACK = {
	clean: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
	mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace",
	rough: "'Comic Neue', 'Comic Sans MS', 'Chalkboard SE', 'Segoe Print', cursive",
} as const
