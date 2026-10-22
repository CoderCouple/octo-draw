import { describe, expect, it } from 'vitest'
import { parseOcto } from '../dsl/parse'
import { layoutDiagram } from '../layout/layout'
import { renderDiagramSvg } from './svg'
import { crowsFoot } from './kinds'

const count = (svg: string, re: RegExp) => [...svg.matchAll(re)].length

function assertBalanced(svg: string) {
	const stack: string[] = []
	for (const m of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
		const [, close, tag, self] = m
		if (self) continue
		if (close) expect(stack.pop()).toBe(tag)
		else stack.push(tag)
	}
	expect(stack).toEqual([])
}

describe('sequence SVG', async () => {
	const src = `sequence
autoNumber on
A [color: blue] > B: request <1>
activate B
B > C: q
C --> B: r
B --> A: done
deactivate B
loop [label: retry] {
	A > C: ping
	alt [label: ok] {
		C > A: pong
	} else [label: err] {
		note over A, C: give up
	}
}
note right of C: side
C > C: self
`
	const ir = parseOcto(src).ir
	const layout = await layoutDiagram(ir)
	const svg = renderDiagramSvg(ir, layout)

	it('is well-formed and tagged as a sequence', () => {
		assertBalanced(svg)
		expect(svg).toContain('data-kind="sequence"')
		expect(svg).not.toMatch(/undefined|NaN/)
	})

	it('draws head and foot boxes, lifelines and activations', () => {
		expect(count(svg, /data-node="/g)).toBe(3)
		expect(count(svg, /data-foot="/g)).toBe(3)
		expect(count(svg, /data-lifeline="/g)).toBe(3)
		expect(count(svg, /stroke-dasharray="5 5"/g)).toBe(3)
		expect(count(svg, /data-activation="B"/g)).toBe(1)
	})

	it('draws numbered messages with arrowheads, dotted replies and escaped labels', () => {
		expect(count(svg, /data-message="/g)).toBe(7)
		expect(count(svg, /data-number="/g)).toBe(7)
		expect(count(svg, /stroke-dasharray="6 5"/g)).toBe(2)
		expect(svg).toContain('request &lt;1&gt;')
		// self message loops out and back
		expect(svg).toMatch(/data-message="\d+"><path d="M[\d.]+,[\d.]+ H[\d.]+ Q/)
	})

	it('draws block frames with section dividers and notes', () => {
		expect(svg).toContain('data-block="loop"')
		expect(svg).toContain('data-block="alt"')
		expect(svg).toContain('[retry]')
		expect(svg).toContain('[err]')
		expect(count(svg, /data-section=""/g)).toBe(1)
		expect(count(svg, /data-note=""/g)).toBe(2)
		expect(svg).toContain('give up')
	})

	it('tints colored participants', () => {
		expect(svg).toMatch(/data-node="A"[^>]*><path[^>]*fill="#e4eefe"/)
	})
})

describe('ERD SVG', async () => {
	const src = `erd
users [color: green] {
	id string pk
	name string
	teamId string fk
}
teams {
	id string pk
	title string
}
users.teamId > teams.id: belongs to
users.id < posts.authorId
`
	const ir = parseOcto(src).ir
	const layout = await layoutDiagram(ir)
	const svg = renderDiagramSvg(ir, layout, { theme: 'dark' })

	it('is well-formed and tagged as an ERD', () => {
		assertBalanced(svg)
		expect(svg).toContain('data-kind="erd"')
		expect(svg).not.toMatch(/undefined|NaN/)
	})

	it('draws entity tables with field rows, types and badges', () => {
		expect(svg).toContain('data-node="users"')
		expect(svg).toContain('data-node="teams"')
		expect(count(svg, /data-field="/g)).toBeGreaterThanOrEqual(5)
		expect(count(svg, /data-badge="PK"/g)).toBe(2)
		expect(count(svg, /data-badge="FK"/g)).toBe(1)
		expect(svg).toMatch(/data-field="teamId"[\s\S]*?>string</)
	})

	it('draws relationships with crow\'s-feet markers and labels', () => {
		expect(count(svg, /data-edge="/g)).toBe(2)
		expect(count(svg, /data-cardinality="/g)).toBe(2)
		expect(svg).toContain('belongs to')
	})

	it('renders Chen notation tags', async () => {
		const chen = parseOcto(src).ir
		chen.erd = { notation: 'chen' }
		const out = renderDiagramSvg(chen, await layoutDiagram(chen))
		expect(out).not.toContain('data-cardinality')
		expect(out).toMatch(/font-weight="700"[^>]*>(1|N|M)</)
	})
})

it('crowsFoot draws a fork for many and a bar for one', () => {
	const many = crowsFoot({ x: 0, y: 0 }, { x: 100, y: 0 }, true)
	const one = crowsFoot({ x: 0, y: 0 }, { x: 100, y: 0 }, false)
	expect(many).toBe('M18,-6 L18,6 M0,-7 L13,0 L0,7 M0,0 L13,0')
	expect(one).toBe('M18,-6 L18,6 M12,-6 L12,6')
})
