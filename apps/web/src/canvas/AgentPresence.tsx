import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DiagramIR } from '@octo-draw/core'
import { useStore } from '../store'
import { useCamera } from './camera'
import { activePresence, diffIR } from '../lib/presence'
import '../components/agent.css'

/**
 * Live agent presence, rendered in world space inside the canvas. While a
 * presence window is open (agent panel run, Generate, external MCP edit) every
 * new IR is diffed by key against the previous one: a labelled cursor glides
 * to each affected node, new nodes fade in under a contracting outline and
 * changed nodes pulse once.
 */

interface Mark {
	id: number
	key: string
	kind: 'add' | 'pulse'
}

interface CursorState {
	x: number
	y: number
	label: string
	on: boolean
	/** false for the first placement so the cursor glides in instead of flying from the origin */
	animate: boolean
}

const STEP_MS = 420
const LINGER_MS = 1600
const MAX_QUEUE = 6

let markSeq = 0

function targetPoint(key: string): { x: number; y: number } | null {
	const n = useStore.getState().layout?.nodes[key]
	if (!n) return null
	if (n.isContainer) return { x: n.x + Math.min(48, n.w / 2), y: n.y + 14 }
	return { x: n.x + n.w * 0.72, y: n.y + n.h * 0.68 }
}

function nodeEl(key: string): Element | null {
	return document.querySelector(`#octo-world [data-node="${CSS.escape(key)}"]`)
}

export function AgentPresence() {
	const ir = useStore((s) => s.ir)
	const layout = useStore((s) => s.layout)
	const z = useCamera((s) => s.z)
	const prevIR = useRef<DiagramIR | null>(null)
	const queue = useRef<string[]>([])
	const label = useRef('AI')
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const [cursor, setCursor] = useState<CursorState | null>(null)
	const [marks, setMarks] = useState<Mark[]>([])

	const step = () => {
		clearTimeout(timer.current)
		const key = queue.current.shift()
		if (key === undefined) {
			// idle: stay while the agent is still working, then fade out
			timer.current = setTimeout(() => {
				if (activePresence() && queue.current.length === 0) return step()
				setCursor((c) => (c ? { ...c, on: false } : c))
			}, LINGER_MS)
			return
		}
		const p = targetPoint(key)
		if (!p) return step()
		setCursor((c) => ({ ...p, label: label.current, on: true, animate: !!c?.on }))
		timer.current = setTimeout(step, STEP_MS)
	}

	useEffect(() => () => clearTimeout(timer.current), [])

	// Layout effect: runs in the same commit that rendered the new nodes, before paint, so they never flash in.
	useLayoutEffect(() => {
		const prev = prevIR.current
		prevIR.current = ir
		if (!ir || !prev || prev === ir) return
		const who = activePresence()
		if (!who) return
		label.current = who
		const d = diffIR(prev, ir)
		if (!d.added.length && !d.changed.length) return
		for (const key of d.added) {
			const el = nodeEl(key)
			if (!el) continue
			el.classList.remove('agent-fade-in')
			el.classList.add('agent-fade-in')
			setTimeout(() => el.classList.remove('agent-fade-in'), 700)
		}
		const fresh: Mark[] = [
			...d.added.map((key) => ({ id: ++markSeq, key, kind: 'add' as const })),
			...d.changed.map((key) => ({ id: ++markSeq, key, kind: 'pulse' as const })),
		]
		setMarks((m) => [...m, ...fresh])
		const ids = new Set(fresh.map((m) => m.id))
		setTimeout(() => setMarks((m) => m.filter((x) => !ids.has(x.id))), 1000)
		// leaves before containers, newest work last; skip ahead when the agent outpaces the cursor
		const isGroup = (k: string) => !!ir.nodes.find((n) => n.key === k)?.isContainer
		const targets = [...d.added, ...d.changed].sort((a, b) => Number(isGroup(a)) - Number(isGroup(b)))
		const idle = queue.current.length === 0
		queue.current = [...queue.current, ...targets].slice(-MAX_QUEUE)
		if (idle) step()
	}, [ir])

	if (!layout) return null
	const k = 1 / Math.max(z, 0.2)
	return (
		<g className="agent-presence" data-export="skip" pointerEvents="none">
			{marks.map((m) => {
				const n = layout.nodes[m.key]
				if (!n) return null
				const pad = n.isContainer ? 2 : 4
				return (
					<g key={m.id} transform={`translate(${n.x - pad},${n.y - pad})`}>
						<rect
							className={m.kind === 'add' ? 'agent-mark-add' : 'agent-mark-pulse'}
							width={n.w + pad * 2}
							height={n.h + pad * 2}
							rx={n.isContainer ? 14 : 10}
							fill="none"
							stroke="var(--foreground-strong)"
							strokeWidth={m.kind === 'add' ? 2 : 1.5}
							vectorEffect="non-scaling-stroke"
						/>
					</g>
				)
			})}
			{cursor && (
				<g
					className={`agent-cursor${cursor.on ? ' on' : ''}${cursor.animate ? '' : ' instant'}`}
					style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
				>
					<g transform={`scale(${k})`}>
						<path
							d="M0,0 L0,18 L5,13.5 L8.5,21 L11.5,19.6 L8,12.4 L14.5,12 Z"
							fill="var(--foreground-strong)"
							stroke="var(--background)"
							strokeWidth={1.4}
							strokeLinejoin="round"
						/>
						<rect x={13} y={18} width={cursor.label.length * 7 + 16} height={18} rx={9} fill="var(--foreground-strong)" />
						<text x={21} y={30.5} fontSize={11} fontWeight={700} fill="var(--background)" fontFamily="var(--font-family-sans)">
							{cursor.label}
						</text>
					</g>
				</g>
			)}
		</g>
	)
}
