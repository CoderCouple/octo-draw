import { create } from 'zustand'
import type { DiagramIR, DiagramLayout, Diagnostic, Point } from '@octo-draw/core'
import { STARTER } from './starter'
import { ROOT_CRUMB, type Crumb } from './lib/pages'

export type Tool = 'select' | 'hand' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'sticky' | 'eraser'

/** Freehand shape type lives in core (part of the OctoDocument format). */
export type { FreeShape } from '@octo-draw/core'
import type { FreeShape } from '@octo-draw/core'

export interface Snapshot {
	code: string
	shapes: FreeShape[]
	pins: Record<string, Point>
}

/**
 * `node`: one diagram node (highlights its code line). `shapes`: free shapes only.
 * `edge`: one diagram connection. `multi`: several nodes and/or shapes.
 */
export type Selection =
	| { kind: 'node'; key: string }
	| { kind: 'shapes'; ids: string[] }
	| { kind: 'edge'; key: string }
	| { kind: 'multi'; ids: string[]; keys: string[] }
	| null

/** Normalizes a set of free-shape ids + node keys into the narrowest Selection. */
export function makeSelection(ids: string[], keys: string[]): Selection {
	if (!ids.length && !keys.length) return null
	if (!ids.length && keys.length === 1) return { kind: 'node', key: keys[0] }
	if (!keys.length) return { kind: 'shapes', ids }
	return { kind: 'multi', ids, keys }
}

export const selectedIds = (sel: Selection): string[] => (sel?.kind === 'shapes' || sel?.kind === 'multi' ? sel.ids : [])
export const selectedKeys = (sel: Selection): string[] => (sel?.kind === 'node' ? [sel.key] : sel?.kind === 'multi' ? sel.keys : [])

export interface Toast {
	id: number
	message: string
	actions?: { label: string; run: () => void }[]
}

interface State extends Snapshot {
	title: string
	past: Snapshot[]
	future: Snapshot[]
	/** last time + kind of history push, for coalescing typing */
	lastPush: { at: number; tag: string }

	ir: DiagramIR | null
	layout: DiagramLayout | null
	diagnostics: Diagnostic[]
	layoutPending: boolean

	selection: Selection
	tool: Tool
	ink: string
	size: number
	aiBusy: string | null
	toast: Toast | null
	fitRequest: number
	/** true: the last fit request wants everything visible (zoom-to-fit button) */
	fitStrict: boolean

	// drill-down view state (localStorage, not code)
	/** current page name; '' is the root page */
	page: string
	/** drill path, root first; the last crumb is what the canvas shows */
	crumbs: Crumb[]
	/** collapsed group keys per page */
	collapsed: Record<string, string[]>
	/** page names in source order (root '' first) */
	pageNames: string[]
	/** the current page's IR before collapse/focus */
	pageIR: DiagramIR | null
	/** node key → page it drills into, for the rendered view */
	drill: Record<string, string>
	/** `title` directive of the root page */
	rootTitle?: string
}

export const useStore = create<State>(() => ({
	code: STARTER,
	shapes: [],
	pins: {},
	title: 'Untitled diagram',
	past: [],
	future: [],
	lastPush: { at: 0, tag: '' },
	ir: null,
	layout: null,
	diagnostics: [],
	layoutPending: false,
	selection: null,
	tool: 'select',
	ink: 'ink',
	size: 2,
	aiBusy: null,
	toast: null,
	fitRequest: 0,
	fitStrict: false,
	page: '',
	crumbs: [ROOT_CRUMB],
	collapsed: {},
	pageNames: [''],
	pageIR: null,
	drill: {},
}))

const get = useStore.getState
const set = useStore.setState

export function snapshot(): Snapshot {
	const s = get()
	return { code: s.code, shapes: s.shapes, pins: s.pins }
}

const HISTORY_LIMIT = 200

/**
 * Records `before` as an undo step. With a `tag`, consecutive pushes with the
 * same tag inside `coalesceMs` collapse into one step (typing, AI streaming).
 */
export function pushHistory(before: Snapshot = snapshot(), tag = '', coalesceMs = 900) {
	const s = get()
	const now = Date.now()
	if (tag && s.lastPush.tag === tag && now - s.lastPush.at < coalesceMs) {
		set({ lastPush: { at: now, tag }, future: [] })
		return
	}
	const past = [...s.past, before]
	if (past.length > HISTORY_LIMIT) past.shift()
	set({ past, future: [], lastPush: { at: now, tag } })
}

export type HistoryMode = 'push' | 'none' | { tag: string; ms?: number }

export function setCode(code: string, mode: HistoryMode = 'push') {
	if (code === get().code) return
	if (mode === 'push') pushHistory()
	else if (mode !== 'none') pushHistory(snapshot(), mode.tag, mode.ms)
	set({ code })
}

export function setShapes(shapes: FreeShape[], mode: HistoryMode = 'push') {
	if (mode === 'push') pushHistory()
	else if (mode !== 'none') pushHistory(snapshot(), mode.tag, mode.ms)
	set({ shapes })
}

export function setPins(pins: Record<string, Point>, mode: HistoryMode = 'push') {
	if (mode === 'push') pushHistory()
	set({ pins })
}

export function undo() {
	const s = get()
	const prev = s.past[s.past.length - 1]
	if (!prev) return
	set({
		...prev,
		past: s.past.slice(0, -1),
		future: [snapshot(), ...s.future],
		lastPush: { at: 0, tag: '' },
		selection: null,
	})
}

export function redo() {
	const s = get()
	const next = s.future[0]
	if (!next) return
	set({
		...next,
		past: [...s.past, snapshot()],
		future: s.future.slice(1),
		lastPush: { at: 0, tag: '' },
		selection: null,
	})
}

let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | undefined
export function showToast(message: string, actions?: Toast['actions'], ms = 5000) {
	const id = ++toastSeq
	set({ toast: { id, message, actions } })
	clearTimeout(toastTimer)
	toastTimer = setTimeout(() => {
		if (get().toast?.id === id) set({ toast: null })
	}, ms)
}

export function dismissToast() {
	set({ toast: null })
}

/** Auto fits keep the diagram readable (>= 60% when possible); `strict` shows everything. */
export function requestFit(strict?: boolean) {
	set({ fitRequest: get().fitRequest + 1, fitStrict: strict === true })
}

export const uid = () => Math.random().toString(36).slice(2, 10)
