import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Bot, LoaderCircle, Square, Trash2, Undo2, X } from 'lucide'
import { Icon } from './Icon'
import { useStore } from '../store'
import {
	canUndoRun,
	clearAgent,
	describeAction,
	diffSummary,
	focusAgent,
	sendAgent,
	setAgentOpen,
	stopAgent,
	undoRun,
	useAgent,
	type AgentRun,
} from '../lib/agent'
import './agent.css'

const SUGGESTIONS = ['Explain this diagram', 'Add a cache between the API and the database', 'Make it left to right', 'Group the backend services']

/** Cmd/Ctrl+K anywhere opens the panel and focuses the input. */
function useAgentHotkey() {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
				e.preventDefault()
				e.stopPropagation()
				focusAgent()
			}
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	}, [])
}

function RunActions({ run, last }: { run: AgentRun; last: boolean }) {
	const code = useStore((s) => s.code)
	const past = useStore((s) => s.past)
	if (!run.actions.length && !run.pending) return null
	const undoable = last && canUndoRun(run, code, past)
	return (
		<div className={`agent-run${run.undone ? ' undone' : ''}`}>
			<div className="agent-run-head">
				<span>{run.undone ? 'Undone' : `${run.actions.length} action${run.actions.length === 1 ? '' : 's'}`}</span>
				{run.diff && <span className="diff" title={diffSummary(run.diff)}>{diffSummary(run.diff)}</span>}
				<span className="spacer" />
				{last && run.before && !run.undone && run.status !== 'streaming' && (
					<button
						className="agent-undo"
						disabled={!undoable}
						title={undoable ? 'Revert everything this run changed (one undo step)' : 'The diagram changed after this run; use Cmd+Z history instead'}
						onClick={() => undoRun(run)}
					>
						<Icon icon={Undo2} size={12} /> Undo AI change
					</button>
				)}
			</div>
			<ul className="agent-actions">
				{run.actions.map((a, i) => {
					const d = describeAction(a)
					return (
						<li key={i} className="agent-action">
							<span className="sym">{d.sym}</span>
							<span className="what">{d.what}</span>
							<span className="name" title={d.name}>
								{d.name}
							</span>
						</li>
					)
				})}
				{run.status === 'streaming' && run.pending > 0 && (
					<li className="agent-action">
						<span className="sym">
							<Icon icon={LoaderCircle} size={11} className="spin" />
						</span>
						<span className="what">drafting {run.pending} action{run.pending === 1 ? '' : 's'}…</span>
					</li>
				)}
			</ul>
			{run.errors.length > 0 && run.status !== 'streaming' && (
				<div className="agent-run-errors">
					{run.errors.slice(0, 3).map((e, i) => (
						<div key={i}>{e}</div>
					))}
				</div>
			)}
		</div>
	)
}

function RunView({ run, last }: { run: AgentRun; last: boolean }) {
	return (
		<>
			<div className="agent-user">
				{run.prompt}
				{run.selection.length > 0 && <span className="agent-sel">on {run.selection.join(', ')}</span>}
			</div>
			<div className="agent-reply">
				{run.text && <div className="agent-text">{run.text.trim()}</div>}
				<RunActions run={run} last={last} />
				{run.status === 'streaming' && !run.text && !run.pending && !run.actions.length && (
					<div className="agent-status">
						<Icon icon={LoaderCircle} size={13} className="spin" /> {run.mode === 'explain' ? 'Reading the diagram…' : 'Thinking…'}
					</div>
				)}
				{run.status === 'stopped' && <div className="agent-status">Stopped.</div>}
				{run.status === 'error' && <div className="agent-error">{run.error}</div>}
			</div>
		</>
	)
}

export function AgentPanel() {
	const open = useAgent((s) => s.open)
	const runs = useAgent((s) => s.runs)
	const focusTick = useAgent((s) => s.focusTick)
	const selected = useStore((s) => (s.selection?.kind === 'node' ? s.selection.key : null))
	const [input, setInput] = useState('')
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const logRef = useRef<HTMLDivElement>(null)
	const busy = runs.some((r) => r.status === 'streaming')
	useAgentHotkey()

	useEffect(() => {
		if (open) requestAnimationFrame(() => inputRef.current?.focus())
	}, [focusTick, open])

	useEffect(() => {
		const el = logRef.current
		if (el) el.scrollTop = el.scrollHeight
	}, [runs])

	useEffect(() => {
		const el = inputRef.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, 140)}px`
	}, [input])

	if (!open) return null

	const submit = (text = input) => {
		if (!text.trim() || busy) return
		void sendAgent(text)
		setInput('')
	}

	return (
		<aside className="agent-panel" aria-label="AI agent">
			<div className="agent-head">
				<Icon icon={Bot} size={15} />
				<span>Agent</span>
				<span className="spacer" />
				{runs.length > 0 && (
					<button className="icon-btn" title="Clear conversation" aria-label="Clear conversation" onClick={clearAgent}>
						<Icon icon={Trash2} size={14} />
					</button>
				)}
				<button className="icon-btn" title="Close (Cmd+K to reopen)" aria-label="Close agent panel" onClick={() => setAgentOpen(false)}>
					<Icon icon={X} size={15} />
				</button>
			</div>
			<div className="agent-log" ref={logRef}>
				{runs.length === 0 ? (
					<div className="agent-empty">
						<p>Ask the agent to change or explain the diagram. It edits the code with small actions you can review and undo in one step.</p>
						<div className="agent-suggest">
							{SUGGESTIONS.map((s) => (
								<button key={s} onClick={() => submit(s)}>
									{s}
								</button>
							))}
						</div>
					</div>
				) : (
					runs.map((r, i) => <RunView key={r.id} run={r} last={i === runs.length - 1} />)
				)}
			</div>
			<form
				className="agent-compose"
				onSubmit={(e) => {
					e.preventDefault()
					submit()
				}}
			>
				{selected && (
					<div className="agent-context">
						<span>Context:</span>
						<span className="agent-chip">{selected}</span>
					</div>
				)}
				<div className="agent-input">
					<textarea
						ref={inputRef}
						rows={1}
						value={input}
						placeholder={selected ? `Change ${selected}…` : 'Add a cache between API and DB…'}
						aria-label="Message the agent"
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault()
								submit()
							}
							if (e.key === 'Escape') e.currentTarget.blur()
						}}
					/>
					{busy ? (
						<button type="button" className="agent-send" title="Stop" aria-label="Stop" onClick={stopAgent}>
							<Icon icon={Square} size={12} />
						</button>
					) : (
						<button type="submit" className="agent-send" title="Send (Enter)" aria-label="Send" disabled={!input.trim()}>
							<Icon icon={ArrowUp} size={15} />
						</button>
					)}
				</div>
				<div className="agent-hint">
					<kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> new line · <kbd>⌘K</kbd> focus
				</div>
			</form>
		</aside>
	)
}
