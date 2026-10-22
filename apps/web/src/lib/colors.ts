import type { ColorMode } from '@octo-draw/core'

export type Theme = 'light' | 'dark'

/**
 * The app chrome is monochrome (Octonote tokens); canvas content can be colored.
 * Every theme color is a CSS variable in styles.css
 * (tokens mirroring @octonote/design-tokens + derived canvas roles); the
 * canvas reads the resolved values with getComputedStyle, so SVG attributes
 * and exports carry literal colors. FALLBACK mirrors those values for
 * environments without CSS.
 */

/** Named DSL colors. Uncolored nodes stay monochrome; a `color:` prop tints the node with its hue. */
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

export const COLOR_NAMES = Object.keys(PALETTE).filter((c) => c !== 'grey')

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
	select: string
}

const VARS: Record<keyof Surface, string> = {
	bg: '--canvas-bg',
	dot: '--canvas-dot',
	nodeFill: '--node-fill',
	nodeStroke: '--node-stroke',
	text: '--node-text',
	muted: '--canvas-muted',
	edge: '--edge',
	groupFill: '--group-fill',
	groupStroke: '--group-stroke',
	groupText: '--group-text',
	labelBg: '--label-bg',
	labelBorder: '--label-border',
	select: '--select',
}

const FALLBACK: Record<Theme, Surface> = {
	light: { bg: '#FFFFFF', dot: '#E9E9E7', nodeFill: '#FFFFFF', nodeStroke: '#37352F', text: '#37352F', muted: '#73726E', edge: '#37352F', groupFill: '#F1F1EF', groupStroke: '#E9E9E7', groupText: '#73726E', labelBg: '#FFFFFF', labelBorder: '#E9E9E7', select: '#191919' },
	dark: { bg: '#0A0A0B', dot: '#1C1C1E', nodeFill: '#0E0E0F', nodeStroke: '#EDEDEC', text: '#EDEDEC', muted: '#8E8E8C', edge: '#EDEDEC', groupFill: '#141415', groupStroke: '#1C1C1E', groupText: '#8E8E8C', labelBg: '#0A0A0B', labelBorder: '#1C1C1E', select: '#F5F5F4' },
}

const cache: Partial<Record<Theme, Surface>> = {}

/** Canvas palette for the current color scheme, read once per theme from the CSS variables. */
export function surface(theme: Theme): Surface {
	const hit = cache[theme]
	if (hit) return hit
	const out = { ...FALLBACK[theme] }
	if (typeof document !== 'undefined') {
		const cs = getComputedStyle(document.documentElement)
		for (const k of Object.keys(VARS) as (keyof Surface)[]) {
			const v = cs.getPropertyValue(VARS[k]).trim()
			if (v) out[k] = v
		}
	}
	cache[theme] = out
	return out
}

/** Back-compat accessor: SURFACE[theme]. */
export const SURFACE: Record<Theme, Surface> = {
	get light() {
		return surface('light')
	},
	get dark() {
		return surface('dark')
	},
}

function normHex(n: string) {
	return n.length === 4 ? `#${n[1]}${n[1]}${n[2]}${n[2]}${n[3]}${n[3]}` : n
}

/** Resolves a DSL color (palette name or #hex) to a hex value. */
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

/** Linear mix of two hex colors; t=0 gives a, t=1 gives b. Non-hex inputs return a. */
export function mix(a: string, b: string, t: number): string {
	if (!a.startsWith('#') || !b.startsWith('#')) return a
	const x = hexToRgb(a)
	const y = hexToRgb(b)
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

/** Fill / stroke / text for a node given its color prop and the diagram colorMode. */
export function nodeColors(color: string | undefined, mode: ColorMode | undefined, theme: Theme): NodeColors {
	const s = surface(theme)
	const c = resolveColor(color)
	const dark = theme === 'dark'
	if (!c) {
		if (mode === 'bold') return { fill: s.text, stroke: s.text, text: s.bg, icon: s.bg }
		if (mode === 'outline') return { fill: 'none', stroke: s.nodeStroke, text: s.text, icon: s.text }
		return { fill: s.nodeFill, stroke: s.nodeStroke, text: s.text, icon: s.text }
	}
	const base = c
	switch (mode) {
		case 'bold': {
			const textOn = luminance(base) > 0.4 ? '#0a0a0a' : '#ffffff'
			return { fill: base, stroke: mix(base, '#000000', 0.15), text: textOn, icon: textOn }
		}
		case 'outline':
			return { fill: 'none', stroke: base, text: s.text, icon: base }
		default:
			return {
				fill: dark ? mix(base, '#0a0a0a', 0.78) : mix(base, '#ffffff', 0.86),
				stroke: dark ? mix(base, '#0a0a0a', 0.2) : mix(base, '#ffffff', 0.2),
				text: s.text,
				icon: dark ? mix(base, '#ffffff', 0.2) : mix(base, '#000000', 0.1),
			}
	}
}

export function groupColors(color: string | undefined, mode: ColorMode | undefined, theme: Theme) {
	const s = surface(theme)
	const c = resolveColor(color)
	if (!c) return { fill: mode === 'outline' ? 'none' : s.groupFill, stroke: s.groupStroke, text: s.groupText }
	const dark = theme === 'dark'
	const ref = dark ? '#0a0a0a' : '#ffffff'
	const strength = mode === 'bold' ? 0.75 : 0.9
	return {
		fill: mode === 'outline' ? 'none' : mix(c, ref, strength),
		stroke: mix(c, ref, 0.4),
		text: mix(c, dark ? '#ffffff' : '#000000', 0.35),
	}
}

export function edgeColor(color: string | undefined, theme: Theme) {
	const c = resolveColor(color)
	if (!c) return surface(theme).edge
	return c
}

/** Swatches offered for a selected diagram node; written to the code as `color:`. */
export const NODE_COLORS = ['none', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']

/** Freehand palette: ink (theme foreground), gray, then colors. */
export const INK_COLORS = ['ink', '#9B9A97', PALETTE.red, PALETTE.orange, PALETTE.yellow, PALETTE.green, PALETTE.blue, PALETTE.purple, PALETTE.pink]

export function inkColor(c: string, theme: Theme) {
	if (c === 'ink') return surface(theme).text
	if (c === 'paper') return surface(theme).bg
	return c
}
