import { create } from 'zustand'
import { parseOcto, type AgentAction } from '@octo-draw/core'
import { pushHistory, requestFit, snapshot, undo, useStore, type Snapshot } from '../store'
import { shortError, sseEvents } from './api'
import { diffIR, endPresence, expectPresence, type IRDiff } from './presence'
import { setAgentStatus, syncOnline } from './sync'

/**
 * Agent chat panel state and the client side of POST /api/agent/stream.
 * Every run that changes the diagram is exactly one undo step.
 */

export type RunStatus = 'streaming' | 'done' | 'error' | 'stopped'

export interface AgentRun {
	id: string
	prompt: string
	selection: string[]
	mode?: 'auto' | 'edit' | 'explain'
	text: string
	actions: AgentAction[]
	errors: string[]
	status: RunStatus
	error?: string
	/** Actions in the tool call currently streaming. */
	pending: number
	/** Snapshot before the first applied action (the undo step this run pushed). */
	before?: Snapshot
	/** Code after the run finished. */
	after?: string
	diff?: IRDiff
	undone?: boolean
}

interface AgentState {
	open: boolean
	runs: AgentRun[]
	focusTick: number
}

const OPEN_KEY = 'octo-draw:agent-open'

function readOpen() {
	try {
		return localStorage.getItem(OPEN_KEY) === '1'
	} catch {
		return false
	}
}

export const useAgent = create<AgentState>(() => ({ open: readOpen(), runs: [], focusTick: 0 }))

export function setAgentOpen(open: boolean) {
	useAgent.setState({ open })
	try {
		localStorage.setItem(OPEN_KEY, open ? '1' : '0')
	} catch {
		// ignore
	}
}

/** Opens the panel and focuses its input (Cmd+K). */
export function focusAgent() {
	setAgentOpen(true)
	useAgent.setState((s) => ({ focusTick: s.focusTick + 1 }))
}

export function clearAgent() {
	if (useAgent.getState().runs.some((r) => r.status === 'streaming')) stopAgent()
	useAgent.setState({ runs: [] })
}

function patchRun(id: string, patch: Partial<AgentRun> | ((r: AgentRun) => Partial<AgentRun>)) {
	useAgent.setState((s) => ({
		runs: s.runs.map((r) => (r.id === id ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r)),
	}))
}

/** One-line description of an action for the run log. */
export function describeAction(a: AgentAction): { sym: string; what: string; name: string } {
	switch (a.type) {
		case 'addNode':
			return { sym: '+', what: 'node', name: a.label && a.label !== a.key ? `${a.key} (${a.label})` : a.key }
		case 'updateNode': {
			const props = (['label', 'shape', 'icon', 'color'] as const).filter((p) => a[p] !== undefined)
			return { sym: '~', what: 'node', name: `${a.key}${props.length ? ` · ${props.map((p) => `${p} ${a[p]}`).join(', ')}` : ''}` }
		}
		case 'removeNode':
			return { sym: '−', what: 'node', name: a.key }
		case 'addEdge':
			return { sym: '+', what: 'edge', name: `${a.from} → ${a.to}${a.label ? ` · ${a.label}` : ''}` }
		case 'removeEdge':
			return { sym: '−', what: 'edge', name: `${a.from} → ${a.to}` }
		case 'addGroup':
			return { sym: '+', what: 'group', name: `${a.key}${a.children?.length ? ` · ${a.children.length} inside` : ''}` }
		case 'setDirection':
			return { sym: '↻', what: 'direction', name: a.direction }
		case 'replaceCode':
			return { sym: '⇄', what: 'rewrite', name: `${a.code.split('\n').filter((l) => l.trim()).length} lines${a.format === 'mermaid' ? ' (mermaid)' : ''}` }
	}
}

/** Short "+2 nodes · −1 edge · ~1" summary of a run's net effect. */
export function diffSummary(d: IRDiff): string {
	const parts: string[] = []
	const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
	if (d.added.length) parts.push(`+${n(d.added.length, 'node')}`)
	if (d.removed.length) parts.push(`−${n(d.removed.length, 'node')}`)
	if (d.edgesAdded) parts.push(`+${n(d.edgesAdded, 'edge')}`)
	if (d.edgesRemoved) parts.push(`−${n(d.edgesRemoved, 'edge')}`)
	const changed = d.changed.length
	if (changed) parts.push(`~${changed} changed`)
	return parts.join(' · ') || 'no net change'
}

function historyFor(runs: AgentRun[]) {
	const turns: { role: 'user' | 'assistant'; content: string }[] = []
	for (const r of runs) {
		if (r.status === 'streaming') continue
		turns.push({ role: 'user', content: r.prompt })
		const acts = r.actions.map((a) => {
			const d = describeAction(a)
			return `${d.sym} ${d.what} ${d.name}`
		})
		const reply = [r.text.trim(), acts.length ? `(applied: ${acts.slice(0, 20).join('; ')}${r.undone ? ' — later undone by the user' : ''})` : '']
			.filter(Boolean)
			.join('\n')
		turns.push({ role: 'assistant', content: reply || (r.error ? `(failed: ${r.error})` : '(no reply)') })
	}
	return turns.slice(-16)
}

let aborter: AbortController | null = null

export function stopAgent() {
	aborter?.abort()
}

export function agentBusy() {
	return useAgent.getState().runs.some((r) => r.status === 'streaming')
}

export async function sendAgent(prompt: string) {
	const text = prompt.trim()
	if (!text || agentBusy()) return
	const st = useStore.getState()
	const selection = st.selection?.kind === 'node' ? [st.selection.key] : []
	const id = Math.random().toString(36).slice(2, 10)
	const history = historyFor(useAgent.getState().runs)
	const run: AgentRun = { id, prompt: text, selection, text: '', actions: [], errors: [], status: 'streaming', pending: 0 }
	useAgent.setState((s) => ({ runs: [...s.runs, run] }))

	const ctrl = new AbortController()
	aborter = ctrl
	const startCode = st.code
	let before: Snapshot | undefined
	expectPresence('AI')
	setAgentStatus('thinking', text.slice(0, 120))
	try {
		const res = await fetch('/api/agent/stream', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prompt: text, code: startCode, history, selection, source: 'agent:AI' }),
			signal: ctrl.signal,
		})
		if (!res.ok || !res.body) throw new Error(await res.text().catch(() => res.statusText))
		for await (const ev of sseEvents(res)) {
			switch (ev.type) {
				case 'mode':
					patchRun(id, { mode: ev.mode as AgentRun['mode'] })
					break
				case 'text':
					patchRun(id, (r) => ({ text: r.text + String(ev.delta ?? '') }))
					break
				case 'progress':
					patchRun(id, { pending: Number(ev.count) || 0 })
					break
				case 'actions': {
					const actions = (ev.actions as AgentAction[]) ?? []
					const code = String(ev.code ?? '')
					if (code !== useStore.getState().code) {
						if (!before) {
							// the whole run becomes one undo step
							before = snapshot()
							pushHistory(before)
						}
						setAgentStatus('drawing', text.slice(0, 120))
						// with live sync the server writes each step into the room and it arrives as a
						// remote change; writing it here too would apply the same edit twice
						if (syncOnline()) useStore.setState({ selection: null })
						else useStore.setState({ code, selection: null })
					}
					patchRun(id, (r) => ({ actions: [...r.actions, ...actions], errors: (ev.errors as string[]) ?? [], pending: 0, before }))
					break
				}
				case 'done':
					patchRun(id, { status: 'done', errors: (ev.errors as string[]) ?? [], pending: 0 })
					break
				case 'error':
					throw new Error(String(ev.message ?? 'Agent failed'))
			}
		}
		patchRun(id, (r) => (r.status === 'streaming' ? { status: 'done' } : {}))
	} catch (err) {
		if ((err as Error).name === 'AbortError') patchRun(id, { status: 'stopped', pending: 0 })
		else patchRun(id, { status: 'error', error: shortError(err), pending: 0 })
	} finally {
		if (aborter === ctrl) aborter = null
		endPresence()
		setAgentStatus('idle')
		const after = useStore.getState().code
		if (before) {
			patchRun(id, { after, diff: diffIR(parseOcto(before.code).ir, parseOcto(after).ir) })
			if (parseOcto(before.code).ir.nodes.length === 0) setTimeout(requestFit, 300)
		}
	}
}

/** True when the diagram is still exactly what this run produced (so a plain undo reverts it). */
export function canUndoRun(run: AgentRun, code: string, past: Snapshot[]): boolean {
	return !!run.before && !run.undone && run.status !== 'streaming' && run.after === code && past[past.length - 1] === run.before
}

export function undoRun(run: AgentRun) {
	const s = useStore.getState()
	if (!canUndoRun(run, s.code, s.past)) return
	undo()
	patchRun(run.id, { undone: true })
}
