import { printOcto, toMermaid } from '@octo-draw/core'
import { useStore } from '../store'
import { shapeBounds } from '../canvas/freehand'
import { SURFACE } from './colors'
import { currentTheme } from './theme'
import { showToast } from '../store'

function contentBounds() {
	const s = useStore.getState()
	const boxes = s.shapes.map(shapeBounds)
	if (s.layout && s.layout.bounds.w > 0) {
		const b = s.layout.bounds
		// edge labels can poke out of the node/edge bounds a little
		boxes.push({ x: b.x - 20, y: b.y - 12, w: b.w + 40, h: b.h + 24 })
	}
	if (!boxes.length) return { x: 0, y: 0, w: 100, h: 100 }
	const x = Math.min(...boxes.map((b) => b.x))
	const y = Math.min(...boxes.map((b) => b.y))
	return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

export function buildSvg(): { svg: string; width: number; height: number } {
	const world = document.getElementById('octo-world')
	const pad = 32
	const b = contentBounds()
	const width = Math.ceil(b.w + pad * 2)
	const height = Math.ceil(b.h + pad * 2)
	const ns = 'http://www.w3.org/2000/svg'
	const svg = document.createElementNS(ns, 'svg')
	svg.setAttribute('xmlns', ns)
	svg.setAttribute('width', String(width))
	svg.setAttribute('height', String(height))
	svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${width} ${height}`)
	const bg = document.createElementNS(ns, 'rect')
	bg.setAttribute('x', String(b.x - pad))
	bg.setAttribute('y', String(b.y - pad))
	bg.setAttribute('width', String(width))
	bg.setAttribute('height', String(height))
	bg.setAttribute('fill', SURFACE[currentTheme()].bg)
	svg.appendChild(bg)
	if (world) {
		const clone = world.cloneNode(true) as SVGGElement
		clone.removeAttribute('transform')
		clone.removeAttribute('id')
		clone.querySelectorAll('[data-export="skip"], foreignObject').forEach((el) => el.remove())
		clone.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'))
		svg.appendChild(clone)
	}
	return { svg: new XMLSerializer().serializeToString(svg), width, height }
}

function download(name: string, blob: Blob) {
	const url = URL.createObjectURL(blob)
	const a = document.createElement('a')
	a.href = url
	a.download = name
	document.body.appendChild(a)
	a.click()
	a.remove()
	setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const fileBase = () =>
	(useStore.getState().title || 'diagram')
		.trim()
		.replace(/[^\w\- ]+/g, '')
		.replace(/\s+/g, '-')
		.toLowerCase() || 'diagram'

export function downloadSvg() {
	const { svg } = buildSvg()
	download(`${fileBase()}.svg`, new Blob([svg], { type: 'image/svg+xml' }))
}

export async function downloadPng(scale = 2) {
	const { svg, width, height } = buildSvg()
	const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
	try {
		const img = new Image()
		img.decoding = 'async'
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve()
			img.onerror = () => reject(new Error('could not rasterize SVG'))
			img.src = url
		})
		const canvas = document.createElement('canvas')
		canvas.width = width * scale
		canvas.height = height * scale
		const ctx = canvas.getContext('2d')!
		ctx.scale(scale, scale)
		ctx.drawImage(img, 0, 0, width, height)
		const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
		if (blob) download(`${fileBase()}.png`, blob)
	} catch (err) {
		showToast(`PNG export failed: ${(err as Error).message}`)
	} finally {
		URL.revokeObjectURL(url)
	}
}

export function downloadJson() {
	const s = useStore.getState()
	const data = { title: s.title, ir: s.ir, layout: s.layout, drawing: s.shapes, pins: s.pins }
	download(`${fileBase()}.json`, new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
}

async function copy(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text)
		showToast(`Copied ${what} to clipboard`)
	} catch {
		showToast('Clipboard not available')
	}
}

export function copyOcto() {
	return copy(useStore.getState().code, 'octo code')
}

export function copyMermaid() {
	const ir = useStore.getState().ir
	if (!ir) return
	return copy(toMermaid(ir), 'mermaid')
}

export function copyCanonical() {
	const ir = useStore.getState().ir
	if (!ir) return
	return copy(printOcto(ir), 'formatted octo code')
}
