import { setShapes, uid, useStore, type FreeShape } from '../store'
import { screenToWorld, useCamera, viewportSize } from '../canvas/camera'

const MAX_PIXELS = 1600
const MAX_BYTES = 1_500_000

function readDataUrl(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader()
		r.onload = () => resolve(String(r.result))
		r.onerror = () => reject(r.error)
		r.readAsDataURL(file)
	})
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error('unreadable image'))
		img.src = src
	})
}

/** Data URL for an image file, downscaled when it is huge (keeps localStorage happy). */
async function prepare(file: Blob): Promise<{ src: string; w: number; h: number }> {
	let src = await readDataUrl(file)
	const img = await loadImage(src)
	let w = img.naturalWidth || 320
	let h = img.naturalHeight || 240
	const big = Math.max(w, h) > MAX_PIXELS || file.size > MAX_BYTES
	if (big && file.type !== 'image/svg+xml' && file.type !== 'image/gif') {
		const k = Math.min(1, MAX_PIXELS / Math.max(w, h))
		const cw = Math.max(1, Math.round(w * k))
		const ch = Math.max(1, Math.round(h * k))
		const canvas = document.createElement('canvas')
		canvas.width = cw
		canvas.height = ch
		const ctx = canvas.getContext('2d')
		if (ctx) {
			ctx.drawImage(img, 0, 0, cw, ch)
			const webp = canvas.toDataURL('image/webp', 0.88)
			src = webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.88)
			w = cw
			h = ch
		}
	}
	return { src, w, h }
}

/** Inserts an image file as a free image shape centred at `at` (world) or the view centre. Returns its id. */
export async function insertImage(file: Blob, at?: { x: number; y: number }): Promise<string | null> {
	let img
	try {
		img = await prepare(file)
	} catch {
		return null
	}
	const z = useCamera.getState().z
	const { w: vw, h: vh, left, top } = viewportSize()
	const c = at ?? screenToWorld(left + vw / 2, top + vh / 2)
	// at most ~60% of the visible area, and never upscaled past 1:1
	const k = Math.min(1, (vw * 0.6) / z / img.w, (vh * 0.6) / z / img.h)
	const w = Math.round(img.w * k)
	const h = Math.round(img.h * k)
	const s = useStore.getState()
	const shape: FreeShape = { id: uid(), type: 'image', x: c.x - w / 2, y: c.y - h / 2, w, h, color: 'ink', size: 1, src: img.src }
	setShapes([...s.shapes, shape])
	useStore.setState({ tool: 'select', selection: { kind: 'shapes', ids: [shape.id] } })
	return shape.id
}
