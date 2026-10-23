import { describe, expect, it } from 'vitest'
import { parseOcto } from '../dsl/parse'
import { printOcto } from '../dsl/print'
import type { DiagramIR } from '../ir'
import { collapseGroups, focusGroup } from './groups'
import { parseOctoPages, parsePage, sourceDirective } from './pages'
import deepFixture from '../../fixtures/deep.octo?raw'
import { collapseToDepth, pagePath, pageTree, type PageTreeNode } from './tree'

/** `name(via)[cycle]` outline, children indented. */
function outline(nodes: PageTreeNode[], indent = ''): string[] {
	const out: string[] = []
	for (const n of nodes) {
		out.push(`${indent}${n.unlinked ? '*' : ''}${n.name || '<root>'}${n.via ? `(${n.via})` : ''}${n.cycle ? '[cycle]' : ''}@${n.depth}`)
		out.push(...outline(n.children, indent + '  '))
	}
	return out
}

function maxDepth(nodes: PageTreeNode[]): number {
	return Math.max(0, ...nodes.map((n) => Math.max(n.depth, maxDepth(n.children))))
}

const CHAIN = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
const chainSrc = () => {
	let src = 'title Chain\nStart [drill: A]\n'
	CHAIN.forEach((p, i) => {
		src += `\npage ${p}\nNode ${p}${i + 1 < CHAIN.length ? ` [drill: ${CHAIN[i + 1]}]` : ''}\n`
	})
	return src
}

describe('pageTree', () => {
	it('follows a 7-level chain', () => {
		const tree = pageTree(chainSrc())
		expect(tree).toHaveLength(1)
		expect(maxDepth(tree)).toBe(7)
		expect(outline(tree)).toEqual(['<root>@0', '  A(Start)@1', '    B(Node A)@2', '      C(Node B)@3', '        D(Node C)@4', '          E(Node D)@5', '            F(Node E)@6', '              G(Node F)@7'])
	})

	it('cuts cycles and marks them', () => {
		const src = 'X [drill: A]\n\npage A\nToB [drill: B]\n\npage B\nBack [drill: A]\nSelf [drill: B]\nDeeper [drill: C]\n\npage C\nUp [drill: A]\nAlsoUp [drill: a]\n'
		expect(outline(pageTree(src))).toEqual(['<root>@0', '  A(X)@1', '    B(ToB)@2', '      A(Back)[cycle]@3', '      C(Deeper)@3', '        A(Up)[cycle]@4'])
	})

	it('places a multi-parent page under its first parent (BFS order)', () => {
		const src = 'P1 [drill: One]\nP2 [drill: Two]\n\npage One\nDeep [drill: Shared]\n\npage Two\nX [drill: Shared]\nY [drill: Shared]\n\npage Shared\nleaf\n'
		expect(outline(pageTree(src))).toEqual(['<root>@0', '  One(P1)@1', '    Shared(Deep)@2', '  Two(P2)@1'])
		// BFS: a shallower link wins over a deeper earlier one
		const bfs = 'P1 [drill: One]\nShared\n\npage One\nX [drill: Shared]\n\npage Shared\nleaf\n'
		expect(outline(pageTree(bfs))).toEqual(['<root>@0', '  One(P1)@1', '  Shared(Shared)@1'])
	})

	it('puts orphan pages and their subtrees under a synthetic Unlinked entry', () => {
		const src = 'A\n\npage A\nx\n\npage Lost\nGo [drill: Lost child]\n\npage Lost child\nBack [drill: Lost]\n\npage Alone\ny\n'
		const tree = pageTree(src)
		expect(tree).toHaveLength(2)
		expect(tree[1]).toMatchObject({ name: 'Unlinked', unlinked: true, depth: 0 })
		expect(outline(tree)).toEqual(['<root>@0', '  A(A)@1', '*Unlinked@0', '  Lost@1', '    Lost child(Go)@2', '      Lost(Back)[cycle]@3', '  Alone@1'])
	})

	it('matches names case-insensitively and lets the first duplicate win', () => {
		const src = 'Go [drill: payments]\n\npage Payments\nNext [drill: STEP]\n\npage Step\nz\n\npage payments\ndup\n'
		const tree = pageTree(src)
		expect(outline(tree)).toEqual(['<root>@0', '  Payments(Go)@1', '    Step(Next)@2'])
	})

	it('self drills never create children', () => {
		const src = 'A [drill: A]\n\npage A\nA [drill: A]\nB\n'
		expect(outline(pageTree(src))).toEqual(['<root>@0', '  A(A)@1'])
	})

	it('a source without pages is just the root', () => {
		expect(pageTree('A > B\n')).toEqual([{ name: '', children: [], depth: 0 }])
	})
})

describe('pagePath', () => {
	it('gives the breadcrumb for deep pages with via keys', () => {
		expect(pagePath(chainSrc(), 'e')).toEqual([
			{ page: '' },
			{ page: 'A', via: 'Start' },
			{ page: 'B', via: 'Node A' },
			{ page: 'C', via: 'Node B' },
			{ page: 'D', via: 'Node C' },
			{ page: 'E', via: 'Node D' },
		])
		expect(pagePath(chainSrc(), '')).toEqual([{ page: '' }])
		expect(pagePath(chainSrc(), 'Nope')).toEqual([])
	})

	it('orphans start at the root then their own chain', () => {
		const src = 'A\n\npage A\nx\n\npage Lost\nGo [drill: Lost child]\n\npage Lost child\ny\n'
		expect(pagePath(src, 'Lost child')).toEqual([{ page: '' }, { page: 'Lost' }, { page: 'Lost child', via: 'Go' }])
		expect(pagePath(src, 'lost')).toEqual([{ page: '' }, { page: 'Lost' }])
	})

	it('ignores cycle leaves', () => {
		const src = 'X [drill: A]\n\npage A\nToB [drill: B]\n\npage B\nBack [drill: A]\n'
		expect(pagePath(src, 'A')).toEqual([{ page: '' }, { page: 'A', via: 'X' }])
	})
})

const NESTED = `L1 {
	L2 {
		L3 {
			L4 {
				L5 {
					leaf
					leaf2
				}
				side4
			}
		}
		side2
	}
}
Other {
	o1
}
top
leaf > top
side4 > o1
`

describe('collapseToDepth', () => {
	const ir = () => parseOcto(NESTED).ir
	it('returns containers at or below the level', () => {
		expect(collapseToDepth(ir(), 1)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'Other'])
		expect(collapseToDepth(ir(), 2)).toEqual(['L2', 'L3', 'L4', 'L5'])
		expect(collapseToDepth(ir(), 3)).toEqual(['L3', 'L4', 'L5'])
		expect(collapseToDepth(ir(), 5)).toEqual(['L5'])
		expect(collapseToDepth(ir(), 6)).toEqual([])
		expect(collapseToDepth(ir(), 0)).toEqual(collapseToDepth(ir(), 1))
		expect(collapseToDepth(ir(), Infinity)).toEqual([])
	})

	it('feeds collapseGroups: only `depth` levels show', () => {
		const one = collapseGroups(ir(), collapseToDepth(ir(), 1))
		expect(one.nodes.map((n) => n.key)).toEqual(['L1', 'Other', 'top'])
		expect(one.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['L1>top', 'L1>Other'])
		const three = collapseGroups(ir(), collapseToDepth(ir(), 3))
		expect(three.nodes.map((n) => n.key)).toEqual(['L1', 'L2', 'L3', 'side2', 'Other', 'o1', 'top'])
		expect(three.nodes.find((n) => n.key === 'L3')!.ext).toEqual({ collapsed: '5', children: '1' })
	})
})

describe('collapsed counts on nested groups', () => {
	it('reports descendants and direct children', () => {
		const ir = parseOcto(NESTED).ir
		const out = collapseGroups(ir, ['L2', 'L5', 'Other'])
		expect(out.nodes.find((n) => n.key === 'L2')!.ext).toEqual({ collapsed: '7', children: '2' })
		expect(out.nodes.find((n) => n.key === 'Other')!.ext).toEqual({ collapsed: '1', children: '1' })
		// L5 is hidden inside collapsed L2
		expect(out.nodes.some((n) => n.key === 'L5')).toBe(false)
		const inner = collapseGroups(ir, ['L5', 'L4'])
		expect(inner.nodes.find((n) => n.key === 'L4')!.ext).toEqual({ collapsed: '4', children: '2' })
	})
})

describe('focus inside focus', () => {
	const ir = () => parseOcto(NESTED + 'leaf2 > side2\nL3 > leaf\nside4 > L1\n').ir
	it('focuses a deep group of the original IR with ghosts against that group', () => {
		const f = focusGroup(ir(), 'L4')
		expect(f.nodes.filter((n) => !n.ext?.ghost).map((n) => n.key)).toEqual(['L5', 'leaf', 'leaf2', 'side4'])
		expect(f.nodes.find((n) => n.key === 'L5')!.parent).toBeUndefined()
		expect(f.nodes.find((n) => n.key === 'leaf')!.parent).toBe('L5')
		const ghosts = f.nodes.filter((n) => n.ext?.ghost).map((n) => n.ext!.ghostOf)
		// top (outside, top level), Other (o1's outermost non-enclosing ancestor), side2 (inside enclosing L2), L3 / L1 (enclosing endpoints are their own ghosts)
		expect(ghosts.sort()).toEqual(['L1', 'L3', 'Other', 'side2', 'top'])
		const e = f.edges.map((x) => `${x.from}>${x.to}`)
		expect(e).toContain('leaf>ghost:top')
		expect(e).toContain('side4>ghost:Other')
		expect(e).toContain('leaf2>ghost:side2')
		expect(e).toContain('ghost:L3>leaf')
		expect(e).toContain('side4>ghost:L1')
	})

	it('works the same as nested focus steps and composes with collapse', () => {
		const f = focusGroup(ir(), 'L2')
		const deeper = focusGroup(ir(), 'L4')
		// focusing L4 within the L2 view is computed on the original IR: same visible nodes as focusing L4 in the L2 view
		const viaView = focusGroup(f, 'L4')
		expect(viaView.nodes.filter((n) => !n.ext?.ghost).map((n) => n.key)).toEqual(deeper.nodes.filter((n) => !n.ext?.ghost).map((n) => n.key))
		const collapsed = collapseGroups(deeper, ['L5'])
		expect(collapsed.nodes.find((n) => n.key === 'L5')!.ext).toEqual({ collapsed: '2', children: '2' })
		expect(collapsed.edges.map((x) => `${x.from}>${x.to}`)).toContain('L5>ghost:top')
	})
})

describe('source directive', () => {
	it('parses and prints after the title', () => {
		const r = parseOcto('title T\nsource github.com/o/r@abc123\nA [src: "local:apps/x"]\n')
		expect(r.diagnostics).toEqual([])
		expect(r.ir.source).toBe('github.com/o/r@abc123')
		expect(r.ir.nodes.map((n) => n.key)).toEqual(['A'])
		const printed = printOcto(r.ir)
		expect(printed).toBe('title T\nsource github.com/o/r@abc123\n\nA [src: local:apps/x]\n')
		expect(parseOcto(printed).ir).toMatchObject({ source: 'github.com/o/r@abc123' })
	})

	it('keeps URLs, cloud inputs and quoted values', () => {
		expect(parseOcto('source https://github.com/o/r\n').ir.source).toBe('https://github.com/o/r')
		expect(parseOcto('source aws:prod@us-east-1\n').ir.source).toBe('aws:prod@us-east-1')
		expect(parseOcto('source "/Users/me/my repo" // c\n').ir.source).toBe('/Users/me/my repo')
		const ir = parseOcto('A\n').ir
		ir.source = '/tmp/a b {x}'
		expect(parseOcto(printOcto(ir)).ir.source).toBe('/tmp/a b {x}')
	})

	it('a lone source, an edge from source and source in a group stay nodes', () => {
		expect(parseOcto('source\n').ir.nodes.map((n) => n.key)).toEqual(['source'])
		const e = parseOcto('source > x\n').ir
		expect(e.source).toBeUndefined()
		expect(e.edges.map((x) => `${x.from}>${x.to}`)).toEqual(['source>x'])
		const g = parseOcto('G {\n  source db\n}\n').ir
		expect(g.source).toBeUndefined()
		expect(g.nodes.map((n) => n.key)).toEqual(['G', 'source db'])
		// the printer quotes such names so they never turn into the directive
		expect(printOcto(g)).toContain('"source db"')
		expect(parseOcto(printOcto(g)).ir.nodes.map((n) => n.key)).toEqual(['G', 'source db'])
	})

	it('is root-only: warning on other pages, sourceDirective reads the root', () => {
		const src = 'source /repo\nA\n\npage P\nsource /other\nB\n'
		const { diagnostics } = parseOctoPages(src)
		expect(diagnostics.map((d) => d.message)).toEqual(['"source" is only read from the root page'])
		expect(parsePage(src, 'P')!.ir.source).toBeUndefined()
		expect(parsePage(src, '')!.ir.source).toBe('/repo')
		expect(sourceDirective(src)).toBe('/repo')
		expect(sourceDirective('page P\nsource /x\n')).toBeUndefined()
		expect(sourceDirective('A > B\n')).toBeUndefined()
		expect(sourceDirective('G {\n  source db\n}\n')).toBeUndefined()
	})
})

describe('fixtures/deep.octo', () => {
	const src = deepFixture
	it('parses cleanly with deep pages, nested groups, a cycle and an orphan', () => {
		const { pages, diagnostics } = parseOctoPages(src)
		expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(diagnostics).toEqual([])
		const tree = pageTree(src)
		expect(maxDepth(tree)).toBeGreaterThanOrEqual(6)
		expect(outline(tree).some((l) => l.includes('[cycle]'))).toBe(true)
		expect(tree[1]?.unlinked).toBe(true)
		const nesting = (ir: DiagramIR) => {
			const byKey = new Map(ir.nodes.map((n) => [n.key, n]))
			let max = 0
			for (const n of ir.nodes) {
				let d = 0
				for (let p = n.parent; p; p = byKey.get(p)?.parent) d++
				max = Math.max(max, d)
			}
			return max
		}
		expect(Math.max(...pages.map((p) => nesting(p.ir)))).toBeGreaterThanOrEqual(5)
		const deepest = pagePath(src, 'Platform / Checkout / Payments / Card processing / Authorization / Issuer gateway')
		expect(deepest).toHaveLength(7)
		expect(deepest[1]).toEqual({ page: 'Platform', via: 'Platform' })
	})
})
