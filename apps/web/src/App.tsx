import { useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, X } from 'lucide'
import { TopBar } from './components/TopBar'
import { Editor } from './editor/Editor'
import { Canvas } from './canvas/Canvas'
import { AgentPanel } from './components/AgentPanel'
import { Toolbar, ZoomControls, TOOL_KEYS } from './components/CanvasChrome'
import { PasteDialog } from './components/PasteDialog'
import { Icon } from './components/Icon'
import { dismissToast, redo, requestFit, undo, useStore } from './store'
import { deleteSelection } from './lib/actions'
import { handlePaste } from './lib/importing'
import { zoomAt, useCamera } from './canvas/camera'
import { usePeers, type ConnState } from './lib/sync'

const SPLIT_KEY = 'octo-draw:split'

function readSplit() {
	try {
		const v = Number(localStorage.getItem(SPLIT_KEY))
		return v > 15 && v < 85 ? v : 34
	} catch {
		return 34
	}
}

const CONN_LABEL: Record<ConnState, string> = { off: '', connecting: 'Connecting…', synced: 'Synced', syncing: 'Syncing…', reconnecting: 'Reconnecting…', offline: 'Offline' }
const CONN_TITLE: Record<ConnState, string> = {
	off: '',
	connecting: 'Connecting to the live document',
	synced: 'All changes saved to the live document',
	syncing: 'Sending changes',
	reconnecting: 'Connection lost; your edits are kept and will be sent when it is back',
	offline: 'Offline; your edits are kept locally and sent when the server is back',
}

function ConnStatus() {
	const conn = usePeers((s) => s.conn)
	if (conn === 'off') return null
	return (
		<span className={`conn ${conn}`} title={CONN_TITLE[conn]}>
			<span className="conn-dot" />
			{CONN_LABEL[conn]}
		</span>
	)
}

function StatusBar() {
	const diagnostics = useStore((s) => s.diagnostics)
	const pending = useStore((s) => s.layoutPending)
	const counts = useStore((s) => (s.ir ? `${s.ir.nodes.length} nodes · ${s.ir.edges.length} edges` : ''))
	const errors = diagnostics.filter((d) => d.severity === 'error')
	const warnings = diagnostics.length - errors.length
	return (
		<div className="statusbar">
			{errors.length ? (
				<span className="status-err" title={errors[0].message}>
					<Icon icon={CircleAlert} size={13} /> {errors.length} error{errors.length > 1 ? 's' : ''} · showing last good diagram
				</span>
			) : (
				<span className="status-ok">
					<Icon icon={pending ? LoaderCircle : CircleCheck} size={13} className={pending ? 'spin' : ''} />
					{warnings ? `${warnings} warning${warnings > 1 ? 's' : ''}` : 'No errors'}
				</span>
			)}
			<span className="muted statusbar-right">
				{counts}
				<ConnStatus />
			</span>
		</div>
	)
}

function ToastView() {
	const toast = useStore((s) => s.toast)
	if (!toast) return null
	return (
		<div className="toast" key={toast.id} role="status">
			<span>{toast.message}</span>
			{toast.actions?.map((a) => (
				<button
					key={a.label}
					className="toast-action"
					onClick={() => {
						dismissToast()
						a.run()
					}}
				>
					{a.label}
				</button>
			))}
			<button className="icon-btn" onClick={dismissToast} aria-label="Dismiss">
				<Icon icon={X} size={13} />
			</button>
		</div>
	)
}

function useGlobalKeys() {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement
			const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
			const mod = e.metaKey || e.ctrlKey
			if (mod && e.key.toLowerCase() === 'z' && !typing) {
				e.preventDefault()
				if (e.shiftKey) redo()
				else undo()
				return
			}
			if (mod && e.key.toLowerCase() === 'y' && !typing) {
				e.preventDefault()
				redo()
				return
			}
			if (typing) return
			if (mod && (e.key === '=' || e.key === '+')) {
				e.preventDefault()
				zoomAt(1.2)
				return
			}
			if (mod && e.key === '-') {
				e.preventDefault()
				zoomAt(1 / 1.2)
				return
			}
			if (mod && e.key === '0') {
				e.preventDefault()
				useCamera.setState({ z: 1 })
				return
			}
			if (mod || e.altKey) return
			if (e.key === '!' || (e.shiftKey && e.code === 'Digit1')) {
				requestFit(true)
				return
			}
			if (e.key === 'Delete' || e.key === 'Backspace') {
				e.preventDefault()
				deleteSelection()
				return
			}
			if (e.key === 'Escape') {
				useStore.setState({ selection: null, tool: 'select' })
				return
			}
			const tool = TOOL_KEYS[e.key.toLowerCase()]
			if (tool && !e.shiftKey) useStore.setState({ tool })
		}
		window.addEventListener('keydown', onKey)
		window.addEventListener('paste', handlePaste)
		return () => {
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('paste', handlePaste)
		}
	}, [])
}

export function App() {
	const [split, setSplit] = useState(readSplit)
	const [pasteOpen, setPasteOpen] = useState(false)
	const mainRef = useRef<HTMLDivElement>(null)
	const [dragging, setDragging] = useState(false)
	useGlobalKeys()

	const onSplitDown = (e: React.PointerEvent) => {
		e.preventDefault()
		;(e.target as HTMLElement).setPointerCapture(e.pointerId)
		setDragging(true)
	}
	const onSplitMove = (e: React.PointerEvent) => {
		if (!dragging || !mainRef.current) return
		const r = mainRef.current.getBoundingClientRect()
		const pct = Math.max(18, Math.min(75, ((e.clientX - r.left) / r.width) * 100))
		setSplit(pct)
	}
	const onSplitUp = () => {
		if (!dragging) return
		setDragging(false)
		try {
			localStorage.setItem(SPLIT_KEY, String(split))
		} catch {
			// ignore
		}
	}

	return (
		<div className={`app${dragging ? ' resizing' : ''}`}>
			<TopBar onPasteDialog={() => setPasteOpen(true)} />
			<main className="main" ref={mainRef}>
				<section className="code-pane" style={{ width: `${split}%` }}>
					<div className="pane-head">
						<span>Diagram code</span>
						<span className="muted small">octo DSL</span>
					</div>
					<Editor />
					<StatusBar />
				</section>
				<div className="splitter" onPointerDown={onSplitDown} onPointerMove={onSplitMove} onPointerUp={onSplitUp} onDoubleClick={() => setSplit(34)} role="separator" aria-orientation="vertical" />
				<section className="canvas-pane">
					<Canvas />
					<Toolbar />
					<ZoomControls />
				</section>
				<AgentPanel />
			</main>
			<ToastView />
			{pasteOpen && <PasteDialog onClose={() => setPasteOpen(false)} />}
		</div>
	)
}
