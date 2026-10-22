import { memo } from 'react'
import { getStroke } from 'perfect-freehand'
import type { FreeShape } from '../store'
import { inkColor, SURFACE, type Theme } from '../lib/colors'
import { arrowHead } from './geometry'
import { FONT_STACK, makeMeasure } from '../lib/text'

export const PEN_SIZES = [3, 6, 10, 16]
export const STROKE_SIZES = [1.5, 2.5, 4, 6]
export const TEXT_SIZES = [16, 20, 28, 40]

export const sizeFor = (type: FreeShape['type'], level: number) => {
	const i = Math.max(0, Math.min(3, level - 1))
	return type === 'pen' ? PEN_SIZES[i] : type === 'text' ? TEXT_SIZES[i] : STROKE_SIZES[i]
}

const avg = (a: number, b: number) => (a + b) / 2

/** perfect-freehand outline polygon → closed SVG path (quadratic smoothing). */
export function strokePath(shape: FreeShape, complete = true): string {
	const pts = shape.points ?? []
	if (!pts.length) return ''
	const outline = getStroke(pts, {
		size: sizeFor('pen', shape.size),
		thinning: 0.6,
		smoothing: 0.55,
		streamline: 0.45,
		simulatePressure: !shape.pressure,
		last: complete,
	})
	const len = outline.length
	if (len < 4) return ''
	let a = outline[0]
	let b = outline[1]
	const c = outline[2]
	let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`
	for (let i = 2; i < len - 1; i++) {
		a = outline[i]
		b = outline[i + 1]
		d += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `
	}
	return d + 'Z'
}

export function shapeBounds(s: FreeShape): { x: number; y: number; w: number; h: number } {
	if ((s.type === 'pen' || s.type === 'arrow') && s.points?.length) {
		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity
		for (const [x, y] of s.points) {
			minX = Math.min(minX, x)
			minY = Math.min(minY, y)
			maxX = Math.max(maxX, x)
			maxY = Math.max(maxY, y)
		}
		const pad = s.type === 'pen' ? sizeFor('pen', s.size) / 2 : 6
		return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
	}
	return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
}

export type Box = { x: number; y: number; w: number; h: number }

/** Font size of a text shape (size level × resize scale). */
export const textSize = (s: FreeShape) => sizeFor('text', s.size) * (s.scale ?? 1)

/**
 * Maps a shape from the selection box `from` to `to` (resize). Text keeps its
 * aspect and scales its font; pen points and arrow endpoints are remapped.
 */
export function resizeShape(s: FreeShape, from: Box, to: Box): FreeShape {
	const sx = from.w > 0.01 ? to.w / from.w : 1
	const sy = from.h > 0.01 ? to.h / from.h : 1
	const mx = (x: number) => to.x + (x - from.x) * sx
	const my = (y: number) => to.y + (y - from.y) * sy
	if (s.points) return { ...s, points: s.points.map(([x, y, p]) => [mx(x), my(y), p] as [number, number, number]) }
	const b = shapeBounds(s)
	if (s.type === 'text') {
		const k = Math.max(0.05, Math.min(Math.abs(sx), Math.abs(sy)))
		return { ...s, x: mx(b.x), y: my(b.y), w: b.w * k, h: b.h * k, scale: (s.scale ?? 1) * k }
	}
	const x1 = mx(b.x)
	const y1 = my(b.y)
	const x2 = mx(b.x + b.w)
	const y2 = my(b.y + b.h)
	return { ...s, x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.max(1, Math.abs(x2 - x1)), h: Math.max(1, Math.abs(y2 - y1)) }
}

export const STICKY_SIZE = 200
const STICKY_TEXT = '#37352F'

/** Pastel fill for a sticky note: the ink color washed toward white (default yellow). */
export function stickyFill(color: string): string {
	const hex = color === 'ink' || !color.startsWith('#') ? '#facc15' : color
	if (hex.length !== 7) return '#FEF3A0'
	const mix = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.32 + 255 * 0.68)
	return `rgb(${mix(1)}, ${mix(3)}, ${mix(5)})`
}

/** Greedy word wrap with the shared canvas measurer (long words are broken). */
export function wrapText(text: string, maxW: number, size: number): string[] {
	const measure = makeMeasure('clean')
	const out: string[] = []
	for (const para of text.split('\n')) {
		let line = ''
		for (const word of para.split(/\s+/).filter(Boolean)) {
			const next = line ? `${line} ${word}` : word
			if (measure(next, size).w <= maxW || !line) {
				line = next
				// break a single over-long word
				while (measure(line, size).w > maxW && line.length > 1) {
					let cut = line.length - 1
					while (cut > 1 && measure(line.slice(0, cut), size).w > maxW) cut--
					out.push(line.slice(0, cut))
					line = line.slice(cut)
				}
			} else {
				out.push(line)
				line = word
			}
		}
		out.push(line)
	}
	return out
}

/** Sticky text layout: largest font (≤ 22) whose wrapped lines fit the note. */
export function stickyLayout(s: FreeShape) {
	const pad = Math.max(10, Math.min(s.w, s.h) * 0.08)
	const maxW = Math.max(10, s.w - pad * 2)
	const maxH = Math.max(10, s.h - pad * 2)
	let size = Math.max(12, Math.min(22, s.w / 9))
	let lines = wrapText(s.text ?? '', maxW, size)
	while (size > 9 && lines.length * size * 1.3 > maxH) {
		size -= 1
		lines = wrapText(s.text ?? '', maxW, size)
	}
	return { size, lines, pad }
}

export function translateShape(s: FreeShape, dx: number, dy: number): FreeShape {
	return {
		...s,
		x: s.x + dx,
		y: s.y + dy,
		points: s.points?.map(([x, y, p]) => [x + dx, y + dy, p] as [number, number, number]),
	}
}

export function textBox(s: FreeShape) {
	const size = textSize(s)
	const lines = (s.text ?? '').split('\n')
	return { size, lines }
}

export const ShapeView = memo(function ShapeView({ shape, theme, complete = true, hidden = false }: { shape: FreeShape; theme: Theme; complete?: boolean; hidden?: boolean }) {
	const color = inkColor(shape.color, theme)
	const sw = sizeFor(shape.type, shape.size)
	const common = { 'data-shape': shape.id } as Record<string, string>
	switch (shape.type) {
		case 'pen':
			return <path {...common} d={strokePath(shape, complete)} fill={color} style={{ cursor: 'move' }} />
		case 'rect': {
			const b = shapeBounds(shape)
			return (
				<g {...common} style={{ cursor: 'move' }}>
					<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} fill="transparent" stroke="transparent" strokeWidth={Math.max(sw, 10)} />
					<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={6} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
				</g>
			)
		}
		case 'ellipse': {
			const b = shapeBounds(shape)
			return (
				<g {...common} style={{ cursor: 'move' }}>
					<ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill="transparent" stroke="transparent" strokeWidth={Math.max(sw, 10)} />
					<ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill="none" stroke={color} strokeWidth={sw} />
				</g>
			)
		}
		case 'arrow': {
			const [p0, p1] = shape.points ?? []
			if (!p0 || !p1) return null
			const a = { x: p0[0], y: p0[1] }
			const b = { x: p1[0], y: p1[1] }
			const head = 8 + sw * 2
			const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
			const end = { x: b.x - ((b.x - a.x) / len) * head * 0.6, y: b.y - ((b.y - a.y) / len) * head * 0.6 }
			return (
				<g {...common} style={{ cursor: 'move' }}>
					<line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={14} />
					<line x1={a.x} y1={a.y} x2={end.x} y2={end.y} stroke={color} strokeWidth={sw} strokeLinecap="round" />
					<path d={arrowHead(a, b, head)} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
				</g>
			)
		}
		case 'sticky': {
			const b = shapeBounds(shape)
			const { size, lines } = stickyLayout(shape)
			const lh = size * 1.3
			const top = b.y + b.h / 2 - ((lines.length - 1) * lh) / 2
			return (
				<g {...common} style={{ cursor: 'move' }}>
					<rect x={b.x} y={b.y + 3} width={b.w} height={b.h} rx={4} fill="#000" opacity={theme === 'dark' ? 0.35 : 0.07} />
					<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={4} fill={stickyFill(shape.color)} />
					{!hidden && (
						<text x={b.x + b.w / 2} fontSize={size} fill={STICKY_TEXT} fontFamily={FONT_STACK.clean} fontWeight={500} textAnchor="middle" dominantBaseline="central">
							{lines.map((l, i) => (
								<tspan key={i} x={b.x + b.w / 2} y={top + i * lh}>
									{l || ' '}
								</tspan>
							))}
						</text>
					)}
				</g>
			)
		}
		case 'image': {
			const b = shapeBounds(shape)
			return (
				<g {...common} style={{ cursor: 'move' }}>
					<rect x={b.x} y={b.y} width={b.w} height={b.h} fill="transparent" />
					{shape.src && <image href={shape.src} x={b.x} y={b.y} width={b.w} height={b.h} preserveAspectRatio="none" />}
				</g>
			)
		}
		case 'text': {
			if (hidden) return null
			const { size, lines } = textBox(shape)
			return (
				<text {...common} x={shape.x} y={shape.y} fontSize={size} fill={color} fontFamily={FONT_STACK.clean} fontWeight={500} style={{ cursor: 'move' }}>
					{lines.map((l, i) => (
						<tspan key={i} x={shape.x} y={shape.y + size * 1.25 * i + size}>
							{l || ' '}
						</tspan>
					))}
				</text>
			)
		}
	}
})

export const selectionColor = (theme: Theme) => SURFACE[theme].select
