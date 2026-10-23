import { pushHistory, showToast, useStore } from '../store'
import { shortError, sseEvents } from './api'
import { endPresence, expectPresence } from './presence'
import { drillTargets, parsePage, pageNames } from './drillCore'
import { drillTo } from './view'
import { afterPage } from './compose'

/**
 * On-demand expansion (CONTRACT "Recursive drill-down (v2)" §3): asks
 * `POST /api/expand` for a new page that decomposes a node, applies the full
 * new code as one undo step and drills into the page. AI mode streams SSE.
 */

export type ExpandMode = 'auto' | 'source' | 'ai'

const get = useStore.getState
const set = useStore.setState

let aborter: AbortController | null = null

export function cancelExpand() {
	aborter?.abort()
}

/** Remembered depth for the Expand menu (1–5). */
let depthPref = 1
export const expandDepth = () => depthPref
export function setExpandDepth(d: number) {
	depthPref = Math.max(1, Math.min(5, Math.round(d)))
}

/** The page a node drills into in `code` (after expansion), if any. */
export function drillTargetIn(code: string, page: string, key: string): string | undefined {
	const r = parsePage(code, page)
	if (!r) return undefined
	return drillTargets(r.ir, pageNames(code), page)[key]
}

export async function expandNode(key: string, mode: ExpandMode = 'auto', depth = depthPref) {
	const s = get()
	if (key.startsWith('ghost:')) return
	if (s.drill[key]) return drillTo(s.drill[key], key)
	if (s.expanding) {
		showToast('Already expanding a node…')
		return
	}
	const page = s.page
	const original = s.code
	const node = s.pageIR?.nodes.find((n) => n.key === key) ?? s.ir?.nodes.find((n) => n.key === key)
	const label = node?.label ?? key
	const ctrl = new AbortController()
	aborter = ctrl
	set({ expanding: { page, key, mode } })
	let busy = false
	const ai = () => {
		if (busy || get().aiBusy) return
		busy = true
		set({ aiBusy: `AI is drawing ${label}…` })
		expectPresence('AI')
	}
	if (mode === 'ai') ai()
	let warnings: string[] = []
	const warn = (w: unknown) => {
		if (Array.isArray(w)) warnings = w.filter((x): x is string => typeof x === 'string')
	}
	try {
		const res = await fetch('/api/expand', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code: original, page, node: key, mode, depth }),
			signal: ctrl.signal,
		})
		if (!res.ok) throw new Error(await res.text().catch(() => res.statusText))
		let code: string | undefined
		if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
			for await (const ev of sseEvents(res)) {
				if (typeof ev.error === 'string') throw new Error(ev.error)
				// deltas mean the AI is writing the page: show its presence
				if (typeof ev.delta === 'string') ai()
				if (ev.done && typeof ev.code === 'string') {
					code = ev.code
					warn(ev.warnings)
				}
			}
		} else {
			const data = (await res.json()) as { code?: string; error?: string; warnings?: string[] }
			if (data.error) throw new Error(data.error)
			code = data.code
			warn(data.warnings)
		}
		if (typeof code !== 'string' || code === original) throw new Error('no new page came back')
		if (get().code !== original) {
			showToast('The diagram changed while expanding; nothing was applied', [{ label: 'Retry', run: () => void expandNode(key, mode, depth) }])
			return
		}
		const target = drillTargetIn(code, page, key)
		pushHistory()
		set({ code })
		if (warnings.length) showToast(`Expanded "${label}" with ${warnings.length} warning${warnings.length > 1 ? 's' : ''}: ${warnings[0]}`, undefined, 8000)
		if (target) afterPage(target, () => drillTo(target, key))
	} catch (err) {
		if ((err as Error).name !== 'AbortError') showToast(`Expand failed: ${shortError(err)}`, [{ label: 'Retry', run: () => void expandNode(key, mode, depth) }], 8000)
	} finally {
		if (aborter === ctrl) aborter = null
		set({ expanding: null })
		if (busy) {
			set({ aiBusy: null })
			endPresence()
		}
	}
}
