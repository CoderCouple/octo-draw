import { describe, expect, it } from 'vitest'
import { parseOcto } from '../dsl/parse'
import { layoutDiagram } from '../layout/layout'
import { createDocument } from '../doc'
import type { FreeShape } from '../free'
import { escapeXml, renderDiagramSvg, renderDocumentSvg } from './svg'

const SRC = `title Shop & "co"
colorMode pastel
styleMode shadow
Users [icon: users, shape: oval]
Backend [color: blue] {
  API [icon: server]
  Worker
}
DB [shape: cylinder, label: "Postgres <16>"]
Users > API: HTTPS
API > Worker
Worker --> DB
`

/** Minimal well-formedness check: every tag closes in order. */
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

const count = (svg: string, re: RegExp) => [...svg.matchAll(re)].length

describe('renderDiagramSvg', async () => {
	const { ir } = parseOcto(SRC)
	const layout = await layoutDiagram(ir)
	const svg = renderDiagramSvg(ir, layout)

	it('is a standalone, well-formed SVG', () => {
		expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
		expect(svg).toMatch(/viewBox="[-\d.]+ [-\d.]+ \d+ \d+"/)
		expect(svg).not.toMatch(/undefined|NaN/)
		assertBalanced(svg)
	})

	it('draws one element per node, group and edge', () => {
		expect(count(svg, /data-node="/g)).toBe(4) // Users, API, Worker, DB
		expect(count(svg, /data-group="/g)).toBe(1)
		expect(count(svg, /data-edge="/g)).toBe(3)
		expect(svg).toContain('data-group="Backend"')
		expect(svg).toContain('data-edge="Users-&gt;API#0"')
	})

	it('escapes text', () => {
		expect(svg).toContain('Postgres &lt;16&gt;')
		expect(svg).toContain('<title>Shop &amp; &quot;co&quot;</title>')
	})

	it('tints colored groups and keeps the rest monochrome', () => {
		expect(svg).toMatch(/data-group="Backend"[^>]*><path[^>]*fill="#ebf3fe"/)
		expect(svg).toMatch(/data-node="Users"[^>]*><path[^>]*fill="#FFFFFF"[^>]*stroke="#37352F"/)
	})

	it('draws arrowheads, dotted lines, labels and the shadow filter', () => {
		expect(svg).toContain('stroke-dasharray="1.5 5"')
		expect(svg).toContain('HTTPS')
		expect(svg).toContain('id="octo-shadow"')
		expect(count(svg, /filter="url\(#octo-shadow\)"/g)).toBe(4)
	})

	it('renders icons as badges by default and via a resolver when given', () => {
		expect(svg).toMatch(/data-icon="server"[^>]*><rect/)
		const withIcons = renderDiagramSvg(ir, layout, { icon: (n) => (n === 'server' ? [['rect', { x: 2, y: 2, width: 20, height: 8, rx: 2, key: 'k' }]] : null) })
		expect(withIcons).toMatch(/<svg x="[\d.]+" y="[\d.]+" width="20" height="20" viewBox="0 0 24 24"[^>]*data-icon="server"><rect x="2" y="2" width="20" height="8" rx="2"\/><\/svg>/)
		expect(withIcons).not.toContain('key=')
	})

	it('supports dark theme and no background', () => {
		const dark = renderDiagramSvg(ir, layout, { theme: 'dark' })
		expect(dark).toContain('data-theme="dark"')
		expect(dark).toMatch(/data-background="" [^>]*fill="#0A0A0B"/)
		expect(renderDiagramSvg(ir, layout, { background: false })).not.toContain('data-background')
	})

	it('scales width/height but not the viewBox', () => {
		const w = Number(svg.match(/ width="(\d+)"/)![1])
		const big = renderDiagramSvg(ir, layout, { scale: 2 })
		expect(Number(big.match(/ width="(\d+)"/)![1])).toBe(w * 2)
		expect(big.match(/viewBox="[^"]+"/)![0]).toBe(svg.match(/viewBox="[^"]+"/)![0])
	})
})

describe('freehand layer and documents', () => {
	const shapes: FreeShape[] = [
		{ id: 'p', type: 'pen', x: 0, y: 0, w: 0, h: 0, points: [[10, 10, 0.5], [20, 30, 0.5], [40, 35, 0.5]], color: 'ink', size: 2 },
		{ id: 'r', type: 'rect', x: 500, y: 500, w: -40, h: 30, color: '#ef4444', size: 1 },
		{ id: 'e', type: 'ellipse', x: 0, y: 100, w: 40, h: 30, color: 'ink', size: 1 },
		{ id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [[0, 0, 0.5], [100, 0, 0.5]], color: 'ink', size: 3 },
		{ id: 't', type: 't' as never, x: 0, y: 0, w: 0, h: 0, color: 'ink', size: 1 },
		{ id: 'x', type: 'text', x: 5, y: 200, w: 80, h: 20, text: 'hi <there>\nline 2', color: 'ink', size: 1 },
		{ id: 's', type: 'sticky', x: 300, y: 0, w: 200, h: 200, text: 'a sticky note with quite a few words to wrap', color: 'ink', size: 1 },
		{ id: 'i', type: 'image', x: 600, y: 0, w: 64, h: 32, src: 'https://example.com/a.png?x=1&y=2', color: 'ink', size: 1 },
		{ id: 'i2', type: 'image', x: 700, y: 0, w: 64, h: 32, color: 'ink', size: 1 },
	]

	it('renders each free shape kind', async () => {
		const svg = await renderDocumentSvg(createDocument({ code: 'A > B', shapes }))
		assertBalanced(svg)
		expect(svg).toContain('data-layer="freehand"')
		for (const id of ['p', 'r', 'e', 'a', 'x', 's', 'i', 'i2']) expect(svg).toContain(`data-shape="${id}"`)
		expect(svg).toContain('fill="rgb(253, 239, 180)"')
		expect(count(svg, /data-shape="s"[\s\S]*?<\/g>/g)).toBe(1)
		expect(svg.match(/data-shape="s"[\s\S]*?<\/g>/)![0].match(/<tspan/g)!.length).toBeGreaterThan(1)
		expect(svg).toContain('href="https://example.com/a.png?x=1&amp;y=2"')
		expect(svg).not.toContain('data-shape="t"')
		expect(svg).toMatch(/<rect data-shape="r" data-type="rect" x="460" y="500" width="40" height="30"/)
		expect(svg).toContain('hi &lt;there&gt;')
	})

	it('includes free shapes in the bounds', async () => {
		const far: FreeShape = { id: 'far', type: 'rect', x: 5000, y: 5000, w: 10, h: 10, color: 'ink', size: 1 }
		const svg = await renderDocumentSvg(createDocument({ code: 'A', shapes: [far] }))
		expect(Number(svg.match(/ width="(\d+)"/)![1])).toBeGreaterThan(4000)
	})

	it('honors pins', async () => {
		const svg = await renderDocumentSvg(createDocument({ code: 'A > B', pins: { A: { x: 1000, y: 1000 } } }))
		expect(svg).toContain('data-node="A" transform="translate(1000,1000)"')
	})

	it('renders an empty document', async () => {
		const svg = await renderDocumentSvg(createDocument())
		assertBalanced(svg)
		expect(svg).toContain('data-layer="diagram"')
	})
})

it('escapeXml', () => {
	expect(escapeXml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
})
