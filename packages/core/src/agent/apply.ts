/**
 * Apply AgentAction[] to octo DSL source. Each action is a text edit (minimal
 * patch where possible), so the code panel reflects exactly what the agent did.
 * Failures are collected per action; nothing throws.
 */

import type { AgentAction, ApplyResult } from '../agent'
import { NODE_SHAPES, type IREdge } from '../ir'
import { parseMermaid } from '../mermaid/parse'
import { analyzeOcto, OP_STYLE, type EdgeOp, type OctoAnalysis, type Statement } from '../dsl/parse'
import { appendLine, setNodeProp } from '../dsl/patch'
import { printEdge, printEdgeLine, printOcto, printProps, quoteName, type PropList } from '../dsl/print'

type GroupStatement = Extract<Statement, { kind: 'group' }>

interface Edit {
	from: number
	to: number
	text: string
}

class ActionError extends Error {}

function fail(message: string): never {
	throw new ActionError(message)
}

function applyEdits(src: string, edits: Edit[]): string {
	const sorted = [...edits].sort((a, b) => b.from - a.from)
	let out = src
	for (const e of sorted) out = out.slice(0, e.from) + e.text + out.slice(e.to)
	return out
}

function lineStartOf(src: string, offset: number): number {
	return src.lastIndexOf('\n', offset - 1) + 1
}

function lineEndOf(src: string, offset: number): number {
	const i = src.indexOf('\n', offset)
	return i < 0 ? src.length : i
}

function indentOf(src: string, offset: number): string {
	const start = lineStartOf(src, offset)
	return /^[ \t]*/.exec(src.slice(start))![0]
}

function isTrailingComment(s: string): boolean {
	const t = s.trim()
	return t === '' || t.startsWith('//') || t.startsWith('#')
}

/** If [from,to) is alone on its line(s), widen to the full lines (including the newline). */
function wholeLines(src: string, from: number, to: number): { from: number; to: number; whole: boolean } {
	const ls = lineStartOf(src, from)
	const le = lineEndOf(src, to)
	if (src.slice(ls, from).trim() === '' && isTrailingComment(src.slice(to, le))) {
		return { from: ls, to: le < src.length ? le + 1 : le, whole: true }
	}
	return { from, to, whole: false }
}

function deleteRange(src: string, from: number, to: number): Edit {
	const r = wholeLines(src, from, to)
	return { from: r.from, to: r.to, text: '' }
}

/** Offset where new top-level declarations go: after the last top-level declaration/group, else after directives, else 0. */
function declAnchor(src: string, a: OctoAnalysis): { at: number; text: (line: string) => string } {
	let anchor = -1
	for (const s of a.statements) {
		if (s.parent) continue
		if (s.kind === 'decl' || s.kind === 'group') anchor = Math.max(anchor, s.to)
	}
	if (anchor < 0) {
		for (const s of a.statements) {
			if (s.parent) continue
			if (s.kind === 'directive' || s.kind === 'header') anchor = Math.max(anchor, s.to)
		}
	}
	if (anchor < 0) return { at: 0, text: (line) => line + '\n' }
	const le = lineEndOf(src, anchor)
	if (le >= src.length) return { at: src.length, text: (line) => '\n' + line + (src.endsWith('\n') ? '\n' : '') }
	return { at: le + 1, text: (line) => line + '\n' }
}

function insertTopLevel(src: string, line: string): string {
	const a = analyzeOcto(src)
	const { at, text } = declAnchor(src, a)
	return applyEdits(src, [{ from: at, to: at, text: text(line) }])
}

function findGroup(a: OctoAnalysis, key: string): GroupStatement | undefined {
	let found: GroupStatement | undefined
	for (const s of a.statements) if (s.kind === 'group' && s.item.key === key && s.close >= 0) found = s
	return found
}

/** Insert `line` as the last child of the group block. */
function insertInGroup(src: string, g: GroupStatement, line: string): string {
	const headerIndent = indentOf(src, g.from)
	const openLineEnd = lineEndOf(src, g.open)
	const closeLineStart = lineStartOf(src, g.close)
	let childIndent = headerIndent + '\t'
	if (closeLineStart > openLineEnd) {
		const inner = src.slice(openLineEnd + 1, closeLineStart).split('\n')
		const firstChild = inner.find((l) => l.trim() !== '')
		if (firstChild !== undefined) childIndent = /^[ \t]*/.exec(firstChild)![0]
	}
	const closeAlone = src.slice(closeLineStart, g.close).trim() === ''
	if (closeAlone) {
		return applyEdits(src, [{ from: closeLineStart, to: closeLineStart, text: `${childIndent}${line}\n` }])
	}
	return applyEdits(src, [{ from: g.close, to: g.close, text: `\n${childIndent}${line}\n${headerIndent}` }])
}

/** Remove the edges matching `pred`, rewriting chain/branch statements that keep other edges. */
function removeEdgesWhere(src: string, a: OctoAnalysis, pred: (e: IREdge) => boolean): { edits: Edit[]; removed: number } {
	const edits: Edit[] = []
	let removed = 0
	for (const s of a.statements) {
		if (s.kind !== 'connection') continue
		const kept = s.edges.filter((e) => !pred(e.edge))
		if (kept.length === s.edges.length) continue
		removed += s.edges.length - kept.length
		if (kept.length === 0) {
			edits.push(deleteRange(src, s.from, s.to))
		} else {
			const indent = indentOf(src, s.from)
			const text = kept.map((e) => printEdge(e.edge, e.explicitId)).join('\n' + indent)
			edits.push({ from: s.from, to: s.to, text })
		}
	}
	return { edits, removed }
}

function nodePropList(action: { label?: string; shape?: string; icon?: string; color?: string }): PropList {
	const props: PropList = []
	if (action.shape !== undefined) props.push(['shape', action.shape])
	if (action.icon !== undefined) props.push(['icon', action.icon])
	if (action.color !== undefined) props.push(['color', action.color])
	if (action.label !== undefined) props.push(['label', action.label])
	return props
}

function checkShape(shape: string | undefined): void {
	if (shape !== undefined && !(NODE_SHAPES as readonly string[]).includes(shape)) {
		fail(`Unknown shape "${shape}" (expected ${NODE_SHAPES.join(', ')})`)
	}
}

function requireKey(key: unknown, what = 'key'): asserts key is string {
	if (typeof key !== 'string' || key === '') fail(`Missing ${what}`)
}

function setProps(src: string, key: string, props: PropList): string {
	for (const [p, v] of props) src = setNodeProp(src, key, p, v ?? 'true')
	return src
}

function addNode(src: string, action: Extract<AgentAction, { type: 'addNode' }>): string {
	requireKey(action.key)
	checkShape(action.shape)
	const props = nodePropList(action)
	const a = analyzeOcto(src)
	const existing = a.result.ir.nodes.find((n) => n.key === action.key)
	if (action.parent !== undefined) {
		if (action.parent === action.key) fail(`"${action.key}" cannot be its own parent`)
		const parentNode = a.result.ir.nodes.find((n) => n.key === action.parent)
		const g = findGroup(a, action.parent)
		if (parentNode && !g) fail(`Parent "${action.parent}" is not a group`)
		if (existing) {
			// Existing node: patch its props, then move it with a reference inside the group.
			let out = setProps(src, action.key, props)
			if (existing.parent !== action.parent) {
				const g2 = findGroup(analyzeOcto(out), action.parent)
				out = g2
					? insertInGroup(out, g2, quoteName(action.key))
					: insertTopLevel(out, `${quoteName(action.parent)} {\n\t${quoteName(action.key)}\n}`)
			}
			return out
		}
		const line = `${quoteName(action.key)}${printProps(props)}`
		if (g) return insertInGroup(src, g, line)
		return insertTopLevel(src, `${quoteName(action.parent)} {\n\t${line}\n}`)
	}
	if (existing) return setProps(src, action.key, props)
	return insertTopLevel(src, `${quoteName(action.key)}${printProps(props)}`)
}

function updateNode(src: string, action: Extract<AgentAction, { type: 'updateNode' }>): string {
	requireKey(action.key)
	checkShape(action.shape)
	const a = analyzeOcto(src)
	if (!a.result.ir.nodes.some((n) => n.key === action.key)) fail(`Unknown node "${action.key}"`)
	return setProps(src, action.key, nodePropList(action))
}

function removeNode(src: string, key: string): string {
	requireKey(key)
	let a = analyzeOcto(src)
	if (!a.result.ir.nodes.some((n) => n.key === key)) fail(`Unknown node "${key}"`)

	// Pass 1: connections and plain declarations / group references.
	const { edits } = removeEdgesWhere(src, a, (e) => e.from === key || e.to === key)
	for (const s of a.statements) {
		if (s.kind !== 'decl') continue
		const kept = s.items.filter((i) => i.key !== key)
		if (kept.length === s.items.length) continue
		if (kept.length === 0) edits.push(deleteRange(src, s.from, s.to))
		else edits.push({ from: s.from, to: s.to, text: kept.map((i) => src.slice(i.from, i.to)).join(', ') })
	}
	src = applyEdits(src, edits)

	// Pass 2: unwrap group blocks of this key, keeping (and dedenting) their contents.
	for (let guard = 0; guard < 100; guard++) {
		a = analyzeOcto(src)
		let g: GroupStatement | undefined
		for (const s of a.statements) if (s.kind === 'group' && s.item.key === key) g = s
		if (!g) break
		src = unwrapGroup(src, g)
	}
	return src
}

function unwrapGroup(src: string, g: GroupStatement): string {
	const headLs = lineStartOf(src, g.from)
	const headLe = lineEndOf(src, g.open)
	const headAlone = src.slice(headLs, g.from).trim() === '' && isTrailingComment(src.slice(g.open + 1, headLe))
	if (g.close < 0) {
		return applyEdits(src, [headAlone ? deleteRange(src, g.from, g.open + 1) : { from: g.from, to: g.open + 1, text: '' }])
	}
	const closeLs = lineStartOf(src, g.close)
	const closeLe = lineEndOf(src, g.close)
	const closeAlone = src.slice(closeLs, g.close).trim() === '' && isTrailingComment(src.slice(g.close + 1, closeLe))
	if (headAlone && closeAlone && closeLs > headLe) {
		const headerIndent = src.slice(headLs, g.from)
		const innerLines = src.slice(headLe + 1, closeLs).split('\n')
		innerLines.pop() // the slice ends with '\n'
		const first = innerLines.find((l) => l.trim() !== '')
		const firstIndent = first === undefined ? '' : /^[ \t]*/.exec(first)![0]
		const extra = firstIndent.startsWith(headerIndent) ? firstIndent.slice(headerIndent.length) : ''
		const dedented = innerLines.map((l) => (extra && l.startsWith(headerIndent + extra) ? headerIndent + l.slice(headerIndent.length + extra.length) : l))
		const to = closeLe < src.length ? closeLe + 1 : closeLe
		const text = dedented.length ? dedented.join('\n') + (closeLe < src.length ? '\n' : '') : ''
		return applyEdits(src, [{ from: headLs, to, text }])
	}
	return applyEdits(src, [
		{ from: g.from, to: g.open + 1, text: '' },
		{ from: g.close, to: g.close + 1, text: '' },
	])
}

function addEdge(src: string, action: Extract<AgentAction, { type: 'addEdge' }>): string {
	requireKey(action.from, 'from')
	requireKey(action.to, 'to')
	const op: EdgeOp = action.op ?? '>'
	if (!(op in OP_STYLE)) fail(`Unknown operator "${op}"`)
	if (action.id !== undefined) {
		const a = analyzeOcto(src)
		if (a.result.ir.edges.some((e) => e.key === action.id)) fail(`Connection id "${action.id}" already exists`)
	}
	const props: PropList = action.id !== undefined ? [['id', action.id]] : []
	return appendLine(src, printEdgeLine(action.from, op, action.to, action.label, props))
}

function removeEdge(src: string, action: Extract<AgentAction, { type: 'removeEdge' }>): string {
	const a = analyzeOcto(src)
	const edges = a.result.ir.edges
	let pred: (e: IREdge) => boolean
	if (action.id !== undefined) {
		pred = (e) => e.key === action.id
	} else {
		pred = (e) => e.from === action.from && e.to === action.to
		if (!edges.some(pred)) pred = (e) => e.from === action.to && e.to === action.from
	}
	const { edits, removed } = removeEdgesWhere(src, a, pred)
	if (removed === 0) {
		fail(action.id !== undefined ? `Unknown connection id "${action.id}"` : `No connection between "${action.from}" and "${action.to}"`)
	}
	return applyEdits(src, edits)
}

function addGroup(src: string, action: Extract<AgentAction, { type: 'addGroup' }>): string {
	requireKey(action.key)
	const children = action.children ?? []
	if (children.includes(action.key)) fail(`Group "${action.key}" cannot contain itself`)
	const props = nodePropList(action)
	const a = analyzeOcto(src)
	const existing = a.result.ir.nodes.find((n) => n.key === action.key)
	if (existing) {
		if (!findGroup(a, action.key)) fail(`"${action.key}" already exists and is not a group`)
		let out = setProps(src, action.key, props)
		for (const c of children) {
			const g = findGroup(analyzeOcto(out), action.key)!
			out = insertInGroup(out, g, quoteName(c))
		}
		return out
	}
	const lines = [`${quoteName(action.key)}${printProps(props)} {`, ...children.map((c) => `\t${quoteName(c)}`), '}']
	return insertTopLevel(src, lines.join('\n'))
}

function setDirection(src: string, direction: string): string {
	if (!['down', 'up', 'right', 'left'].includes(direction)) fail(`Unknown direction "${direction}"`)
	const a = analyzeOcto(src)
	let dir: Extract<Statement, { kind: 'directive' }> | undefined
	let lastTop = -1
	for (const s of a.statements) {
		if (s.kind === 'directive' && s.name === 'direction') dir = s
		if ((s.kind === 'directive' || s.kind === 'header') && !s.parent) lastTop = Math.max(lastTop, s.to)
	}
	if (dir) return applyEdits(src, [{ from: dir.valueFrom, to: dir.valueTo, text: direction }])
	const line = `direction ${direction}`
	if (lastTop < 0) return src === '' ? line + '\n' : line + '\n' + src
	const le = lineEndOf(src, lastTop)
	if (le >= src.length) return src + '\n' + line + '\n'
	return applyEdits(src, [{ from: le + 1, to: le + 1, text: line + '\n' }])
}

function replaceCode(action: Extract<AgentAction, { type: 'replaceCode' }>): string {
	if (typeof action.code !== 'string') fail('Missing code')
	if (action.format === 'mermaid') {
		const { ir, diagnostics } = parseMermaid(action.code)
		const errs = diagnostics.filter((d) => d.severity === 'error')
		if (ir.nodes.length === 0 && errs.length > 0) fail(`Could not parse mermaid: ${errs[0].message}`)
		return printOcto(ir)
	}
	return action.code
}

function applyOne(src: string, action: AgentAction): string {
	switch (action.type) {
		case 'addNode':
			return addNode(src, action)
		case 'updateNode':
			return updateNode(src, action)
		case 'removeNode':
			return removeNode(src, action.key)
		case 'addEdge':
			return addEdge(src, action)
		case 'removeEdge':
			return removeEdge(src, action)
		case 'addGroup':
			return addGroup(src, action)
		case 'setDirection':
			return setDirection(src, action.direction)
		case 'replaceCode':
			return replaceCode(action)
		default:
			return fail(`Unknown action type "${(action as { type?: unknown }).type}"`)
	}
}

export function applyActions(src: string, actions: AgentAction[]): ApplyResult {
	let code = src
	let applied = 0
	const errors: ApplyResult['errors'] = []
	if (!Array.isArray(actions)) return { code, applied, errors: [{ index: -1, message: 'actions must be an array' }] }
	actions.forEach((action, index) => {
		try {
			if (!action || typeof action !== 'object') fail('Action must be an object')
			code = applyOne(code, action)
			applied++
		} catch (e) {
			errors.push({ index, message: e instanceof Error ? e.message : String(e) })
		}
	})
	return { code, applied, errors }
}
