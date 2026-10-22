/**
 * Freehand shapes: the human-drawing layer that is not part of the diagram
 * code (pen strokes, boxes, ellipses, arrows, text). Stored in documents as
 * `OctoDocument.shapes` and rendered on top of the diagram.
 *
 * Coordinates are absolute world coordinates (the same space as DiagramLayout).
 */

export type FreeShapeType = 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'sticky' | 'image'

export const FREE_SHAPE_TYPES: readonly FreeShapeType[] = ['pen', 'rect', 'ellipse', 'arrow', 'text', 'sticky', 'image']

/** [x, y, pressure] — pressure in 0..1 (0.5 when the device doesn't report it). */
export type FreePoint = [number, number, number]

export interface FreeShape {
	id: string
	type: FreeShapeType
	/** rect/ellipse/text/sticky/image: top-left; arrow/pen: unused (0) */
	x: number
	y: number
	w: number
	h: number
	/** pen: [x, y, pressure]; arrow: [start, end] */
	points?: FreePoint[]
	/** `ink` (theme foreground), `paper` (theme background) or a `#hex` color. */
	color: string
	/** Size level 1..4 (stroke width / font size step, see PEN_SIZES etc.). */
	size: number
	text?: string
	/** pen recorded with real pressure (stylus) */
	pressure?: boolean
	/** image: URL or data URL */
	src?: string
	/** text: font scale from resizing (default 1) */
	scale?: number
	/**
	 * Free-form extra data that must survive round-trips, e.g. where a shape
	 * came from (`{ tldraw: { id, type } }`) or an image URL. Renderers ignore it.
	 */
	meta?: Record<string, unknown>
}

/** Narrowed views of FreeShape, handy for switch statements. */
export type PenShape = FreeShape & { type: 'pen'; points: FreePoint[] }
export type RectShape = FreeShape & { type: 'rect' }
export type EllipseShape = FreeShape & { type: 'ellipse' }
export type ArrowShape = FreeShape & { type: 'arrow'; points: [FreePoint, FreePoint] }
export type TextShape = FreeShape & { type: 'text'; text: string }
export type StickyShape = FreeShape & { type: 'sticky' }
export type ImageShape = FreeShape & { type: 'image'; src: string }

/** Default sticky note edge length. */
export const STICKY_SIZE = 200

export const PEN_SIZES = [3, 6, 10, 16]
export const STROKE_SIZES = [1.5, 2.5, 4, 6]
export const TEXT_SIZES = [16, 20, 28, 40]

/** Stroke width (pen/rect/ellipse/arrow) or font size (text) for a size level. */
export function freeSizeFor(type: FreeShapeType, level: number): number {
	const i = Math.max(0, Math.min(3, Math.round(level) - 1))
	return type === 'pen' ? PEN_SIZES[i] : type === 'text' ? TEXT_SIZES[i] : STROKE_SIZES[i]
}

/** Axis-aligned bounds of a free shape in world coordinates. */
export function freeShapeBounds(s: FreeShape): { x: number; y: number; w: number; h: number } {
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
		const pad = s.type === 'pen' ? freeSizeFor('pen', s.size) / 2 : 6
		return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
	}
	return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
}
