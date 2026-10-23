import { useEffect, useRef, useState } from 'react'
import { StickyNote, Circle, Eraser, Hand, Maximize, Minus, MousePointer2, MoveUpRight, Pencil, Plus, Redo2, Square, Type, Undo2, WandSparkles, Trash, Boxes, ListTree, Group, Ungroup, SquareArrowOutDownRight, ChevronDown, LoaderCircle, Layers, X } from 'lucide'
import { Icon } from './Icon'
import { IconPickerButton } from './IconPicker'
import { pushHistory, redo, requestFit, selectedIds, setCode, undo, useStore, type Tool } from '../store'
import { useCamera, zoomAt } from '../canvas/camera'
import { setEdgeProp, setNodeProp } from '../lib/drillCore'
import { currentLevels, currentPins, maxGroupDepth, setLevels } from '../lib/view'
import { addChildTo, addSubDiagramFor, groupSelection, ungroupSelection } from '../lib/compose'
import { cancelExpand, expandDepth, expandNode, setExpandDepth, type ExpandMode } from '../lib/expand'
import { INK_COLORS, NODE_COLORS, PALETTE, inkColor } from '../lib/colors'
import { useTheme } from '../lib/theme'
import { deleteSelection, tidy } from '../lib/actions'

const TOOLS: { id: Tool; icon: unknown; label: string; key: string }[] = [
	{ id: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
	{ id: 'hand', icon: Hand, label: 'Hand', key: 'H' },
	{ id: 'component', icon: Boxes, label: 'Component: drag to add a node (inside a container nests it; around nodes groups them)', key: 'C' },
	{ id: 'pen', icon: Pencil, label: 'Pen', key: 'P' },
	{ id: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
	{ id: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
	{ id: 'arrow', icon: MoveUpRight, label: 'Arrow', key: 'A' },
	{ id: 'text', icon: Type, label: 'Text', key: 'T' },
	{ id: 'sticky', icon: StickyNote, label: 'Sticky note', key: 'N' },
	{ id: 'eraser', icon: Eraser, label: 'Eraser', key: 'E' },
]

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]))

export function Toolbar() {
	const tool = useStore((s) => s.tool)
	const ink = useStore((s) => s.ink)
	const size = useStore((s) => s.size)
	const hasSel = useStore((s) => s.selection !== null)
	const shapeSel = useStore((s) => selectedIds(s.selection).length > 0)
	const edgeKey = useStore((s) => (s.selection?.kind === 'edge' ? s.selection.key : null))
	const nodeKey = useStore((s) => (s.selection?.kind === 'node' && !s.selection.key.startsWith('ghost:') ? s.selection.key : null))
	const multiKeys = useStore((s) => (s.selection?.kind === 'multi' ? s.selection.keys.length : 0))
	const theme = useTheme()
	const drawing = tool !== 'select' && tool !== 'hand' && tool !== 'eraser'
	return (
		<div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
			<div className="tool-group">
				{TOOLS.map((t) => (
					<button
						key={t.id}
						className={`tool${tool === t.id ? ' on' : ''}`}
						title={`${t.label} (${t.key})`}
						aria-label={t.label}
						onClick={() => useStore.setState({ tool: t.id })}
					>
						<Icon icon={t.icon} size={17} />
						<span className="tool-key">{t.key}</span>
					</button>
				))}
			</div>
			{nodeKey && (
				<>
					<div className="tool-sep" />
					<div className="tool-group">
						{NODE_COLORS.map((c) => (
							<button
								key={c}
								className={`swatch${c === 'none' ? ' swatch-none' : ''}`}
								style={{ background: c === 'none' ? 'transparent' : PALETTE[c] }}
								title={c === 'none' ? 'No color' : c}
								aria-label={c === 'none' ? 'No color' : `Color ${c}`}
								onClick={() => setCode(setNodeProp(useStore.getState().code, nodeKey, 'color', c === 'none' ? null : c, useStore.getState().page))}
							/>
						))}
					</div>
					<div className="tool-sep" />
					<IconPickerButton nodeKey={nodeKey} />
					<div className="tool-sep" />
					<NodeDepthActions nodeKey={nodeKey} />
				</>
			)}
			{multiKeys > 1 && (
				<>
					<div className="tool-sep" />
					<button className="tool wide" title="Group selection (⌘G)" onClick={() => groupSelection()}>
						<Icon icon={Group} size={16} />
						<span>Group</span>
					</button>
				</>
			)}
			{edgeKey && (
				<>
					<div className="tool-sep" />
					<div className="tool-group">
						{NODE_COLORS.map((c) => (
							<button
								key={c}
								className={`swatch${c === 'none' ? ' swatch-none' : ''}`}
								style={{ background: c === 'none' ? 'transparent' : PALETTE[c] }}
								title={c === 'none' ? 'Default color' : c}
								aria-label={c === 'none' ? 'Default connection color' : `Connection color ${c}`}
								onClick={() => setCode(setEdgeProp(useStore.getState().code, edgeKey, 'color', c === 'none' ? null : c, useStore.getState().page))}
							/>
						))}
					</div>
				</>
			)}
			{(drawing || shapeSel) && (
				<>
					<div className="tool-sep" />
					<div className="tool-group">
						{INK_COLORS.map((c) => (
							<button
								key={c}
								className={`swatch${ink === c ? ' on' : ''}`}
								style={{ background: inkColor(c, theme) }}
								aria-label={`Color ${c}`}
								onClick={() => {
									useStore.setState({ ink: c })
									updateSelection({ color: c })
								}}
							/>
						))}
					</div>
					<div className="tool-sep" />
					<div className="tool-group">
						{[1, 2, 3, 4].map((n) => (
							<button key={n} className={`tool size${size === n ? ' on' : ''}`} title={`Stroke ${n}`} onClick={() => {
									useStore.setState({ size: n })
									updateSelection({ size: n })
								}}>
								<span className="dot" style={{ width: 2 + n * 2.5, height: 2 + n * 2.5 }} />
							</button>
						))}
					</div>
				</>
			)}
			{hasSel && (
				<>
					<div className="tool-sep" />
					<button className="tool" title="Delete (Del)" aria-label="Delete selection" onClick={deleteSelection}>
						<Icon icon={Trash} size={16} />
					</button>
				</>
			)}
		</div>
	)
}

/** Selected node: nest inside, sub-diagram (add / open), expand (auto / source / AI, depth), ungroup. */
function NodeDepthActions({ nodeKey }: { nodeKey: string }) {
	const target = useStore((s) => s.drill[nodeKey])
	const flow = useStore((s) => s.ir?.kind === 'flowchart')
	const isGroup = useStore((s) => !!s.layout?.nodes[nodeKey]?.isContainer)
	const expandable = useStore((s) => s.expandable[nodeKey])
	const expanding = useStore((s) => s.expanding?.key === nodeKey)
	return (
		<div className="tool-group">
			{flow && (
				<button className="tool" title="Add a component inside (Tab)" aria-label="Add a component inside" onClick={() => addChildTo(nodeKey)}>
					<Icon icon={Plus} size={16} />
				</button>
			)}
			<button className="tool wide" title={target ? `Open sub-diagram "${target}" (⌘↵)` : 'Add an empty sub-diagram page for this node (⌘↵)'} onClick={() => addSubDiagramFor(nodeKey)}>
				<Icon icon={ListTree} size={16} />
				<span>{target ? 'Open' : 'Sub-diagram'}</span>
			</button>
			{!target && expandable && <ExpandButton nodeKey={nodeKey} hasSrc={expandable === 'src'} busy={expanding} />}
			{isGroup && flow && (
				<button className="tool" title="Ungroup (⇧⌘G)" aria-label="Ungroup" onClick={() => ungroupSelection()}>
					<Icon icon={Ungroup} size={16} />
				</button>
			)}
		</div>
	)
}

function ExpandButton({ nodeKey, hasSrc, busy }: { nodeKey: string; hasSrc: boolean; busy: boolean }) {
	const [open, setOpen] = useState(false)
	const [depth, setDepth] = useState(expandDepth)
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!open) return
		const close = (e: PointerEvent) => {
			if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false)
		}
		window.addEventListener('pointerdown', close, true)
		return () => window.removeEventListener('pointerdown', close, true)
	}, [open])
	const run = (mode: ExpandMode) => {
		setOpen(false)
		void expandNode(nodeKey, mode, depth)
	}
	const step = (d: number) => {
		const next = Math.max(1, Math.min(5, depth + d))
		setDepth(next)
		setExpandDepth(next)
	}
	if (busy) {
		return (
			<button className="tool wide" title="Cancel expansion" onClick={cancelExpand}>
				<Icon icon={LoaderCircle} size={16} className="spin" />
				<span>Expanding…</span>
				<Icon icon={X} size={13} />
			</button>
		)
	}
	return (
		<div className="menu split" ref={ref}>
			<button className="tool wide" title="Expand into a new sub-diagram (auto: from source when possible, else AI)" onClick={() => run('auto')}>
				<Icon icon={SquareArrowOutDownRight} size={16} />
				<span>Expand</span>
			</button>
			<button className="tool caret" aria-label="Expand options" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
				<Icon icon={ChevronDown} size={13} />
			</button>
			{open && (
				<div className="menu-pop expand-menu" role="menu">
					<button className="menu-item" onClick={() => run('auto')}>
						<span className="menu-label">Auto</span>
						<span className="muted small">{hasSrc ? 'from source' : 'with AI'}</span>
					</button>
					<button className="menu-item" disabled={!hasSrc} onClick={() => run('source')} title={hasSrc ? undefined : 'This node has no src: reference'}>
						<span className="menu-label">From source</span>
						<span className="muted small">{hasSrc ? 'src:' : 'no src'}</span>
					</button>
					<button className="menu-item" onClick={() => run('ai')}>
						<span className="menu-label">With AI</span>
						<span className="muted small">streams</span>
					</button>
					<div className="menu-sep" />
					<div className="stepper" aria-label="Depth">
						<span>Depth</span>
						<button className="icon-btn" onClick={() => step(-1)} disabled={depth <= 1} aria-label="Less depth">
							<Icon icon={Minus} size={13} />
						</button>
						<span className="stepper-value">{depth}</span>
						<button className="icon-btn" onClick={() => step(1)} disabled={depth >= 5} aria-label="More depth">
							<Icon icon={Plus} size={13} />
						</button>
						<span className="muted small">{depth > 1 ? `${depth} levels of pages` : 'one page'}</span>
					</div>
				</div>
			)}
		</div>
	)
}

/** "Levels: All / 1 / 2 / 3…" for the current view's group nesting. */
export function LevelsControl() {
	const view = useStore((s) => s.focusIR)
	const level = useStore((s) => currentLevels(s))
	const max = maxGroupDepth(view)
	if (max < 1) return null
	const opts = Array.from({ length: max }, (_, i) => i + 1)
	return (
		<div className="levels pill" onPointerDown={(e) => e.stopPropagation()} role="group" aria-label="Visible levels">
			<span className="levels-label" title="How many levels of groups are open">
				<Icon icon={Layers} size={13} /> Levels
			</span>
			<button className={`levels-btn${level === null ? ' on' : ''}`} onClick={() => setLevels(null)} title="Everything open">
				All
			</button>
			{opts.map((n) => (
				<button key={n} className={`levels-btn${level === n ? ' on' : ''}`} onClick={() => setLevels(n)} title={n === 1 ? 'Top level only: every group collapsed' : `${n} levels open`}>
					{n}
				</button>
			))}
		</div>
	)
}

function updateSelection(patch: { color?: string; size?: number }) {
	const s = useStore.getState()
	const ids = new Set(selectedIds(s.selection))
	if (!ids.size) return
	pushHistory()
	useStore.setState({ shapes: s.shapes.map((x) => (ids.has(x.id) ? { ...x, ...patch } : x)) })
}

export function ZoomControls() {
	const z = useCamera((c) => c.z)
	const canUndo = useStore((s) => s.past.length > 0)
	const canRedo = useStore((s) => s.future.length > 0)
	const pinned = useStore((s) => Object.keys(currentPins(s)).length)
	return (
		<div className="zoombar" onPointerDown={(e) => e.stopPropagation()}>
			<div className="pill">
				<button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" aria-label="Undo">
					<Icon icon={Undo2} size={15} />
				</button>
				<button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)" aria-label="Redo">
					<Icon icon={Redo2} size={15} />
				</button>
			</div>
			<div className="pill">
				<button className="icon-btn" onClick={() => zoomAt(1 / 1.2)} title="Zoom out (⌘-)" aria-label="Zoom out">
					<Icon icon={Minus} size={15} />
				</button>
				<button className="zoom-pct" onClick={() => useCamera.setState({ z: 1 })} title="Reset zoom">
					{Math.round(z * 100)}%
				</button>
				<button className="icon-btn" onClick={() => zoomAt(1.2)} title="Zoom in (⌘+)" aria-label="Zoom in">
					<Icon icon={Plus} size={15} />
				</button>
				<button className="icon-btn" onClick={() => requestFit(true)} title="Zoom to fit (⇧1)" aria-label="Zoom to fit">
					<Icon icon={Maximize} size={15} />
				</button>
			</div>
			<button className={`pill tidy${pinned ? ' has' : ''}`} onClick={tidy} title="Clear pinned positions and re-run auto layout">
				<Icon icon={WandSparkles} size={15} />
				Tidy{pinned ? ` · ${pinned}` : ''}
			</button>
		</div>
	)
}
