import { useEffect, useRef } from 'react'
import { CornerDownRight, Focus, Group, ListTree, Plus, SquareArrowOutDownRight, Sparkles, Ungroup } from 'lucide'
import { selectedKeys, useStore } from '../store'
import { Icon } from '../components/Icon'
import { addChildTo, addSiblingOf, addSubDiagramFor, groupSelection, ungroupSelection } from '../lib/compose'
import { expandNode } from '../lib/expand'
import { focusOn } from '../lib/view'

export interface NodeMenuState {
	key: string
	x: number
	y: number
}

/** Right-click menu on a diagram node: nesting, sub-diagrams, expansion. */
export function NodeMenu({ state, onClose }: { state: NodeMenuState; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null)
	const s = useStore.getState()
	const node = s.ir?.nodes.find((n) => n.key === state.key)
	const isGroup = !!s.layout?.nodes[state.key]?.isContainer
	const multi = selectedKeys(s.selection).length > 1
	const target = s.drill[state.key]
	const flow = s.ir?.kind === 'flowchart'
	useEffect(() => {
		const close = (e: Event) => {
			if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
			onClose()
		}
		const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
		window.addEventListener('pointerdown', close, true)
		window.addEventListener('keydown', key)
		return () => {
			window.removeEventListener('pointerdown', close, true)
			window.removeEventListener('keydown', key)
		}
	}, [onClose])
	const item = (icon: unknown, label: string, hint: string, run: () => void, disabled = false) => (
		<button
			className="menu-item"
			disabled={disabled}
			onClick={() => {
				onClose()
				run()
			}}
		>
			<Icon icon={icon} size={15} />
			<span className="menu-label">{label}</span>
			{hint && <kbd className="menu-kbd">{hint}</kbd>}
		</button>
	)
	return (
		<div ref={ref} className="menu-pop node-menu" style={{ left: state.x, top: state.y }} role="menu" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
			<div className="menu-title">{node?.label ?? state.key}</div>
			{flow && item(Plus, 'Add component inside', 'Tab', () => addChildTo(state.key))}
			{flow && item(CornerDownRight, 'Add sibling', '', () => addSiblingOf(state.key))}
			{flow && isGroup && item(Focus, 'Focus group', 'dbl-click', () => focusOn(state.key))}
			<div className="menu-sep" />
			{item(ListTree, target ? 'Open sub-diagram' : 'Add sub-diagram', '⌘↵', () => addSubDiagramFor(state.key))}
			{!target && !isGroup && flow && item(Sparkles, 'Expand with AI', '', () => void expandNode(state.key, 'ai'))}
			{!target && !isGroup && flow && node?.ext?.src && item(SquareArrowOutDownRight, 'Expand from source', '', () => void expandNode(state.key, 'source'))}
			{flow && <div className="menu-sep" />}
			{flow && item(Group, multi ? 'Group selection' : 'Wrap in a group', '⌘G', () => groupSelection())}
			{flow && isGroup && item(Ungroup, 'Ungroup', '⇧⌘G', () => ungroupSelection())}
		</div>
	)
}
