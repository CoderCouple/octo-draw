import { useEffect, useRef, useState } from 'react'
import { ROOT_CRUMB } from '../lib/pages'
import { Monitor, Moon, Sun, Braces, ChevronDown, ClipboardPaste, CodeXml, Copy, FileImage, Image, ImageDown, LoaderCircle, Sparkles, Upload, X, GitFork, Bot, LayoutTemplate, Workflow, Cloud, ArrowLeftRight, Table, Layers } from 'lucide'
import { Icon } from './Icon'
import { pushHistory, requestFit, useStore } from '../store'
import { EXAMPLES, type Example } from '../examples'
import { cancelGenerate, generate, importImage } from '../lib/api'
import { setThemePref, useThemePref, type ThemePref } from '../lib/theme'
import { copyMermaid, copyOcto, downloadJson, downloadPng, downloadSvg } from '../lib/export'
import { setAgentOpen, useAgent } from '../lib/agent'
import { peerColor, peerName, usePeers } from '../lib/sync'

function Logo() {
	return (
		<div className="logo">
			<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
				<rect width="32" height="32" rx="8" fill="var(--primary)" />
				<circle cx="16" cy="13.5" r="6.5" fill="var(--primary-foreground)" />
				<path d="M9.5 17.5c0 5.5-3 8-3 8M13 19.5c0 4.5-1 7-1 7M19 19.5c0 4.5 1 7 1 7M22.5 17.5c0 5.5 3 8 3 8" stroke="var(--primary-foreground)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
			</svg>
			<span>octo-draw</span>
		</div>
	)
}

function Menu({ label, icon, children }: { label: string; icon: unknown; children: (close: () => void) => React.ReactNode }) {
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false)
		}
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
		window.addEventListener('pointerdown', onDown)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('pointerdown', onDown)
			window.removeEventListener('keydown', onKey)
		}
	}, [open])
	return (
		<div className="menu" ref={ref}>
			<button className={`btn ghost${open ? ' active' : ''}`} onClick={() => setOpen((o) => !o)}>
				<Icon icon={icon} size={15} />
				{label}
				<Icon icon={ChevronDown} size={13} />
			</button>
			{open && <div className="menu-pop">{children(() => setOpen(false))}</div>}
		</div>
	)
}

function MenuItem({ icon, label, hint, onClick }: { icon: unknown; label: string; hint?: string; onClick: () => void }) {
	return (
		<button className="menu-item" onClick={onClick}>
			<Icon icon={icon} size={15} />
			<span>{label}</span>
			{hint && <kbd>{hint}</kbd>}
		</button>
	)
}

const EXAMPLE_ICONS: Record<string, unknown> = { flowchart: Workflow, architecture: Cloud, sequence: ArrowLeftRight, erd: Table, drill: Layers }

/** Replaces the document with an example (undoable). */
function openExample(e: Example) {
	pushHistory()
	const prev = useStore.getState().layout
	useStore.setState({ code: e.code, pins: {}, selection: null, crumbs: [ROOT_CRUMB], page: '', collapsed: {} })
	// fit once the new layout lands (layout runs off-thread)
	const unsub = useStore.subscribe((s) => {
		if (s.layout === prev) return
		unsub()
		requestFit()
	})
	setTimeout(unsub, 4000)
}

const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON: Record<ThemePref, unknown> = { system: Monitor, light: Sun, dark: Moon }

/** Who else is in the document, plus what any agent is doing right now. */
function Peers() {
	const peers = usePeers((s) => s.peers)
	if (!peers.length) return null
	const busy = peers.find((p) => p.state.status === 'thinking' || p.state.status === 'drawing')
	return (
		<div className="peers">
			{busy && (
				<span className="peer-status" title={typeof busy.state.message === 'string' ? busy.state.message : undefined}>
					<Icon icon={LoaderCircle} size={13} className="spin" />
					{busy.origin.kind === 'agent' ? peerName(busy) : `${peerName(busy)}'s AI`} is {busy.state.status}…
				</span>
			)}
			<div className="peer-avatars">
				{peers.slice(0, 5).map((p) => {
					const name = peerName(p)
					return (
						<span key={p.sessionId} className="peer-avatar" title={`${name}${p.origin.kind === 'agent' ? ' (agent)' : ''}`} style={{ background: typeof p.state.color === 'string' ? p.state.color : peerColor(p.clientId) }}>
							{p.origin.kind === 'agent' ? <Icon icon={Bot} size={12} /> : name.replace(/[^A-Za-z0-9 ]/g, '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
						</span>
					)
				})}
			</div>
		</div>
	)
}

function AgentToggle() {
	const open = useAgent((s) => s.open)
	const busy = useAgent((s) => s.runs.some((r) => r.status === 'streaming'))
	return (
		<button
			className={`btn ghost${open ? ' active' : ''}`}
			title="AI agent chat (⌘K)"
			aria-pressed={open}
			onClick={() => setAgentOpen(!open)}
		>
			<Icon icon={busy ? LoaderCircle : Bot} size={15} className={busy ? 'spin' : ''} />
			Agent
		</button>
	)
}

function ThemeToggle() {
	const pref = useThemePref()
	return (
		<button
			className="icon-btn theme-toggle"
			title={`Theme: ${pref} (click for ${THEME_NEXT[pref]})`}
			aria-label={`Theme: ${pref}`}
			onClick={() => setThemePref(THEME_NEXT[pref])}
		>
			<Icon icon={THEME_ICON[pref]} size={16} />
		</button>
	)
}

export function TopBar({ onPasteDialog }: { onPasteDialog: () => void }) {
	const title = useStore((s) => s.title)
	const aiBusy = useStore((s) => s.aiBusy)
	const hasCode = useStore((s) => s.code.trim().length > 0)
	const [prompt, setPrompt] = useState('')
	const [mode, setMode] = useState<'new' | 'edit'>('new')
	const fileRef = useRef<HTMLInputElement>(null)
	const generating = !!aiBusy && aiBusy.startsWith('AI is')

	const submit = () => {
		if (!prompt.trim() || generating) return
		void generate(prompt, mode === 'edit' && hasCode)
	}

	return (
		<header className="topbar">
			<Logo />
			<div className="divider" />
			<input
				className="title-input"
				value={title}
				spellCheck={false}
				aria-label="Diagram title"
				onChange={(e) => useStore.setState({ title: e.target.value })}
				onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
			/>
			<form
				className={`ai-bar${generating ? ' busy' : ''}`}
				onSubmit={(e) => {
					e.preventDefault()
					submit()
				}}
			>
				<Icon icon={Sparkles} size={16} className="ai-spark" />
				<input
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder={mode === 'edit' ? 'Describe a change… e.g. "add a Redis cache between API and DB"' : 'Describe a diagram… e.g. "a RAG pipeline with vector store"'}
					aria-label="AI prompt"
				/>
				<div className="seg" role="group" aria-label="AI mode">
					<button type="button" className={mode === 'new' ? 'on' : ''} onClick={() => setMode('new')}>
						New
					</button>
					<button type="button" className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')} disabled={!hasCode}>
						Edit
					</button>
				</div>
				{generating ? (
					<button type="button" className="btn primary" onClick={cancelGenerate}>
						<Icon icon={X} size={14} /> Stop
					</button>
				) : (
					<button type="submit" className="btn primary" disabled={!prompt.trim()}>
						{mode === 'edit' && hasCode ? 'Edit' : 'Generate'}
					</button>
				)}
			</form>
			<div className="spacer" />
			<Peers />
			{aiBusy && (
				<div className="presence" title={aiBusy}>
					<Icon icon={LoaderCircle} size={14} className="spin" />
					{aiBusy}
				</div>
			)}
			<Menu label="Examples" icon={LayoutTemplate}>
				{(close) => (
					<>
						{EXAMPLES.map((ex) => (
							<MenuItem key={ex.id} icon={EXAMPLE_ICONS[ex.id] ?? LayoutTemplate} label={ex.label} onClick={() => (close(), openExample(ex))} />
						))}
					</>
				)}
			</Menu>
			<Menu label="Import" icon={Upload}>
				{(close) => (
					<>
						<MenuItem
							icon={Image}
							label="Image to diagram…"
							onClick={() => {
								close()
								fileRef.current?.click()
							}}
						/>
						<MenuItem
							icon={ClipboardPaste}
							label="Paste mermaid / ASCII…"
							onClick={() => {
								close()
								onPasteDialog()
							}}
						/>
					</>
				)}
			</Menu>
			<Menu label="Export" icon={ImageDown}>
				{(close) => (
					<>
						<MenuItem icon={Copy} label="Copy octo code" onClick={() => (close(), void copyOcto())} />
						<MenuItem icon={GitFork} label="Copy mermaid" onClick={() => (close(), void copyMermaid())} />
						<div className="menu-sep" />
						<MenuItem icon={CodeXml} label="Download SVG" onClick={() => (close(), void downloadSvg())} />
						<MenuItem icon={FileImage} label="Download PNG" onClick={() => (close(), void downloadPng())} />
						<MenuItem icon={Braces} label="Download JSON (IR)" onClick={() => (close(), downloadJson())} />
					</>
				)}
			</Menu>
			<AgentToggle />
			<ThemeToggle />
			<input
				ref={fileRef}
				type="file"
				accept="image/*"
				hidden
				onChange={(e) => {
					const f = e.target.files?.[0]
					if (f) void importImage(f)
					e.target.value = ''
				}}
			/>
		</header>
	)
}
