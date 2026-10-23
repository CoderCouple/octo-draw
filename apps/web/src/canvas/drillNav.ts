import { useStore } from '../store'
import { applyCrumbs, requestViewFit, setNavigator } from '../lib/view'
import { animateCamera, cameraOnBox, fitCamera, scaledCamera, useCamera } from './camera'

type Box = { x: number; y: number; w: number; h: number }

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Resolves once a new layout for the current view has landed (or after a timeout). */
function nextLayout(prev: unknown, ms = 3000): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(t)
			unsub()
			resolve()
		}
		const unsub = useStore.subscribe((s) => {
			if (s.layout !== prev && !s.layoutPending) done()
		})
		const t = setTimeout(done, ms)
	})
}

let busy = false

/**
 * Drill transitions. In: zoom into the node's box while the page fades out,
 * then the sub-page grows into view. Out: the page shrinks away, then the
 * parent appears zoomed into the node we came through and settles to a fit.
 */
export function installNavigator(world: () => SVGGElement | null, contentBounds: () => Box | null) {
	const fade = (o: number) => {
		const el = world()
		if (el) el.style.opacity = String(o)
	}
	setNavigator(async (next, how, via) => {
		if (busy || reducedMotion()) {
			applyCrumbs(next)
			requestViewFit()
			return
		}
		busy = true
		try {
			const before = useStore.getState()
			const box = via ? before.layout?.nodes[via] : undefined
			if (how === 'in') {
				const target = box ? cameraOnBox(box, 1.4) : scaledCamera(useCamera.getState(), 2.2)
				await animateCamera(target, 380, (t) => fade(1 - Math.max(0, (t - 0.4) / 0.6)))
			} else {
				await animateCamera(scaledCamera(useCamera.getState(), 0.45), 300, (t) => fade(1 - t))
			}
			fade(0)
			const prevLayout = useStore.getState().layout
			applyCrumbs(next)
			await nextLayout(prevLayout)
			const fit = fitCamera(contentBounds(), 1.25, false)
			let start = scaledCamera(fit, how === 'in' ? 0.55 : 1.8)
			if (how === 'out' && via) {
				const back = useStore.getState().layout?.nodes[via]
				if (back) start = cameraOnBox(back, 1.4)
			}
			useCamera.setState(start)
			await animateCamera(fit, 420, (t) => fade(t))
		} finally {
			fade(1)
			busy = false
		}
	})
	return () => setNavigator(null)
}
