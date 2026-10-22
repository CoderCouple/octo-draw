import { StickyNote, Circle, Eraser, Hand, Maximize, Minus, MousePointer2, MoveUpRight, Pencil, Plus, Redo2, Square, Type, Undo2, WandSparkles, Trash } from 'lucide'
import { Icon } from './Icon'
import { pushHistory, redo, requestFit, selectedIds, setCode, undo, useStore, type Tool } from '../store'
import { useCamera, zoomAt } from '../canvas/camera'
import { setEdgeProp, setNodeProp } from '@octo-draw/core'
import { INK_COLORS, NODE_COLORS, PALETTE, inkColor } from '../lib/colors'
import { useTheme } from '../lib/theme'
import { deleteSelection, tidy } from '../lib/actions'

const TOOLS: { id: Tool; icon: unknown; label: string; key: string }[] = [
	{ id: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
	{ id: 'hand', icon: Hand, label: 'Hand', key: 'H' },
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
	const nodeKey = useStore((s) => (s.selection?.kind === 'node' ? s.selection.key : null))
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
								onClick={() => setCode(setNodeProp(useStore.getState().code, nodeKey, 'color', c === 'none' ? null : c))}
							/>
						))}
					</div>
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
								onClick={() => setCode(setEdgeProp(useStore.getState().code, edgeKey, 'color', c === 'none' ? null : c))}
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
	const pinned = useStore((s) => Object.keys(s.pins).length)
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
