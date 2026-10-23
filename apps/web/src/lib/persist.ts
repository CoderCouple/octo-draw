import { useStore, type FreeShape } from '../store'
import type { Point } from '@octo-draw/core'
import { ROOT_CRUMB, type Crumb } from './pages'

const KEY = 'octo-draw:doc:v1'
/** drill-down view state: current path and collapsed groups (not part of the document) */
const VIEW_KEY = 'octo-draw:view:v1'

interface SavedView {
	crumbs: Crumb[]
	collapsed: Record<string, string[]>
}

function validCrumbs(v: unknown): v is Crumb[] {
	return Array.isArray(v) && v.length > 0 && v.every((c) => c && typeof c === 'object' && typeof (c as Crumb).page === 'string')
}

export function loadView() {
	try {
		const raw = localStorage.getItem(VIEW_KEY)
		if (!raw) return
		const d = JSON.parse(raw) as Partial<SavedView>
		const crumbs = validCrumbs(d.crumbs) ? d.crumbs : [ROOT_CRUMB]
		const collapsed = d.collapsed && typeof d.collapsed === 'object' ? d.collapsed : {}
		useStore.setState({ crumbs, page: crumbs[crumbs.length - 1].page, collapsed })
	} catch {
		// ignore
	}
}

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
		if (s.crumbs === prev.crumbs && s.collapsed === prev.collapsed) return
		try {
			localStorage.setItem(VIEW_KEY, JSON.stringify({ crumbs: s.crumbs, collapsed: s.collapsed } satisfies SavedView))
		} catch {
			// ignore
		}
	})
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
