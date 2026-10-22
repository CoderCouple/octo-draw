import type { DiagramIR } from '@octo-draw/core'

/**
 * Agent presence window. While open, the canvas overlay (canvas/AgentPresence)
 * diffs every new IR against the previous one by key and animates the agent
 * cursor over the affected nodes. Opened by the agent panel, the top-bar
 * Generate and edits arriving from external (MCP) agents.
 */

interface PresenceWindow {
	label: string
	until: number
}

let current: PresenceWindow | null = null

/** Opens (or extends) the presence window for `ms`. */
export function expectPresence(label = 'AI', ms = 60000) {
	current = { label, until: Math.max(Date.now() + ms, current?.label === label ? current.until : 0) }
}

/** Lets the window close `afterMs` from now (time for the last layout to land). */
export function endPresence(afterMs = 2500) {
	if (!current) return
	current = { ...current, until: Date.now() + afterMs }
}

export function activePresence(): string | null {
	if (!current || current.until < Date.now()) return null
	return current.label
}

export interface IRDiff {
	added: string[]
	changed: string[]
	removed: string[]
	edgesAdded: number
	edgesRemoved: number
}

const nodeSig = (n: DiagramIR['nodes'][number]) => JSON.stringify([n.label, n.shape, n.icon, n.parent, n.style, n.link, n.isContainer])
const edgeSig = (e: DiagramIR['edges'][number]) => JSON.stringify([e.from, e.to, e.label, e.arrow, e.line, e.style])

/** Node-level diff by key. Edge changes mark both endpoints as changed. */
export function diffIR(prev: DiagramIR | null, next: DiagramIR): IRDiff {
	const before = new Map((prev?.nodes ?? []).map((n) => [n.key, n]))
	const after = new Map(next.nodes.map((n) => [n.key, n]))
	const added: string[] = []
	const changed = new Set<string>()
	for (const n of next.nodes) {
		const old = before.get(n.key)
		if (!old) added.push(n.key)
		else if (nodeSig(old) !== nodeSig(n)) changed.add(n.key)
	}
	const removed = [...before.keys()].filter((k) => !after.has(k))
	const oldEdges = new Map((prev?.edges ?? []).map((e) => [e.key, e]))
	const newEdges = new Map(next.edges.map((e) => [e.key, e]))
	let edgesAdded = 0
	let edgesRemoved = 0
	const touch = (k: string) => {
		if (after.has(k) && !added.includes(k)) changed.add(k)
	}
	for (const e of next.edges) {
		const old = oldEdges.get(e.key)
		if (!old) edgesAdded++
		if (!old || edgeSig(old) !== edgeSig(e)) {
			touch(e.from)
			touch(e.to)
		}
	}
	for (const e of prev?.edges ?? []) {
		if (newEdges.has(e.key)) continue
		edgesRemoved++
		touch(e.from)
		touch(e.to)
	}
	return { added, changed: [...changed], removed, edgesAdded, edgesRemoved }
}
