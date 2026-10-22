import { applyActions as applyCore, renameNodeLabel, type AgentAction, type ApplyResult } from '@octo-draw/core'
import { setCode, setPins, showToast, useStore, pushHistory, snapshot, selectedIds, selectedKeys } from '../store'

export function deleteSelection() {
	const s = useStore.getState()
	const sel = s.selection
	if (!sel) return
	if (sel.kind === 'edge') {
		const e = s.ir?.edges.find((x) => x.key === sel.key)
		if (!e) return
		const r = applyCore(s.code, [{ type: 'removeEdge', id: e.key, from: e.from, to: e.to }])
		if (r.errors.length) {
			showToast(`Couldn't delete: ${r.errors[0].message}`)
			return
		}
		setCode(r.code)
		useStore.setState({ selection: null })
		return
	}
	const keys = selectedKeys(sel)
	const ids = new Set(selectedIds(sel))
	let code = s.code
	const pins = { ...s.pins }
	if (keys.length) {
		const r = applyCore(code, keys.map((key) => ({ type: 'removeNode' as const, key })))
		// removing a group first may already have removed a child: ignore "unknown node" for those
		const real = r.errors.filter((er) => !/unknown|not found|no node/i.test(er.message))
		if (real.length && r.code === code) {
			showToast(`Couldn't delete: ${real[0].message}`)
			return
		}
		code = r.code
		for (const k of keys) delete pins[k]
	}
	pushHistory()
	useStore.setState({ code, pins, shapes: ids.size ? s.shapes.filter((x) => !ids.has(x.id)) : s.shapes, selection: null })
}

export function renameNode(key: string, label: string) {
	const s = useStore.getState()
	const node = s.ir?.nodes.find((n) => n.key === key)
	const current = node?.label ?? key
	if (!label.trim() || label === current) return
	setCode(renameNodeLabel(s.code, key, label))
}

export function tidy() {
	const s = useStore.getState()
	if (!Object.keys(s.pins).length) {
		showToast('Already tidy: no pinned nodes')
		return
	}
	setPins({})
	showToast('Layout tidied: pins cleared')
}

/** Applies agent actions to the code as one undo step. */
export function runActions(actions: AgentAction[]): ApplyResult {
	const s = useStore.getState()
	const r = applyCore(s.code, actions)
	if (r.code !== s.code) setCode(r.code)
	return r
}

export function replaceAll(code: string) {
	pushHistory(snapshot())
	useStore.setState({ code, pins: {}, selection: null })
}
