import type { Typeface } from '@octo-draw/core'

export const FONT_STACK: Record<Typeface, string> = {
	clean: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
	mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, monospace",
	rough: "'Comic Neue', 'Comic Sans MS', 'Chalkboard SE', 'Segoe Print', cursive",
}

export function fontFor(typeface: Typeface | undefined) {
	return FONT_STACK[typeface ?? 'clean']
}

let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null

/** OffscreenCanvas when available so the layout worker and the main thread measure identically. */
function measureContext() {
	if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1).getContext('2d')
	if (typeof document !== 'undefined' && document.createElement) return document.createElement('canvas').getContext('2d')
	return null
}
const cache = new Map<string, { w: number; h: number }>()

/** Canvas-based text measurement, cached; the layout engine and renderer share it. */
export function makeMeasure(typeface: Typeface | undefined, weight = 500) {
	const family = fontFor(typeface)
	return (text: string, fontSize: number) => {
		const id = `${family}|${weight}|${fontSize}|${text}`
		const hit = cache.get(id)
		if (hit) return hit
		if (!ctx) ctx = measureContext()
		const lines = text.split('\n')
		let w = 0
		if (ctx) {
			ctx.font = `${weight} ${fontSize}px ${family}`
			for (const l of lines) w = Math.max(w, ctx.measureText(l).width)
		} else {
			w = Math.max(...lines.map((l) => l.length)) * fontSize * 0.58
		}
		const r = { w: Math.ceil(w), h: Math.ceil(lines.length * fontSize * 1.3) }
		if (cache.size > 5000) cache.clear()
		cache.set(id, r)
		return r
	}
}
