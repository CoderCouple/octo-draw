/**
 * Deterministic sequence-diagram layout: participants in columns (first
 * appearance order), one row per event, activation bars, block frames that
 * span their rows (with section dividers) and notes. No ELK.
 */
import type { DiagramIR, DiagramLayout, LaidOutNode, LayoutOptions, SeqEvent, SequenceLayout } from '../ir'
import { ICON_SIZE, NODE_FONT_SIZE, estimateText, nodeLabel, type Measure } from './sizing'

export const SEQ_HEAD_H = 44
export const SEQ_MSG_FONT = 12
export const SEQ_NOTE_FONT = 12
const COL_GAP = 40
const ACT_W = 10
const NUM_W = 22

interface Ext {
	min: number
	max: number
}
const grow = (e: Ext, a: number, b = a) => {
	e.min = Math.min(e.min, a, b)
	e.max = Math.max(e.max, a, b)
}

/** Every participant key, IR node order first, then keys only used by events. */
export function participantKeys(ir: DiagramIR): string[] {
	const keys = ir.nodes.map((n) => n.key)
	const seen = new Set(keys)
	const add = (k: string) => {
		if (!seen.has(k)) {
			seen.add(k)
			keys.push(k)
		}
	}
	const walk = (events: SeqEvent[]) => {
		for (const ev of events) {
			if (ev.kind === 'message') {
				add(ev.from)
				add(ev.to)
			} else if (ev.kind === 'note') ev.targets.forEach(add)
			else if (ev.kind === 'block') ev.sections.forEach((s) => walk(s.events))
			else add(ev.target)
		}
	}
	walk(ir.sequence?.events ?? [])
	return keys
}

export function sequenceBoxWidth(ir: DiagramIR, key: string, measure: Measure): number {
	const node = ir.nodes.find((n) => n.key === key) ?? { key }
	const t = measure(nodeLabel(node), NODE_FONT_SIZE)
	return Math.round(Math.max(110, t.w + (node.icon ? ICON_SIZE + 8 : 0) + 32))
}

export function layoutSequence(ir: DiagramIR, opts: LayoutOptions = {}): DiagramLayout {
	const measure = opts.measureText ?? estimateText
	const events = ir.sequence?.events ?? []
	const keys = participantKeys(ir)
	const col = new Map(keys.map((k, i) => [k, i]))
	const widths = keys.map((k) => sequenceBoxWidth(ir, k, measure))
	const n = keys.length
	const auto = !!ir.sequence?.autoNumber

	// -- columns: start packed, then widen gaps for labels and notes
	const xs: number[] = []
	for (let i = 0; i < n; i++) xs.push(i === 0 ? widths[0] / 2 : xs[i - 1] + (widths[i - 1] + widths[i]) / 2 + COL_GAP)
	const cons: { i: number; j: number; need: number }[] = []
	let leftExtra = 0
	const noteSize = (text: string) => {
		const m = measure(text || ' ', SEQ_NOTE_FONT)
		return { w: Math.max(80, m.w + 20), h: m.h + 14 }
	}
	const collect = (list: SeqEvent[]) => {
		for (const ev of list) {
			if (ev.kind === 'message') {
				const a = col.get(ev.from)!
				const b = col.get(ev.to)!
				const lw = (ev.label ? measure(ev.label, SEQ_MSG_FONT).w : 0) + (auto ? NUM_W : 0)
				if (a === b) {
					if (a + 1 < n) cons.push({ i: a, j: a + 1, need: lw + 56 })
				} else cons.push({ i: Math.min(a, b), j: Math.max(a, b), need: lw + 40 })
			} else if (ev.kind === 'note') {
				const idx = ev.targets.map((t) => col.get(t)!).sort((p, q) => p - q)
				const { w } = noteSize(ev.text)
				const i = idx[0]
				const j = idx[idx.length - 1]
				if (ev.placement === 'left') {
					if (i > 0) cons.push({ i: i - 1, j: i, need: w + 30 })
					else leftExtra = Math.max(leftExtra, w + 16)
				} else if (ev.placement === 'right') {
					if (i + 1 < n) cons.push({ i, j: i + 1, need: w + 30 })
				} else if (i === j) {
					if (i > 0) cons.push({ i: i - 1, j: i, need: w / 2 + widths[i - 1] / 2 + 12 })
					if (i + 1 < n) cons.push({ i, j: i + 1, need: w / 2 + widths[i + 1] / 2 + 12 })
				} else cons.push({ i, j, need: w - 60 })
			} else if (ev.kind === 'block') ev.sections.forEach((s) => collect(s.events))
		}
	}
	collect(events)
	cons.sort((p, q) => p.j - p.i - (q.j - q.i) || p.i - q.i)
	for (let pass = 0; pass < 2; pass++) {
		for (const c of cons) {
			const deficit = c.need - (xs[c.j] - xs[c.i])
			if (deficit <= 0.5) continue
			const span = c.j - c.i
			for (let k = c.i + 1; k < n; k++) xs[k] += (deficit * (Math.min(k, c.j) - c.i)) / span
		}
	}
	for (let k = 0; k < n; k++) xs[k] = Math.round(xs[k] + leftExtra)

	// -- rows
	const out: SequenceLayout = { participants: [], lifelines: [], messages: [], activations: [], notes: [], blocks: [] }
	const active = new Map<string, number[]>()
	const depthOf = (k: string) => active.get(k)?.length ?? 0
	/** x of the lifeline / activation edge facing `side` (+1 right, -1 left) */
	const edgeX = (k: string, side: number) => {
		const d = depthOf(k)
		const x = xs[col.get(k)!]
		return d === 0 ? x : x + (d - 1) * (ACT_W / 2) + side * (ACT_W / 2)
	}
	let y = SEQ_HEAD_H + 24
	let lastY = y
	let number = 0
	let index = 0

	const run = (list: SeqEvent[], ext: Ext) => {
		for (const ev of list) {
			switch (ev.kind) {
				case 'message': {
					const lw = ev.label ? measure(ev.label, SEQ_MSG_FONT) : { w: 0, h: 0 }
					const num = auto ? ++number : undefined
					const fullW = lw.w + (num !== undefined ? NUM_W : 0)
					y += (lw.h || 4) + 6
					const self = ev.from === ev.to
					const right = xs[col.get(ev.to)!] >= xs[col.get(ev.from)!]
					const x1 = self ? edgeX(ev.from, 1) : edgeX(ev.from, right ? 1 : -1)
					const x2 = self ? x1 : edgeX(ev.to, right ? -1 : 1)
					const m: SequenceLayout['messages'][number] = { index: index++, from: ev.from, to: ev.to, x1, x2, y, self, arrow: ev.arrow, dash: ev.dash }
					if (ev.label) m.label = ev.label
					if (num !== undefined) m.number = num
					if (ev.color) m.color = ev.color
					if (self) {
						m.y2 = y + 22
						if (ev.label || num !== undefined) m.labelAt = { x: x1 + 12 + fullW / 2, y: y - lw.h / 2 - 4 }
						grow(ext, x1 - 10, x1 + 40 + fullW)
						lastY = m.y2
						y = m.y2 + 14
					} else {
						if (ev.label || num !== undefined) m.labelAt = { x: (x1 + x2) / 2, y: y - Math.max(lw.h, 14) / 2 - 3 }
						grow(ext, x1, x2)
						grow(ext, (x1 + x2) / 2 - fullW / 2 - 6, (x1 + x2) / 2 + fullW / 2 + 6)
						lastY = y
						y += 14
					}
					out.messages.push(m)
					break
				}
				case 'activate': {
					const stack = active.get(ev.target) ?? []
					stack.push(lastY)
					active.set(ev.target, stack)
					index++
					break
				}
				case 'deactivate': {
					const stack = active.get(ev.target)
					index++
					if (!stack?.length) break
					const depth = stack.length - 1
					const y1 = stack.pop()!
					const x = xs[col.get(ev.target)!] + depth * (ACT_W / 2)
					out.activations.push({ key: ev.target, x, y1, y2: Math.max(lastY, y1 + 16), depth })
					break
				}
				case 'note': {
					index++
					const size = noteSize(ev.text)
					const txs = ev.targets.map((t) => xs[col.get(t)!])
					const lo = Math.min(...txs)
					const hi = Math.max(...txs)
					let x: number
					let w = size.w
					if (ev.placement === 'left') x = edgeX(ev.targets[0], -1) - 10 - w
					else if (ev.placement === 'right') x = edgeX(ev.targets[0], 1) + 10
					else if (lo === hi) x = lo - w / 2
					else {
						w = Math.max(w, hi - lo + 60)
						x = (lo + hi) / 2 - w / 2
					}
					y += 6
					const note: SequenceLayout['notes'][number] = { x, y, w, h: size.h, text: ev.text }
					if (ev.color) note.color = ev.color
					out.notes.push(note)
					grow(ext, x, x + w)
					lastY = y + size.h / 2
					y += size.h + 12
					break
				}
				case 'block': {
					index++
					const top = y
					const inner: Ext = { min: Infinity, max: -Infinity }
					const sections: { y: number; label?: string }[] = []
					const slot = out.blocks.length
					out.blocks.push(null as never)
					ev.sections.forEach((s, i) => {
						const sy = i === 0 ? top : y
						sections.push(s.label !== undefined ? { y: sy, label: s.label } : { y: sy })
						y = sy + 30
						run(s.events, inner)
						y += 4
					})
					if (!ev.sections.length) {
						sections.push({ y: top })
						y = top + 34
					}
					y += 8
					const head = Math.max(...sections.map((s, i) => measure(`${i === 0 ? ev.type : ''} [${s.label ?? ''}]`, 12).w + (i === 0 ? 50 : 20)))
					if (inner.min === Infinity) {
						inner.min = xs[0] - widths[0] / 2
						inner.max = xs[n - 1] + widths[n - 1] / 2
					}
					const x = inner.min - 14
					const w = Math.max(inner.max + 14 - x, head)
					out.blocks[slot] = { type: ev.type, x, y: top, w, h: y - top, sections, ...(ev.color ? { color: ev.color } : {}) }
					grow(ext, x, x + w)
					y += 14
					lastY = y
					break
				}
			}
		}
	}
	const root: Ext = { min: Infinity, max: -Infinity }
	run(events, root)
	const end = y + 10
	for (const [key, stack] of active) {
		while (stack.length) {
			const depth = stack.length - 1
			const y1 = stack.pop()!
			out.activations.push({ key, x: xs[col.get(key)!] + depth * (ACT_W / 2), y1, y2: Math.max(end - 10, y1 + 16), depth })
		}
	}
	out.activations.sort((a, b) => a.depth - b.depth)

	const nodes: Record<string, LaidOutNode> = {}
	keys.forEach((key, i) => {
		nodes[key] = { key, x: xs[i] - widths[i] / 2, y: 0, w: widths[i], h: SEQ_HEAD_H, isContainer: false, depth: 0 }
		out.participants.push({ key, x: xs[i], footY: end })
		out.lifelines.push({ key, x: xs[i], y1: SEQ_HEAD_H, y2: end })
	})

	let minX = Infinity
	let maxX = -Infinity
	for (const b of Object.values(nodes)) {
		minX = Math.min(minX, b.x)
		maxX = Math.max(maxX, b.x + b.w)
	}
	if (root.min !== Infinity) {
		minX = Math.min(minX, root.min)
		maxX = Math.max(maxX, root.max)
	}
	const bounds = n === 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: 0, w: maxX - minX, h: end + SEQ_HEAD_H }
	return { nodes, edges: {}, bounds, sequence: out }
}
