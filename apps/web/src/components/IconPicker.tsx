import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Shapes, X } from 'lucide'
import { setNodeProp } from '../lib/drillCore'
import { Icon } from './Icon'
import { IconGlyph } from '../canvas/DiagramLayer'
import { loadIcons, searchIconNames, useIcons } from '../lib/icons'
import { setCode, useStore } from '../store'

const cssVar = (name: string, fallback: string) => (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback

/** Toolbar button + searchable icon grid for the selected diagram node; picking writes `icon: name`. */
export function IconPickerButton({ nodeKey }: { nodeKey: string }) {
	const [open, setOpen] = useState<{ top: number; left: number } | null>(null)
	const ref = useRef<HTMLDivElement>(null)
	const popRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node
			if (!ref.current?.contains(t) && !popRef.current?.contains(t)) setOpen(null)
		}
		window.addEventListener('pointerdown', onDown)
		return () => window.removeEventListener('pointerdown', onDown)
	}, [open])
	// a different node closes the picker
	useEffect(() => setOpen(null), [nodeKey])
	return (
		<div className="icon-picker-anchor" ref={ref}>
			<button
				className={`tool icon-picker-btn${open ? ' on' : ''}`}
				title="Icon"
				aria-label="Choose icon"
				aria-expanded={!!open}
				onClick={(e) => {
					void loadIcons()
					// the toolbar scrolls and is transformed, so the popover is portaled and fixed-positioned
					const r = e.currentTarget.getBoundingClientRect()
					const w = 340
					setOpen((o) => (o ? null : { top: r.bottom + 10, left: Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) }))
				}}
			>
				<Icon icon={Shapes} size={16} />
				<span>Icon</span>
			</button>
			{open &&
				createPortal(
					<div ref={popRef} className="icon-picker" style={{ top: open.top, left: open.left }} onPointerDown={(e) => e.stopPropagation()}>
						<IconPicker nodeKey={nodeKey} onClose={() => setOpen(null)} />
					</div>,
					document.body,
				)}
		</div>
	)
}

function IconPicker({ nodeKey, onClose }: { nodeKey: string; onClose: () => void }) {
	const [query, setQuery] = useState('')
	const version = useIcons((s) => s.version)
	const current = useStore((s) => s.ir?.nodes.find((n) => n.key === nodeKey)?.icon)
	const inputRef = useRef<HTMLInputElement>(null)
	useEffect(() => inputRef.current?.focus(), [])
	const hits = useMemo(() => searchIconNames(query, 96), [query, version])
	const bg = cssVar('--popover', '#ffffff')
	const pick = (name: string | null) => {
		setCode(setNodeProp(useStore.getState().code, nodeKey, 'icon', name, useStore.getState().page))
		onClose()
	}
	return (
		<div className="icon-picker-body" role="dialog" aria-label="Choose icon">
			<div className="icon-picker-head">
				<input
					ref={inputRef}
					value={query}
					placeholder="Search icons… (aws lambda, postgres, queue)"
					spellCheck={false}
					aria-label="Search icons"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						e.stopPropagation()
						if (e.key === 'Escape') onClose()
						if (e.key === 'Enter' && hits[0]) pick(hits[0].name)
					}}
				/>
				{current && (
					<button className="icon-btn" title="Remove icon" aria-label="Remove icon" onClick={() => pick(null)}>
						<Icon icon={X} size={14} />
					</button>
				)}
			</div>
			<div className="icon-grid">
				{hits.map((h) => (
					<button key={h.name} className={`icon-cell${current === h.name ? ' on' : ''}`} title={`${h.label} — ${h.name}`} aria-label={h.label} onClick={() => pick(h.name)}>
						<svg width={22} height={22} viewBox="-1 -1 24 24" aria-hidden="true">
							<IconGlyph name={h.name} x={0} y={0} size={22} color="currentColor" surface={bg} />
						</svg>
						<span>{h.name}</span>
					</button>
				))}
				{!hits.length && <div className="icon-empty">{version ? 'No icons match' : 'Loading icons…'}</div>}
			</div>
		</div>
	)
}
