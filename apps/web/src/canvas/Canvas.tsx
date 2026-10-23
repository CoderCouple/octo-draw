import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DiagramLayout, Point } from '@octo-draw/core'
import { applyPins } from '@octo-draw/core/src/layout/pins'
import { makeSelection, pushHistory, selectedIds, selectedKeys, setShapes, snapshot, uid, useStore, type FreeShape, type Snapshot } from '../store'
import { SURFACE, inkColor } from '../lib/colors'
import { useTheme } from '../lib/theme'
import { fitBounds, panBy, screenToWorld, setViewport, useCamera, zoomAt } from './camera'
import { DiagramLayer } from './DiagramLayer'
import { AgentPresence, PeerCursors } from './AgentPresence'
import { ShapeView, STICKY_SIZE, resizeShape, shapeBounds, sizeFor, stickyLayout, textSize, translateShape, type Box } from './freehand'
import { hitEdge, marqueeHits, normBox, selectionBounds, withoutDescendants } from './selection'
import { resizeBox, snapMove, snapResize, snapTargets, type Guide, type HandleId } from './snap'
import { SelectionOverlay } from './SelectionOverlay'
import { insertImage } from '../lib/images'
import { duplicateSelection, handleCopy, isTypingTarget, selectAll } from '../lib/clipboard'
import { renameNode } from '../lib/actions'
import { makeMeasure, FONT_STACK } from '../lib/text'
import { setLocalCursor } from '../lib/sync'
import { currentPins, drillTo, exitFocusTo, focusOn, mergeCurrentPins, setCurrentPins, takeMorph, toggleCollapsed } from '../lib/view'
import { addChildTo, addSiblingOf, addSubDiagramFor, commitLabel, composingKey, drawComponent, groupSelection, reparentAfterDrag, selectParentOf, stopComposing, ungroupSelection } from '../lib/compose'
import { expandNode } from '../lib/expand'
import { animateCamera, cameraOnBox, viewportSize } from './camera'
import { NodeMenu, type NodeMenuState } from './NodeMenu'
import { pagePins } from '../lib/pages'
import { installNavigator } from './drillNav'
import { Breadcrumbs } from './Breadcrumbs'

type Gesture =
	| { type: 'pan'; sx: number; sy: number; cx: number; cy: number }
	| {
			type: 'move'
			ids: string[]
			keys: string[]
			origins: Record<string, Point>
			start: Point
			orig: FreeShape[]
			box: Box | null
			targets: Box[]
			moved: boolean
			before: Snapshot
			sx: number
			sy: number
			clicked: { id?: string; key?: string }
			shift: boolean
	  }
	| { type: 'marquee'; start: Point; sx: number; sy: number; baseIds: string[]; baseKeys: string[]; active: boolean; clickKey?: string; shift?: boolean }
	| { type: 'resize'; handle: HandleId; ids: string[]; startBox: Box; start: Point; orig: FreeShape[]; targets: Box[]; before: Snapshot; moved: boolean }
	| { type: 'endpoint'; id: string; which: 0 | 1; targets: Box[]; before: Snapshot; moved: boolean }
	| { type: 'draw'; start: Point }
	| { type: 'component'; start: Point; sx: number; sy: number }
	| { type: 'erase'; before: Snapshot; erased: boolean }

type Editing = { kind: 'node'; key: string; placeholder?: boolean } | { kind: 'text'; id: string; isNew: boolean } | null
/** how the label editor was left */
type EditEnd = 'enter' | 'tab' | 'escape' | 'blur'

const isTyping = (t: EventTarget | null) => {
	const el = t as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

export function Canvas() {
	const theme = useTheme()
	const ir = useStore((s) => s.ir)
	const layout = useStore((s) => s.layout)
	const shapes = useStore((s) => s.shapes)
	const allPins = useStore((s) => s.pins)
	const page = useStore((s) => s.page)
	const pageNames = useStore((s) => s.pageNames)
	const pins = useMemo(() => pagePins(allPins, page, pageNames), [allPins, page, pageNames])
	const drill = useStore((s) => s.drill)
	const expandable = useStore((s) => s.expandable)
	const expandingKey = useStore((s) => (s.expanding && s.expanding.page === s.page ? s.expanding.key : null))
	const editRequest = useStore((s) => s.editRequest)
	const [menu, setMenu] = useState<NodeMenuState | null>(null)
	const [composeBox, setComposeBox] = useState<Box | null>(null)
	const collapsedHere = useStore((s) => s.collapsed[s.page])
	const selection = useStore((s) => s.selection)
	const tool = useStore((s) => s.tool)
	const aiBusy = useStore((s) => s.aiBusy)
	const fitRequest = useStore((s) => s.fitRequest)

	const rootRef = useRef<HTMLDivElement>(null)
	const worldRef = useRef<SVGGElement>(null)
	const gesture = useRef<Gesture | null>(null)
	// pointer capture retargets click/dblclick to the root, so remember what was really hit
	const downTarget = useRef<Element | null>(null)
	const [dragPins, setDragPins] = useState<Record<string, Point> | null>(null)
	const [draft, setDraftState] = useState<FreeShape | null>(null)
	const draftRef = useRef<FreeShape | null>(null)
	const setDraft = (d: FreeShape | null) => {
		draftRef.current = d
		setDraftState(d)
	}
	const dragRef = useRef<Record<string, Point> | null>(null)
	const [editing, setEditing] = useState<Editing>(null)
	const [spaceDown, setSpaceDown] = useState(false)
	const [panning, setPanning] = useState(false)
	const [marquee, setMarquee] = useState<Box | null>(null)
	const [guides, setGuides] = useState<Guide[]>([])
	const fitStrict = useStore((s) => s.fitStrict)

	const liveLayout: DiagramLayout | null = useMemo(() => {
		if (!ir || !layout || !dragPins) return layout
		return applyPins(ir, layout, { ...pins, ...dragPins })
	}, [ir, layout, pins, dragPins])

	// camera → transform, imperatively (no React re-render while panning)
	useLayoutEffect(() => {
		setViewport(rootRef.current)
		const apply = (c: { x: number; y: number; z: number }) => {
			worldRef.current?.setAttribute('transform', `translate(${c.x} ${c.y}) scale(${c.z})`)
			const root = rootRef.current
			if (root) {
				const g = 22 * c.z
				root.style.backgroundSize = `${g}px ${g}px`
				root.style.backgroundPosition = `${c.x}px ${c.y}px`
				root.style.setProperty('--zoom', String(c.z))
			}
		}
		apply(useCamera.getState())
		return useCamera.subscribe(apply)
	}, [])

	const contentBounds = () => {
		const s = useStore.getState()
		const boxes = s.shapes.map(shapeBounds)
		if (s.layout && s.layout.bounds.w > 0) boxes.push(s.layout.bounds)
		if (!boxes.length) return null
		const x = Math.min(...boxes.map((b) => b.x))
		const y = Math.min(...boxes.map((b) => b.y))
		const r = Math.max(...boxes.map((b) => b.x + b.w))
		const bt = Math.max(...boxes.map((b) => b.y + b.h))
		return { x, y, w: r - x, h: bt - y }
	}

	useEffect(() => {
		if (fitRequest) fitBounds(contentBounds(), 1.25, fitStrict)
	}, [fitRequest])

	useEffect(() => installNavigator(() => worldRef.current, contentBounds), [])

	// collapsing/expanding a group: nodes glide to their new places, edges fade in
	const morphPending = useRef(false)
	const firstCollapse = useRef(true)
	const [morphing, setMorphing] = useState(false)
	useEffect(() => {
		if (firstCollapse.current) {
			firstCollapse.current = false
			return
		}
		morphPending.current = true
	}, [collapsedHere])
	useLayoutEffect(() => {
		if (!morphPending.current && !takeMorph()) return
		morphPending.current = false
		setMorphing(true)
		const t = setTimeout(() => setMorphing(false), 420)
		return () => clearTimeout(t)
	}, [layout])

	// Tab / Enter flow: once the new node is laid out, open its label editor and keep it in view
	useEffect(() => {
		const req = editRequest
		if (!req || !layout) return
		const s = useStore.getState()
		if (req.page !== s.page || s.layoutPending) return
		const box = layout.nodes[req.key]
		if (!box) return
		useStore.setState({ editRequest: null })
		setEditing({ kind: 'node', key: req.key, placeholder: req.placeholder })
		const cam = useCamera.getState()
		const vp = viewportSize()
		const parentKey = s.ir?.nodes.find((n) => n.key === req.key)?.parent
		const parentBox = parentKey ? layout.nodes[parentKey] : undefined
		// nested deep enough to be tiny: zoom smoothly onto the container being edited
		if (box.h * cam.z < 28 || box.w * cam.z < 40) {
			const target = parentBox ?? box
			const z = Math.min(1.25, cameraOnBox(target, 0.8).z)
			void animateCamera({ z, x: vp.w / 2 - (target.x + target.w / 2) * z, y: vp.h / 2 - (target.y + target.h / 2) * z }, 320)
			return
		}
		const sx = box.x * cam.z + cam.x
		const sy = box.y * cam.z + cam.y
		const margin = 48
		if (sx < margin || sy < margin + 60 || sx + box.w * cam.z > vp.w - margin || sy + box.h * cam.z > vp.h - margin) {
			void animateCamera({ z: cam.z, x: vp.w / 2 - (box.x + box.w / 2) * cam.z, y: vp.h / 2 - (box.y + box.h / 2) * cam.z }, 280)
		}
	}, [editRequest, layout])

	// wheel: pan, ctrl/pinch zoom (non-passive so we can preventDefault)
	useEffect(() => {
		const el = rootRef.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			if (isTyping(e.target) && (e.target as HTMLElement).closest('foreignObject') === null) return
			e.preventDefault()
			const r = el.getBoundingClientRect()
			const unit = e.deltaMode === 1 ? 16 : 1
			if (e.ctrlKey || e.metaKey) {
				const d = Math.max(-60, Math.min(60, e.deltaY * unit))
				zoomAt(Math.exp(-d * 0.01), e.clientX - r.left, e.clientY - r.top)
			} else {
				panBy(-e.deltaX * unit, -e.deltaY * unit)
			}
		}
		el.addEventListener('wheel', onWheel, { passive: false })
		return () => el.removeEventListener('wheel', onWheel)
	}, [])

	// keyboard: space-to-pan
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.code === 'Space' && !isTyping(e.target)) {
				e.preventDefault()
				setSpaceDown(true)
			}
		}
		const up = (e: KeyboardEvent) => {
			if (e.code === 'Space') setSpaceDown(false)
		}
		window.addEventListener('keydown', down)
		window.addEventListener('keyup', up)
		return () => {
			window.removeEventListener('keydown', down)
			window.removeEventListener('keyup', up)
		}
	}, [])

	// selection keys: Cmd+A, Cmd+D, arrows nudge; copy/cut write octo DSL + shapes to the clipboard
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTypingTarget(e.target)) return
			const mod = e.metaKey || e.ctrlKey
			const k = e.key.toLowerCase()
			if (mod && k === 'a') {
				e.preventDefault()
				selectAll()
				return
			}
			if (mod && k === 'd') {
				e.preventDefault()
				duplicateSelection()
				return
			}
			if (mod && k === 'g') {
				e.preventDefault()
				if (e.shiftKey) ungroupSelection()
				else groupSelection()
				return
			}
			if (e.key === 'Tab' && !mod && !e.altKey) {
				const s = useStore.getState()
				const key = s.selection?.kind === 'node' ? s.selection.key : null
				if (!key || isGhost(key) || !s.layout?.nodes[key] || s.ir?.kind !== 'flowchart') return
				e.preventDefault()
				if (e.shiftKey) selectParentOf(key)
				else addChildTo(key)
				return
			}
			if (mod && e.key === 'Enter') {
				const s = useStore.getState()
				const key = s.selection?.kind === 'node' ? s.selection.key : null
				if (!key || isGhost(key)) return
				e.preventDefault()
				addSubDiagramFor(key)
				return
			}
			if (!mod && (e.key === 'Enter' || e.key === 'F2')) {
				const s = useStore.getState()
				const key = s.selection?.kind === 'node' ? s.selection.key : null
				if (!key || isGhost(key) || !s.layout?.nodes[key]) return
				e.preventDefault()
				if (e.key === 'F2') setEditing({ kind: 'node', key })
				// right after naming a new component, Enter adds the next sibling
				else if (e.key === 'Enter' && !e.shiftKey && composingKey() === key) addSiblingOf(key)
				else if (s.drill[key]) drillTo(s.drill[key], key)
				else if (s.expandable[key] === 'src') void expandNode(key, 'auto')
				else if (s.layout.nodes[key].isContainer) focusOn(key)
				else if (s.ir?.nodes.find((n) => n.key === key)?.ext?.collapsed !== undefined) toggleCollapsed(key)
				else setEditing({ kind: 'node', key })
				return
			}
			if (!mod && e.key.startsWith('Arrow')) {
				const s = useStore.getState()
				const ids = new Set(selectedIds(s.selection))
				const keys = selectedKeys(s.selection)
				if (!ids.size && !keys.length) return
				e.preventDefault()
				const step = e.shiftKey ? 10 : 1
				const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
				const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
				pushHistory(snapshot(), 'nudge', 600)
				const pins = currentPins(s)
				for (const key of keys) {
					const n = s.layout?.nodes[key]
					if (n && !isGhost(key)) pins[key] = { x: n.x + dx, y: n.y + dy }
				}
				if (ids.size) useStore.setState({ shapes: s.shapes.map((x) => (ids.has(x.id) ? translateShape(x, dx, dy) : x)) })
				if (keys.length) setCurrentPins(pins, 'none')
			}
		}
		const onCopy = (e: ClipboardEvent) => handleCopy(e)
		const onCut = (e: ClipboardEvent) => handleCopy(e, true)
		window.addEventListener('keydown', onKey)
		window.addEventListener('copy', onCopy)
		window.addEventListener('cut', onCut)
		return () => {
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('copy', onCopy)
			window.removeEventListener('cut', onCut)
		}
	}, [])

	const eraseAt = (clientX: number, clientY: number) => {
		const hits = new Set<string>()
		for (const el of document.elementsFromPoint(clientX, clientY)) {
			const id = (el as HTMLElement).closest?.('[data-shape]')?.getAttribute('data-shape')
			if (id) hits.add(id)
		}
		if (!hits.size) return false
		const s = useStore.getState()
		setShapes(
			s.shapes.filter((x) => !hits.has(x.id)),
			'none',
		)
		return true
	}

	/** Targets for snapping, frozen at gesture start (everything not moving). */
	const snapTargetsFor = (ids: string[], keys: string[]) => {
		const s = useStore.getState()
		const lay = liveLayout ?? s.layout
		const skipKeys = new Set(keys)
		// a node's own ancestors refit around it and its descendants travel with it
		const parents = new Map((s.ir?.nodes ?? []).map((n) => [n.key, n.parent]))
		for (const k of keys) {
			let a = parents.get(k)
			let guard = 0
			while (a && guard++ < 64) {
				skipKeys.add(a)
				a = parents.get(a)
			}
		}
		for (const [k] of parents) {
			let a = parents.get(k)
			let guard = 0
			while (a && guard++ < 64) {
				if (keys.includes(a)) skipKeys.add(k)
				a = parents.get(a)
			}
		}
		return snapTargets(s.shapes, lay, new Set(ids), skipKeys)
	}
	const snapThreshold = () => 6 / useCamera.getState().z

	const beginMove = (e: React.PointerEvent, p: Point, ids: string[], keys: string[], clicked: { id?: string; key?: string }) => {
		const s = useStore.getState()
		const lay = liveLayout ?? s.layout
		const parents = new Map((s.ir?.nodes ?? []).map((n) => [n.key, n.parent]))
		const top = withoutDescendants(
			keys.filter((k) => lay?.nodes[k]),
			parents,
		)
		const origins: Record<string, Point> = {}
		for (const k of top) origins[k] = { x: lay!.nodes[k].x, y: lay!.nodes[k].y }
		gesture.current = {
			type: 'move',
			ids,
			keys: top,
			origins,
			start: p,
			orig: s.shapes,
			box: selectionBounds(s.shapes, lay, ids, top),
			targets: snapTargetsFor(ids, keys),
			moved: false,
			before: snapshot(),
			sx: e.clientX,
			sy: e.clientY,
			clicked,
			shift: e.shiftKey,
		}
	}

	const onPointerDown = (e: React.PointerEvent) => {
		if (editing) return
		if (e.button === 2) return
		const target = e.target as Element
		downTarget.current = target
		if (target.closest('foreignObject')) return
		const root = rootRef.current!
		root.setPointerCapture(e.pointerId)
		const p = screenToWorld(e.clientX, e.clientY)
		const s = useStore.getState()
		const panGesture = (): Gesture => {
			const c = useCamera.getState()
			setPanning(true)
			return { type: 'pan', sx: e.clientX, sy: e.clientY, cx: c.x, cy: c.y }
		}
		if (e.button === 1 || tool === 'hand' || spaceDown) {
			gesture.current = panGesture()
			return
		}
		const nodeKey = target.closest('[data-node]')?.getAttribute('data-node') ?? null
		const shapeId = target.closest('[data-shape]')?.getAttribute('data-shape') ?? null
		stopComposing()
		setMenu(null)
		if (tool === 'select' && !shapeId && !e.shiftKey) {
			const chevron = target.closest('[data-chevron]')?.getAttribute('data-chevron')
			if (chevron) {
				root.releasePointerCapture(e.pointerId)
				toggleCollapsed(chevron)
				return
			}
			const add = target.closest('[data-add]')
			if (add) {
				root.releasePointerCapture(e.pointerId)
				const key = add.getAttribute('data-add-key')!
				if (add.getAttribute('data-add') === 'child') addChildTo(key)
				else addSiblingOf(key)
				return
			}
			const exp = target.closest('[data-expand]')?.getAttribute('data-expand')
			if (exp && s.expandable[exp]) {
				root.releasePointerCapture(e.pointerId)
				void expandNode(exp, 'auto')
				return
			}
			const mark = target.closest('[data-drill]')?.getAttribute('data-drill')
			if (mark && s.drill[mark]) {
				root.releasePointerCapture(e.pointerId)
				drillTo(s.drill[mark], mark)
				return
			}
			if (nodeKey && isGhost(nodeKey)) {
				root.releasePointerCapture(e.pointerId)
				exitFocusTo(s.ir?.nodes.find((n) => n.key === nodeKey)?.ext?.ghostOf ?? nodeKey)
				return
			}
		}
		switch (tool) {
			case 'select': {
				const handle = target.closest('[data-handle]')?.getAttribute('data-handle') ?? null
				const ids = selectedIds(s.selection)
				const keys = selectedKeys(s.selection)
				if (handle === 'start' || handle === 'end') {
					gesture.current = { type: 'endpoint', id: ids[0], which: handle === 'start' ? 0 : 1, targets: snapTargetsFor(ids, []), before: snapshot(), moved: false }
					return
				}
				if (handle) {
					const box = selectionBounds(s.shapes, null, ids, [])
					if (box) {
						gesture.current = { type: 'resize', handle: handle as HandleId, ids, startBox: box, start: p, orig: s.shapes, targets: snapTargetsFor(ids, []), before: snapshot(), moved: false }
					}
					return
				}
				// press-drag on an unselected group's background draws a marquee (a click still selects
				// the group); its header, or the group once selected, drags it
				if (!shapeId && nodeKey && s.layout?.nodes[nodeKey]?.isContainer && !keys.includes(nodeKey) && !target.closest('[data-group-header]')) {
					gesture.current = { type: 'marquee', start: p, sx: e.clientX, sy: e.clientY, baseIds: e.shiftKey ? ids : [], baseKeys: e.shiftKey ? keys : [], active: false, clickKey: nodeKey, shift: e.shiftKey }
					return
				}
				if (shapeId || (nodeKey && s.layout?.nodes[nodeKey])) {
					const isShape = !!shapeId
					const already = isShape ? ids.includes(shapeId!) : keys.includes(nodeKey!)
					let nextIds = ids
					let nextKeys = keys
					if (e.shiftKey) {
						if (already) {
							// shift-click toggles off; no drag
							nextIds = isShape ? ids.filter((x) => x !== shapeId) : ids
							nextKeys = isShape ? keys : keys.filter((x) => x !== nodeKey)
							useStore.setState({ selection: makeSelection(nextIds, nextKeys) })
							return
						}
						nextIds = isShape ? [...ids, shapeId!] : ids
						nextKeys = isShape ? keys : [...keys, nodeKey!]
					} else if (!already) {
						nextIds = isShape ? [shapeId!] : []
						nextKeys = isShape ? [] : [nodeKey!]
					}
					useStore.setState({ selection: makeSelection(nextIds, nextKeys) })
					beginMove(e, p, nextIds, nextKeys, isShape ? { id: shapeId! } : { key: nodeKey! })
					return
				}
				const edgeKey = hitEdge(liveLayout ?? s.layout, p, 7 / useCamera.getState().z)
				if (edgeKey) {
					useStore.setState({ selection: { kind: 'edge', key: edgeKey } })
					return
				}
				if (!e.shiftKey) useStore.setState({ selection: null })
				gesture.current = { type: 'marquee', start: p, sx: e.clientX, sy: e.clientY, baseIds: e.shiftKey ? ids : [], baseKeys: e.shiftKey ? keys : [], active: false }
				return
			}
			case 'pen':
				setDraft({ id: uid(), type: 'pen', x: 0, y: 0, w: 0, h: 0, points: [[p.x, p.y, e.pressure || 0.5]], color: s.ink, size: s.size, pressure: e.pointerType === 'pen' })
				gesture.current = { type: 'draw', start: p }
				return
			case 'component':
				gesture.current = { type: 'component', start: p, sx: e.clientX, sy: e.clientY }
				setComposeBox({ x: p.x, y: p.y, w: 0, h: 0 })
				return
			case 'rect':
			case 'ellipse':
				setDraft({ id: uid(), type: tool, x: p.x, y: p.y, w: 0, h: 0, color: s.ink, size: s.size })
				gesture.current = { type: 'draw', start: p }
				return
			case 'arrow':
				setDraft({ id: uid(), type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [[p.x, p.y, 0.5], [p.x, p.y, 0.5]], color: s.ink, size: s.size })
				gesture.current = { type: 'draw', start: p }
				return
			case 'sticky': {
				const existing = shapeId && s.shapes.find((x) => x.id === shapeId && x.type === 'sticky')
				if (existing) {
					setEditing({ kind: 'text', id: existing.id, isNew: false })
				} else {
					const shape: FreeShape = { id: uid(), type: 'sticky', x: p.x - STICKY_SIZE / 2, y: p.y - STICKY_SIZE / 2, w: STICKY_SIZE, h: STICKY_SIZE, color: s.ink === 'ink' ? 'ink' : s.ink, size: s.size, text: '' }
					setShapes([...s.shapes, shape], 'none')
					useStore.setState({ tool: 'select', selection: { kind: 'shapes', ids: [shape.id] } })
					setEditing({ kind: 'text', id: shape.id, isNew: true })
				}
				root.releasePointerCapture(e.pointerId)
				return
			}
			case 'text': {
				const existing = shapeId && s.shapes.find((x) => x.id === shapeId && (x.type === 'text' || x.type === 'sticky'))
				if (existing) {
					setEditing({ kind: 'text', id: existing.id, isNew: false })
				} else {
					const shape: FreeShape = { id: uid(), type: 'text', x: p.x, y: p.y - sizeFor('text', s.size) / 2, w: 10, h: 10, color: s.ink, size: s.size, text: '' }
					setShapes([...s.shapes, shape], 'none')
					setEditing({ kind: 'text', id: shape.id, isNew: true })
				}
				root.releasePointerCapture(e.pointerId)
				return
			}
			case 'eraser': {
				const before = snapshot()
				gesture.current = { type: 'erase', before, erased: eraseAt(e.clientX, e.clientY) }
				return
			}
		}
	}

	const onPointerMove = (e: React.PointerEvent) => {
		setLocalCursor(screenToWorld(e.clientX, e.clientY))
		const g = gesture.current
		if (!g) return
		const noSnap = e.metaKey || e.ctrlKey
		switch (g.type) {
			case 'pan':
				useCamera.setState({ x: g.cx + e.clientX - g.sx, y: g.cy + e.clientY - g.sy })
				return
			case 'move': {
				if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) return
				g.moved = true
				const p = screenToWorld(e.clientX, e.clientY)
				let dx = p.x - g.start.x
				let dy = p.y - g.start.y
				if (e.shiftKey && !g.shift) {
					// shift while dragging locks to the dominant axis
					if (Math.abs(dx) > Math.abs(dy)) dy = 0
					else dx = 0
				}
				let lines: Guide[] = []
				if (g.box && !noSnap) {
					const snap = snapMove({ ...g.box, x: g.box.x + dx, y: g.box.y + dy }, g.targets, snapThreshold())
					dx += snap.dx
					dy += snap.dy
					lines = snap.guides
				}
				setGuides(lines)
				if (g.ids.length) {
					const ids = new Set(g.ids)
					setShapes(
						g.orig.map((x) => (ids.has(x.id) ? translateShape(x, dx, dy) : x)),
						'none',
					)
				}
				if (g.keys.length) {
					const next: Record<string, Point> = {}
					for (const k of g.keys) next[k] = { x: Math.round(g.origins[k].x + dx), y: Math.round(g.origins[k].y + dy) }
					// pinned descendants travel with a dragged container
					const st = useStore.getState()
					const parents = new Map((st.ir?.nodes ?? []).map((n) => [n.key, n.parent]))
					const moving = new Set(g.keys)
for (const [k, pin] of Object.entries(currentPins(st))) {
						if (moving.has(k)) continue
						let a = parents.get(k)
						let guard = 0
						while (a && !moving.has(a) && guard++ < 64) a = parents.get(a)
						if (a && moving.has(a)) next[k] = { x: Math.round(pin.x + dx), y: Math.round(pin.y + dy) }
					}
					dragRef.current = next
					setDragPins(next)
				}
				return
			}
			case 'marquee': {
				if (!g.active && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) return
				g.active = true
				const box = normBox(g.start, screenToWorld(e.clientX, e.clientY))
				setMarquee(box)
				const st = useStore.getState()
				const hits = marqueeHits(st.shapes, liveLayout ?? st.layout, box)
				useStore.setState({ selection: makeSelection([...new Set([...g.baseIds, ...hits.ids])], [...new Set([...g.baseKeys, ...hits.keys])]) })
				return
			}
			case 'resize': {
				g.moved = true
				const p = screenToWorld(e.clientX, e.clientY)
				const onlyText = g.ids.length === 1 && g.orig.find((x) => x.id === g.ids[0])?.type === 'text'
				let box = resizeBox(g.startBox, g.handle, p.x - g.start.x, p.y - g.start.y, e.shiftKey || onlyText)
				let lines: Guide[] = []
				if (!noSnap && !e.shiftKey && !onlyText) {
					const snap = snapResize(box, g.handle, g.targets, snapThreshold())
					box = snap.box
					lines = snap.guides
				}
				setGuides(lines)
				const ids = new Set(g.ids)
				setShapes(
					g.orig.map((x) => (ids.has(x.id) ? resizeShape(x, g.startBox, box) : x)),
					'none',
				)
				return
			}
			case 'endpoint': {
				g.moved = true
				let p = screenToWorld(e.clientX, e.clientY)
				let lines: Guide[] = []
				if (!noSnap) {
					const snap = snapMove({ x: p.x, y: p.y, w: 0, h: 0 }, g.targets, snapThreshold())
					p = { x: p.x + snap.dx, y: p.y + snap.dy }
					lines = snap.guides
				}
				setGuides(lines)
				const st = useStore.getState()
				setShapes(
					st.shapes.map((x) => {
						if (x.id !== g.id || !x.points) return x
						const pts = [...x.points]
						pts[g.which] = [p.x, p.y, 0.5]
						return { ...x, points: pts }
					}),
					'none',
				)
				return
			}
			case 'draw': {
				const events = (e.nativeEvent.getCoalescedEvents?.() ?? []).length ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent]
				const d = draftRef.current
				if (!d) return
				setDraft(((): FreeShape => {
					const p = screenToWorld(e.clientX, e.clientY)
					if (d.type === 'pen') {
						const pts = [...(d.points ?? [])]
						for (const ev of events) {
							const q = screenToWorld(ev.clientX, ev.clientY)
							const last = pts[pts.length - 1]
							if (last && Math.hypot(q.x - last[0], q.y - last[1]) < 0.5 / useCamera.getState().z) continue
							pts.push([q.x, q.y, ev.pressure || 0.5])
						}
						return { ...d, points: pts }
					}
					if (d.type === 'arrow') return { ...d, points: [d.points![0], [p.x, p.y, 0.5]] }
					let w = p.x - g.start.x
					let h = p.y - g.start.y
					if (e.shiftKey) {
						const m = Math.max(Math.abs(w), Math.abs(h))
						w = Math.sign(w || 1) * m
						h = Math.sign(h || 1) * m
					}
					return { ...d, w, h }
				})())
				return
			}
			case 'erase':
				if (eraseAt(e.clientX, e.clientY)) g.erased = true
				return
			case 'component':
				setComposeBox(normBox(g.start, screenToWorld(e.clientX, e.clientY)))
				return
		}
	}

	const onPointerUp = (e: React.PointerEvent) => {
		const g = gesture.current
		gesture.current = null
		rootRef.current?.releasePointerCapture?.(e.pointerId)
		setGuides([])
		if (!g) return
		const s = useStore.getState()
		switch (g.type) {
			case 'pan':
				setPanning(false)
				return
			case 'move':
				if (g.moved) {
					pushHistory(g.before)
					if (dragRef.current) mergeCurrentPins(dragRef.current)
					// dropped into / out of a container: re-parent in the code (same undo step)
					if (g.keys.length && liveLayout) reparentAfterDrag(g.keys, liveLayout)
				} else if (!g.shift && selectedIds(s.selection).length + selectedKeys(s.selection).length > 1) {
					// plain click inside a multi-selection narrows it to the clicked item
					useStore.setState({ selection: makeSelection(g.clicked.id ? [g.clicked.id] : [], g.clicked.key ? [g.clicked.key] : []) })
				}
				dragRef.current = null
				setDragPins(null)
				return
			case 'marquee':
				setMarquee(null)
				if (!g.active && g.clickKey) {
					const ids = g.shift ? selectedIds(s.selection) : []
					const keys = g.shift ? [...selectedKeys(s.selection), g.clickKey] : [g.clickKey]
					useStore.setState({ selection: makeSelection(ids, keys) })
				}
				return
			case 'resize':
			case 'endpoint':
				if (g.moved) pushHistory(g.before)
				return
			case 'erase':
				if (g.erased) pushHistory(g.before)
				return
			case 'component': {
				const box = composeBox ?? { x: g.start.x, y: g.start.y, w: 0, h: 0 }
				setComposeBox(null)
				const small = box.w < 8 && box.h < 8
				drawComponent(small ? { x: g.start.x - 70, y: g.start.y - 28, w: 140, h: 56 } : box, g.start)
				return
			}
			case 'draw': {
				const d = draftRef.current
				setDraft(null)
				if (!d) return
				let shape = d
				if (d.type === 'rect' || d.type === 'ellipse') {
					if (Math.abs(d.w) < 4 && Math.abs(d.h) < 4) shape = { ...d, x: d.x - 80, y: d.y - 50, w: 160, h: 100 }
					else shape = { ...d, x: Math.min(d.x, d.x + d.w), y: Math.min(d.y, d.y + d.h), w: Math.abs(d.w), h: Math.abs(d.h) }
				}
				if (d.type === 'arrow') {
					const [a, b] = d.points!
					if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 6) return
				}
				setShapes([...s.shapes, shape])
				if (d.type !== 'pen') useStore.setState({ tool: 'select', selection: { kind: 'shapes', ids: [shape.id] } })
				return
			}
		}
	}

	const onDragOver = (e: React.DragEvent) => {
		if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault()
	}
	const onDrop = (e: React.DragEvent) => {
		const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
		if (!files.length) return
		e.preventDefault()
		const p = screenToWorld(e.clientX, e.clientY)
		files.forEach((f, i) => void insertImage(f, { x: p.x + i * 24, y: p.y + i * 24 }))
	}

	const onDoubleClick = (e: React.MouseEvent) => {
		const target = (downTarget.current ?? e.target) as Element
		if (target.closest('foreignObject')) return
		const shapeId = target.closest('[data-shape]')?.getAttribute('data-shape')
		const s = useStore.getState()
		if (shapeId) {
			const sh = s.shapes.find((x) => x.id === shapeId)
			if (sh?.type === 'text' || sh?.type === 'sticky') setEditing({ kind: 'text', id: sh.id, isNew: false })
			return
		}
		const key = target.closest('[data-node]')?.getAttribute('data-node')
		if (!key || !s.layout?.nodes[key] || isGhost(key)) return
		if (target.closest('[data-chevron]')) return
		// drillable nodes open their page; a group header focuses the group; a collapsed group expands
		if (s.drill[key]) return drillTo(s.drill[key], key)
		if (target.closest('[data-expand]') || s.expandable[key] === 'src') return void expandNode(key, 'auto')
		if (s.layout.nodes[key].isContainer && target.closest('[data-group-header]')) return focusOn(key)
		if (s.ir?.nodes.find((n) => n.key === key)?.ext?.collapsed !== undefined) return toggleCollapsed(key)
		useStore.setState({ selection: { kind: 'node', key } })
		setEditing({ kind: 'node', key })
	}

	const selIds = selectedIds(selection)
	const selKeys = selectedKeys(selection)
	const selShapes = selIds.length ? shapes.filter((x) => selIds.includes(x.id)) : []
	const selNodes = selection?.kind === 'multi' ? selKeys.map((k) => liveLayout?.nodes[k]).filter((n): n is NonNullable<typeof n> => !!n) : []
	const overlayBox = selection?.kind === 'node' ? null : selectionBounds(shapes, liveLayout, selIds, selection?.kind === 'multi' ? selKeys : [])
	const singleArrow = selShapes.length === 1 && !selKeys.length && selShapes[0].type === 'arrow' ? selShapes[0] : null
	const overlayItems = selShapes.length + selNodes.length > 1 ? [...selShapes.map(shapeBounds), ...selNodes] : []
	const edgePts = selection?.kind === 'edge' ? (liveLayout?.edges[selection.key]?.points ?? null) : null
	const editingShape = editing?.kind === 'text' ? shapes.find((x) => x.id === editing.id) : undefined
	const aiCursor = aiBusy && liveLayout ? aiCursorPoint(liveLayout, ir?.nodes.map((n) => n.key) ?? []) : null

	const cursor = panning ? 'grabbing' : tool === 'hand' || spaceDown ? 'grab' : tool === 'select' ? 'default' : tool === 'text' ? 'text' : tool === 'eraser' ? 'cell' : 'crosshair'
	const surf = SURFACE[theme]

	return (
		<div
			ref={rootRef}
			className={`canvas-root${morphing ? ' octo-morph' : ''}`}
			data-tool={tool}
			style={{ cursor, backgroundColor: surf.bg, backgroundImage: `radial-gradient(${surf.dot} 1px, transparent 1px)` }}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onPointerLeave={() => setLocalCursor(null)}
			onDoubleClick={onDoubleClick}
			onDragOver={onDragOver}
			onDrop={onDrop}
			onContextMenu={(e) => {
				e.preventDefault()
				const key = (e.target as Element).closest('[data-node]')?.getAttribute('data-node')
				if (!key || isGhost(key) || tool !== 'select') return setMenu(null)
				const s = useStore.getState()
				if (!selectedKeys(s.selection).includes(key)) useStore.setState({ selection: { kind: 'node', key } })
				const r = rootRef.current!.getBoundingClientRect()
				setMenu({ key, x: e.clientX - r.left, y: e.clientY - r.top })
			}}
		>
			<svg className="canvas-svg" id="octo-canvas-svg">
				<g ref={worldRef} id="octo-world">
					{ir && liveLayout && (
						<DiagramLayer
							ir={ir}
							layout={liveLayout}
							theme={theme}
							selectedKey={selection?.kind === 'node' ? selection.key : null}
							editingKey={editing?.kind === 'node' ? editing.key : null}
							drill={drill}
							expandable={expandable}
							expandingKey={expandingKey}
							composable={tool === 'select' && !editing && ir.kind === 'flowchart'}
						/>
					)}
					<g data-layer="freehand">
						{shapes.map((sh) => (
							<ShapeView key={sh.id} shape={sh} theme={theme} hidden={editingShape?.id === sh.id} />
						))}
						{draft && <ShapeView shape={draft} theme={theme} complete={false} />}
					</g>
					{composeBox && (
						<rect data-export="skip" x={composeBox.x} y={composeBox.y} width={composeBox.w} height={composeBox.h} rx={10} fill={surf.select} fillOpacity={0.06} stroke={surf.select} strokeWidth={1.5 / useCamera.getState().z} strokeDasharray="6 4" pointerEvents="none" />
					)}
					{!editing && (
						<SelectionOverlay
							color={surf.select}
							bg={surf.bg}
							box={overlayBox}
							items={overlayItems}
							resizable={selShapes.length > 0 && !selKeys.length && tool === 'select'}
							endpoints={singleArrow?.points ? singleArrow.points.map(([x, y]) => ({ x, y })) : null}
							guides={guides}
							marquee={marquee}
							edge={edgePts}
						/>
					)}
					<g data-export="skip" pointerEvents="none">
						<AgentPresence />
						<PeerCursors />
						{aiCursor && (
							<g className="ai-cursor" style={{ transform: `translate(${aiCursor.x}px, ${aiCursor.y}px)` }}>
								<path d="M0,0 L0,18 L5,13.5 L8.5,21 L11.5,19.6 L8,12.4 L14.5,12 Z" fill={surf.text} stroke={surf.bg} strokeWidth={1.4} strokeLinejoin="round" />
								<rect x={14} y={18} width={30} height={18} rx={9} fill={surf.text} />
								<text x={29} y={30.5} textAnchor="middle" fontSize={11} fontWeight={700} fill={surf.bg} fontFamily={FONT_STACK.clean}>
									AI
								</text>
							</g>
						)}
					</g>
					{editing?.kind === 'node' && liveLayout?.nodes[editing.key] && ir && (
						<NodeLabelEditor
							box={liveLayout.nodes[editing.key]}
							initial={ir.nodes.find((n) => n.key === editing.key)?.label ?? editing.key}
							isGroup={liveLayout.nodes[editing.key].isContainer}
							placeholder={editing.placeholder}
							onDone={(value, how) => {
								const key = editing.key
								setEditing(null)
								if (editing.placeholder) {
									const next = commitLabel(key, how === 'escape' ? null : value, true)
									if (how === 'tab') addChildTo(next)
									else if (how !== 'enter') stopComposing()
								} else if (value !== null) renameNode(key, value)
							}}
						/>
					)}
					{editingShape?.type === 'sticky' && (
						<StickyEditor
							shape={editingShape}
							onDone={(value) => {
								const st = useStore.getState()
								const rest = st.shapes.filter((x) => x.id !== editingShape.id)
								const isNew = editing?.kind === 'text' && editing.isNew
								const text = value ?? editingShape.text ?? ''
								const next = st.shapes.map((x) => (x.id === editingShape.id ? { ...editingShape, text } : x))
								if (isNew) {
									pushHistory({ ...snapshot(), shapes: rest })
									setShapes(next, 'none')
								} else if (text !== editingShape.text) setShapes(next)
								setEditing(null)
							}}
						/>
					)}
					{editingShape && editingShape.type !== 'sticky' && (
						<TextShapeEditor
							shape={editingShape}
							color={inkColor(editingShape.color, theme)}
							onDone={(value) => {
								const st = useStore.getState()
								const rest = st.shapes.filter((x) => x.id !== editingShape.id)
								const isNew = editing?.kind === 'text' && editing.isNew
								if (value === null || !value.trim()) {
									if (isNew) setShapes(rest, 'none')
									else if (value !== null) setShapes(rest)
								} else {
									const size = textSize(editingShape)
									const m = makeMeasure('clean')(value, size)
									const updated = { ...editingShape, text: value, w: m.w, h: value.split('\n').length * size * 1.25 }
									const next = st.shapes.map((x) => (x.id === editingShape.id ? updated : x))
									if (isNew) {
										pushHistory({ ...snapshot(), shapes: rest })
										setShapes(next, 'none')
									} else setShapes(next)
								}
								setEditing(null)
							}}
						/>
					)}
				</g>
			</svg>
			<Breadcrumbs />
			{menu && <NodeMenu state={menu} onClose={() => setMenu(null)} />}
			{ir && !ir.nodes.length && !shapes.length && <EmptyPage />}
		</div>
	)
}

/** A brand-new (sub-)page: say how to start. */
function EmptyPage() {
	const page = useStore((s) => s.page)
	return (
		<div className="canvas-empty" aria-live="polite">
			<div className="canvas-empty-card">
				<strong>{page ? 'This sub-diagram is empty' : 'Nothing here yet'}</strong>
				<span>Type nodes in the code or draw here.</span>
				<span className="muted">
					Press <kbd>C</kbd> and drag to add a component · select one and press <kbd>Tab</kbd> to nest inside it
				</span>
			</div>
		</div>
	)
}

const isGhost = (key: string) => useStore.getState().ir?.nodes.find((n) => n.key === key)?.ext?.ghost === 'true'

function aiCursorPoint(layout: DiagramLayout, order: string[]): Point | null {
	for (let i = order.length - 1; i >= 0; i--) {
		const n = layout.nodes[order[i]]
		if (n && !n.isContainer) return { x: n.x + n.w - 10, y: n.y + n.h - 8 }
	}
	return null
}

function NodeLabelEditor({ box, initial, isGroup, placeholder, onDone }: { box: { x: number; y: number; w: number; h: number }; initial: string; isGroup: boolean; placeholder?: boolean; onDone: (v: string | null, how: EditEnd) => void }) {
	const ref = useRef<HTMLInputElement>(null)
	const done = useRef(false)
	const mountedAt = useRef(performance.now())
	useEffect(() => {
		// focus after the pointer sequence that opened us has settled
		const id = requestAnimationFrame(() => {
			ref.current?.focus()
			ref.current?.select()
		})
		return () => cancelAnimationFrame(id)
	}, [])
	const finish = (v: string | null, how: EditEnd) => {
		if (done.current) return
		done.current = true
		onDone(v, how)
	}
	const h = 30
	const y = isGroup ? box.y + 4 : box.y + box.h / 2 - h / 2
	return (
		<foreignObject x={box.x + 6} y={y} width={Math.max(box.w - 12, 120)} height={h}>
			<input
				ref={ref}
				className="inline-editor"
				defaultValue={initial}
				placeholder={placeholder ? 'Name it, Enter · Tab nests' : undefined}
				style={{ textAlign: isGroup ? 'left' : 'center' }}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Enter') finish(e.currentTarget.value, 'enter')
					if (e.key === 'Escape') finish(null, 'escape')
					if (e.key === 'Tab' && placeholder) {
						e.preventDefault()
						finish(e.currentTarget.value, 'tab')
					}
				}}
				onBlur={(e) => {
					if (performance.now() - mountedAt.current < 250) {
						const el = e.currentTarget
						requestAnimationFrame(() => el.focus())
						return
					}
					finish(e.currentTarget.value, 'blur')
				}}
			/>
		</foreignObject>
	)
}

function TextShapeEditor({ shape, color, onDone }: { shape: FreeShape; color: string; onDone: (v: string | null) => void }) {
	const ref = useRef<HTMLTextAreaElement>(null)
	const done = useRef(false)
	const [value, setValue] = useState(shape.text ?? '')
	const mountedAt = useRef(performance.now())
	useEffect(() => {
		// focus after the pointer sequence that opened us has settled
		const id = requestAnimationFrame(() => {
			ref.current?.focus()
			ref.current?.select()
		})
		return () => cancelAnimationFrame(id)
	}, [])
	const finish = (v: string | null) => {
		if (done.current) return
		done.current = true
		onDone(v)
	}
	const size = textSize(shape)
	const lines = value.split('\n')
	const width = Math.max(80, makeMeasure('clean')(value || 'M', size).w + size)
	return (
		<foreignObject x={shape.x - 2} y={shape.y} width={width + 8} height={lines.length * size * 1.25 + size * 0.6}>
			<textarea
				ref={ref}
				className="inline-text-editor"
				value={value}
				style={{ fontSize: size, lineHeight: 1.25, color }}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault()
						finish(value)
					}
					if (e.key === 'Escape') finish(value)
				}}
				onBlur={(e) => {
					if (performance.now() - mountedAt.current < 250) {
						const el = e.currentTarget
						requestAnimationFrame(() => el.focus())
						return
					}
					finish(value)
				}}
			/>
		</foreignObject>
	)
}

function StickyEditor({ shape, onDone }: { shape: FreeShape; onDone: (v: string | null) => void }) {
	const ref = useRef<HTMLTextAreaElement>(null)
	const done = useRef(false)
	const [value, setValue] = useState(shape.text ?? '')
	const mountedAt = useRef(performance.now())
	useEffect(() => {
		const id = requestAnimationFrame(() => {
			ref.current?.focus()
			ref.current?.select()
		})
		return () => cancelAnimationFrame(id)
	}, [])
	const finish = (v: string | null) => {
		if (done.current) return
		done.current = true
		onDone(v)
	}
	const { size, pad, lines } = stickyLayout({ ...shape, text: value })
	// center the text block vertically like the rendered note (padding-top tracks the line count)
	const textH = Math.max(1, lines.length) * size * 1.3
	const padTop = Math.max(pad, (shape.h - textH) / 2)
	return (
		<foreignObject x={shape.x} y={shape.y} width={shape.w} height={shape.h}>
			<textarea
				ref={ref}
				className="inline-sticky-editor"
				value={value}
				style={{ fontSize: size, padding: `${padTop}px ${pad}px ${pad}px` }}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
						e.preventDefault()
						finish(value)
					}
				}}
				onBlur={(e) => {
					if (performance.now() - mountedAt.current < 250) {
						const el = e.currentTarget
						requestAnimationFrame(() => el.focus())
						return
					}
					finish(value)
				}}
			/>
		</foreignObject>
	)
}
