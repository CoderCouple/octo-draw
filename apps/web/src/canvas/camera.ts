import { create } from 'zustand'

export interface Camera {
	x: number
	y: number
	z: number
}

/**
 * Camera lives in its own tiny store. Only the canvas root (imperatively, via
 * subscribe) and the zoom readout read it, so panning never re-renders shapes.
 */
export const useCamera = create<Camera>(() => ({ x: 0, y: 0, z: 1 }))

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

let viewport: HTMLElement | null = null
export function setViewport(el: HTMLElement | null) {
	viewport = el
}

export function viewportSize() {
	const r = viewport?.getBoundingClientRect()
	return { w: r?.width ?? 800, h: r?.height ?? 600, left: r?.left ?? 0, top: r?.top ?? 0 }
}

export function screenToWorld(clientX: number, clientY: number) {
	const { left, top } = viewportSize()
	const c = useCamera.getState()
	return { x: (clientX - left - c.x) / c.z, y: (clientY - top - c.y) / c.z }
}

/** Zoom by `factor` keeping the screen point (sx, sy) (viewport-relative) fixed. */
export function zoomAt(factor: number, sx?: number, sy?: number) {
	const c = useCamera.getState()
	const { w, h } = viewportSize()
	const px = sx ?? w / 2
	const py = sy ?? h / 2
	const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, c.z * factor))
	const wx = (px - c.x) / c.z
	const wy = (py - c.y) / c.z
	useCamera.setState({ z, x: px - wx * z, y: py - wy * z })
}

export function panBy(dx: number, dy: number) {
	const c = useCamera.getState()
	useCamera.setState({ x: c.x + dx, y: c.y + dy })
}

export const READABLE_ZOOM = 0.6

/**
 * Centers `b` in the viewport. Strict: everything visible. Readable (default
 * for automatic fits): never below 60% unless even the height can't fit; a
 * diagram wider than the view is anchored at its start (left) instead of
 * shrunk into an unreadable strip.
 */
export function fitBounds(b: { x: number; y: number; w: number; h: number } | null, maxZoom = 1.25, strict = true) {
	const { w, h } = viewportSize()
	if (!b || b.w <= 0 || b.h <= 0) {
		useCamera.setState({ x: w / 2, y: h / 2, z: 1 })
		return
	}
	const pad = Math.min(64, w * 0.06, h * 0.08)
	const fitW = (w - pad * 2) / b.w
	const fitH = (h - pad * 2) / b.h
	let z = Math.min(maxZoom, fitW, fitH)
	if (!strict && z < READABLE_ZOOM) z = Math.max(z, Math.min(READABLE_ZOOM, fitH))
	z = Math.max(MIN_ZOOM, z)
	const x = b.w * z <= w - pad * 2 ? w / 2 - (b.x + b.w / 2) * z : pad - b.x * z
	const y = b.h * z <= h - pad * 2 ? h / 2 - (b.y + b.h / 2) * z : pad - b.y * z
	useCamera.setState({ z, x, y })
}
