import { analyzeOcto, type DeclItem, type OctoAnalysis, type Statement } from '@octo-draw/core/src/dsl/parse'
import { quoteName } from '@octo-draw/core/src/dsl/print'
import { applyActions, editPage, findPage, splitPages } from './drillCore'

/**
 * Pure text edits that grow or reshape group nesting in octo DSL: add a child
 * (turning a leaf into a container), add a sibling, wrap nodes in a new group,
 * move a node into / out of a group, ungroup, rename a key.
 *
 * Every function edits one page (`page`, default root) and leaves everything
 * else byte-for-byte; indentation follows the surrounding block. They are
 * candidates for `@octo-draw/core` (dsl/patch).
 */

type Group = Extract<Statement, { kind: 'group' }>
type Decl = Extract<Statement, { kind: 'decl' }>
interface Edit {
	from: number
	to: number
	text: string
}

function applyEdits(src: string, edits: Edit[]): string {
	let out = src
	for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.text + out.slice(e.to)
	return out
}

const lineStart = (s: string, i: number) => s.lastIndexOf('\n', i - 1) + 1
const lineEnd = (s: string, i: number) => {
	const j = s.indexOf('\n', i)
	return j < 0 ? s.length : j
}
const indentAt = (s: string, i: number) => /^[ \t]*/.exec(s.slice(lineStart(s, i)))![0]
const blankOrComment = (t: string) => /^\s*(?:(?:\/\/|#).*)?$/.test(t)

/** The source's indent unit: the first indented line's leading whitespace, else two spaces. */
function indentUnit(src: string): string {
	const m = /\n([ \t]+)\S/.exec(src)
	return m ? m[1] : '  '
}

/** [from, to) widened to whole lines (with the newline) when nothing else shares them. */
function wholeLines(src: string, from: number, to: number): { from: number; to: number } {
	const ls = lineStart(src, from)
	const le = lineEnd(src, to)
	if (src.slice(ls, from).trim() === '' && blankOrComment(src.slice(to, le))) return { from: ls, to: le < src.length ? le + 1 : le }
	return { from, to }
}

const reindent = (lines: string[], indent: string) => lines.map((l) => (l.trim() ? indent + l : l))

function closedBlocks(a: OctoAnalysis, key: string): Group[] {
	return a.statements.filter((s): s is Group => s.kind === 'group' && s.item.key === key && s.close >= 0)
}

function nodeOf(a: OctoAnalysis, key: string) {
	return a.result.ir.nodes.find((n) => n.key === key)
}

/** Child indent inside a group block: its first child's indent, else header indent + unit. */
function childIndent(src: string, g: Group): string {
	const head = indentAt(src, g.from)
	const openLe = lineEnd(src, g.open)
	const closeLs = lineStart(src, g.close)
	if (closeLs > openLe) {
		const first = src
			.slice(openLe + 1, closeLs)
			.split('\n')
			.find((l) => l.trim() !== '')
		if (first !== undefined) return /^[ \t]*/.exec(first)![0]
	}
	return head + indentUnit(src)
}

/** Appends `lines` (relative indentation) as the last children of block `g`. */
function insertIntoBlock(src: string, g: Group, lines: string[]): string {
	const ci = childIndent(src, g)
	const head = indentAt(src, g.from)
	const closeLs = lineStart(src, g.close)
	const body = reindent(lines, ci).join('\n')
	if (src.slice(closeLs, g.close).trim() === '' && closeLs > lineEnd(src, g.open)) return applyEdits(src, [{ from: closeLs, to: closeLs, text: body + '\n' }])
	// `G { A }` or `G {}` on one line: open it up
	let before = g.close
	while (before > g.open + 1 && (src[before - 1] === ' ' || src[before - 1] === '\t')) before--
	return applyEdits(src, [{ from: before, to: g.close, text: '\n' + body + '\n' + head }])
}

/** Where new top-level statements go: after the last top-level declaration/group, else after directives, else the start. */
function insertTopLevel(src: string, a: OctoAnalysis, lines: string[]): string {
	let anchor = -1
	for (const s of a.statements) if (!s.parent && (s.kind === 'decl' || s.kind === 'group')) anchor = Math.max(anchor, s.to)
	if (anchor < 0) for (const s of a.statements) if (!s.parent && (s.kind === 'directive' || s.kind === 'header')) anchor = Math.max(anchor, s.to)
	const text = lines.join('\n')
	if (anchor < 0) return text + '\n' + src
	return insertAfterLine(src, anchor, text)
}

function insertAfterLine(src: string, at: number, text: string): string {
	const le = lineEnd(src, Math.max(0, at - 1))
	if (le >= src.length) return src + (src.endsWith('\n') || src === '' ? '' : '\n') + text + '\n'
	return applyEdits(src, [{ from: le + 1, to: le + 1, text: text + '\n' }])
}

function stmtEnd(s: Statement): number {
	return s.kind === 'group' ? Math.max(s.to, s.close + 1) : s.to
}

/** Per-page wrapper: runs a body edit on one page; unknown pages return `src`. */
function onPage(src: string, page: string | undefined, edit: (body: string) => string): string {
	if (page && !findPage(splitPages(src), page)) return src
	return editPage(src, page || undefined, edit)
}

/** `base`, `base 2`, `base 3`, … — the first key not used on the page. */
export function uniqueKey(src: string, base: string, page = ''): string {
	let keys: Set<string> = new Set()
	onPage(src, page, (body) => {
		keys = new Set(analyzeOcto(body).result.ir.nodes.map((n) => n.key))
		return body
	})
	if (!keys.has(base)) return base
	let n = 2
	while (keys.has(`${base} ${n}`)) n++
	return `${base} ${n}`
}

// ---------------------------------------------------------------------------
// add child / sibling

/**
 * Adds `childName` inside `parentKey`. A container gets the child appended to
 * its block; a leaf becomes a container with its props kept
 * (`A [icon: x]` → `A [icon: x] {\n  child\n}`); an implicit node (only in
 * connections) gets a group declaration.
 */
export function addChild(src: string, parentKey: string, childName: string, page = ''): string {
	return onPage(src, page, (body) => addChildBody(body, parentKey, childName))
}

function addChildBody(src: string, parentKey: string, childName: string): string {
	const a = analyzeOcto(src)
	const node = nodeOf(a, parentKey)
	if (!node) return src
	const line = quoteName(childName)
	const blocks = closedBlocks(a, parentKey)
	if (node.isContainer && blocks.length) return insertIntoBlock(src, blocks[blocks.length - 1], [line])
	const unit = indentUnit(src)
	// the declaration that sets its parent (last one inside a group), else the first one
	const decls = a.statements.filter((s): s is Decl => s.kind === 'decl' && s.items.some((i) => i.key === parentKey))
	const stmt = [...decls].reverse().find((s) => s.parent !== undefined) ?? decls[0]
	if (stmt) {
		const item = stmt.items.find((i) => i.key === parentKey)!
		const ind = indentAt(src, stmt.from)
		const itemText = src.slice(item.from, item.to)
		const block = `${itemText} {\n${ind}${unit}${line}\n${ind}}`
		if (stmt.items.length === 1) return applyEdits(src, [{ from: item.from, to: item.to, text: block }])
		// `A, B, C`: take B out of the list, give it its own block right after
		const kept = stmt.items.filter((i) => i !== item).map((i) => src.slice(i.from, i.to))
		const out = applyEdits(src, [{ from: stmt.from, to: stmt.to, text: kept.join(', ') }])
		return insertAfterLine(out, stmt.from + kept.join(', ').length, ind + block)
	}
	return insertTopLevel(src, a, [`${quoteName(parentKey)} {`, unit + line, '}'])
}

/** Adds `name` next to `key`: same container, on the line after `key`'s declaration. */
export function addSibling(src: string, key: string, name: string, page = ''): string {
	return onPage(src, page, (body) => {
		const a = analyzeOcto(body)
		const node = nodeOf(a, key)
		if (!node) return body
		const line = quoteName(name)
		const parent = node.parent
		const mentions = a.statements.filter((s) => s.parent === parent && ((s.kind === 'decl' && s.items.some((i) => i.key === key)) || (s.kind === 'group' && s.item.key === key)))
		const at = mentions[mentions.length - 1]
		if (at) return insertAfterLine(body, stmtEnd(at), indentAt(body, at.from) + line)
		if (parent) {
			const blocks = closedBlocks(a, parent)
			if (blocks.length) return insertIntoBlock(body, blocks[blocks.length - 1], [line])
			return addChildBody(body, parent, name)
		}
		return insertTopLevel(body, a, [line])
	})
}

/** Renames a node key everywhere on the page (declarations, group headers, connections). */
export function renameKey(src: string, oldKey: string, newKey: string, page = ''): string {
	if (oldKey === newKey || !newKey.trim()) return src
	return onPage(src, page, (body) => {
		const a = analyzeOcto(body)
		if (nodeOf(a, newKey)) return body
		const edits: Edit[] = []
		const name = quoteName(newKey)
		for (const s of a.statements) {
			const items: DeclItem[] = s.kind === 'decl' || s.kind === 'connection' ? s.items : s.kind === 'group' ? [s.item] : []
			for (const i of items) if (i.key === oldKey) edits.push({ from: i.nameFrom, to: i.nameTo, text: name })
		}
		return applyEdits(body, edits)
	})
}

// ---------------------------------------------------------------------------
// moving nodes between groups

interface Extracted {
	src: string
	/** declaration text to place at the destination (relative indentation), or null to keep it where it is */
	lines: string[] | null
}

/**
 * Takes `key` out of whatever group block mentions it. Leaves: in-group
 * declarations are removed (their props travel along). Groups: every block
 * nested inside another group is cut (contents included); a top-level block
 * is cut too when `physical` (so it can move inside a new parent).
 */
function extract(src: string, key: string, physical: boolean): Extracted {
	const a = analyzeOcto(src)
	const node = nodeOf(a, key)
	if (!node) return { src, lines: null }
	const edits: Edit[] = []
	let best: string | null = null
	for (const s of a.statements) {
		if (s.kind !== 'decl' || s.parent === undefined) continue
		const hit = s.items.filter((i) => i.key === key)
		if (!hit.length) continue
		for (const i of hit) if (i.props || best === null) best = src.slice(i.from, i.to)
		const kept = s.items.filter((i) => i.key !== key)
		if (!kept.length) {
			const r = wholeLines(src, s.from, s.to)
			edits.push({ from: r.from, to: r.to, text: '' })
		} else edits.push({ from: s.from, to: s.to, text: kept.map((i) => src.slice(i.from, i.to)).join(', ') })
	}
	const blocks = closedBlocks(a, key)
	const outer = blocks.filter((b) => !blocks.some((o) => o !== b && o.from < b.from && o.close > b.close))
	let cut = outer.filter((b) => b.parent !== undefined)
	if (!cut.length && physical && outer.length) cut = [outer[0]]
	const blockLines: string[] = []
	for (const b of cut) {
		// skip leaf edits that sit inside a block we cut anyway
		for (let i = edits.length - 1; i >= 0; i--) if (edits[i].from >= b.from && edits[i].to <= b.close + 1) edits.splice(i, 1)
		const ls = lineStart(src, b.from)
		const le = lineEnd(src, b.close)
		const head = src.slice(ls, b.from)
		const text = head.trim() === '' && blankOrComment(src.slice(b.close + 1, le)) ? src.slice(ls, le) : src.slice(b.from, b.close + 1)
		const indent = head.trim() === '' ? head : ''
		blockLines.push(...text.split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^[ \t]+/, ''))))
		const r = wholeLines(src, b.from, b.close + 1)
		edits.push({ from: r.from, to: r.to, text: '' })
	}
	const out = applyEdits(src, edits)
	if (blockLines.length) return { src: out, lines: blockLines }
	if (node.isContainer) return { src: out, lines: null }
	return { src: out, lines: [best ?? quoteName(key)] }
}

function isWithin(a: OctoAnalysis, key: string, ancestor: string): boolean {
	const byKey = new Map(a.result.ir.nodes.map((n) => [n.key, n]))
	const seen = new Set<string>()
	for (let p: string | undefined = key; p !== undefined && !seen.has(p); p = byKey.get(p)?.parent) {
		if (p === ancestor) return true
		seen.add(p)
	}
	return false
}

/**
 * Moves `key` into `group` (null = top level). Groups move with their whole
 * block. No-op when it is already there, or when `group` is `key` itself or
 * inside it.
 */
export function moveIntoGroup(src: string, key: string, group: string | null, page = ''): string {
	return onPage(src, page, (body) => moveBody(body, key, group))
}

function moveBody(src: string, key: string, group: string | null): string {
	const a = analyzeOcto(src)
	const node = nodeOf(a, key)
	if (!node) return src
	if ((node.parent ?? null) === group) return src
	if (group !== null) {
		const g = nodeOf(a, group)
		if (!g || isWithin(a, group, key)) return src
	}
	const ex = extract(src, key, group !== null)
	let out = ex.src
	const b = analyzeOcto(out)
	if (group === null) {
		if (!ex.lines) return out
		const still = nodeOf(b, key)
		// a bare leaf still mentioned at the top level needs no new declaration
		if (!node.isContainer && still && still.parent === undefined && ex.lines.join('\n') === quoteName(key)) return out
		return insertTopLevel(out, b, ex.lines)
	}
	const lines = ex.lines ?? [quoteName(key)]
	const target = nodeOf(b, group)
	const blocks = closedBlocks(b, group)
	if (target?.isContainer && blocks.length) return insertIntoBlock(out, blocks[blocks.length - 1], lines)
	// target is a leaf: it becomes a container holding the moved node
	const marker = 'octoMoveMarker7f3e'
	out = addChildBody(out, group, marker)
	const at = out.indexOf(marker)
	return at < 0 ? out : out.slice(0, at) + lines.join('\n' + indentAt(out, at)) + out.slice(at + marker.length)
}

/**
 * Wraps `keys` in a new group `name`, nested inside their deepest common
 * container (so grouping inside a group adds one level). Descendants of other
 * selected keys move with their ancestor.
 */
export function groupNodes(src: string, keys: string[], name: string, page = ''): string {
	return onPage(src, page, (body) => {
		const a = analyzeOcto(body)
		const byKey = new Map(a.result.ir.nodes.map((n) => [n.key, n]))
		const sel = keys.filter((k, i) => byKey.has(k) && keys.indexOf(k) === i)
		if (!sel.length || byKey.has(name)) return body
		const top = sel.filter((k) => !sel.some((o) => o !== k && isWithin(a, k, o)))
		const chain = (k: string) => {
			const out: string[] = []
			const seen = new Set<string>()
			for (let p = byKey.get(k)?.parent; p !== undefined && !seen.has(p); p = byKey.get(p)?.parent) {
				seen.add(p)
				out.push(p)
			}
			return out
		}
		const chains = top.map(chain)
		const parent = chains[0].find((p) => chains.every((c) => c.includes(p))) ?? null
		let out = body
		const lines: string[] = []
		const unit = indentUnit(body)
		for (const k of top) {
			const ex = extract(out, k, true)
			out = ex.src
			lines.push(...reindent(ex.lines ?? [quoteName(k)], unit))
		}
		const block = [`${quoteName(name)} {`, ...lines, '}']
		const b = analyzeOcto(out)
		const blocks = parent ? closedBlocks(b, parent) : []
		if (parent && blocks.length) return insertIntoBlock(out, blocks[blocks.length - 1], block)
		return insertTopLevel(out, b, block)
	})
}

/** Removes group `key`, keeping its contents at its parent's level (connections to the group itself go). */
export function ungroup(src: string, key: string, page = ''): string {
	const r = applyActions(src, [{ type: 'removeNode', key }], { page })
	return r.errors.length ? src : r.code
}
