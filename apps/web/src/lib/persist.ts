import { useStore, type FreeShape } from '../store'
import type { Point } from '@octo-draw/core'

const KEY = 'octo-draw:doc:v1'

interface Saved {
	code: string
	title: string
	shapes: FreeShape[]
	pins: Record<string, Point>
}

export function loadSaved() {
	try {
		const raw = localStorage.getItem(KEY)
		if (!raw) return
		const d = JSON.parse(raw) as Partial<Saved>
		useStore.setState({
			code: typeof d.code === 'string' ? d.code : useStore.getState().code,
			title: typeof d.title === 'string' ? d.title : useStore.getState().title,
			shapes: Array.isArray(d.shapes) ? d.shapes : [],
			pins: d.pins && typeof d.pins === 'object' ? d.pins : {},
		})
	} catch {
		// storage unavailable or corrupt: start fresh
	}
}

let timer: ReturnType<typeof setTimeout> | undefined
export function startPersistence() {
	useStore.subscribe((s, prev) => {
		if (s.code === prev.code && s.title === prev.title && s.shapes === prev.shapes && s.pins === prev.pins) return
		clearTimeout(timer)
		timer = setTimeout(() => {
			const st = useStore.getState()
			try {
				localStorage.setItem(KEY, JSON.stringify({ code: st.code, title: st.title, shapes: st.shapes, pins: st.pins } satisfies Saved))
			} catch {
				// quota or private mode
			}
		}, 300)
	})
}
