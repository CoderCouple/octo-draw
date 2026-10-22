import { describe, expect, it } from 'vitest'
import { Store } from '@tldraw/store'
import { b64Vecs, createTLSchema, toRichText } from '@tldraw/tlschema'
import { parseOcto } from '../dsl/parse'
import { layoutDiagram } from '../layout/layout'
import { createDocument, validateDocument } from '../doc'
import { decodePoints, encodePoints, halfToNumber, numberToHalf } from './b64points'
import { octonoteFlowchart, sketchBoard } from './fixtures'
import { fromTldrawSnapshot, indexKey, isTldrawSnapshot, plainToRichText, richTextToPlain, TLDRAW_SCHEMA, toTldrawSnapshot } from './tldraw'

/** Puts records in a real tldraw store, which runs tldraw's own validators (throws on bad records). */
function validateWithTldraw(records: unknown[]) {
	const store = new Store({ schema: createTLSchema(), props: { defaultName: '', assets: {}, onMount: () => {} } } as never)
	store.put(records as never)
	return store
}

describe('b64 point encoding', () => {
	const pts = [{ x: 1.5, y: -2, z: 0.5 }, { x: 11.5, y: 3, z: 0.75 }, { x: 30, y: 4.25, z: 0.25 }]

	it('round-trips (3D and 2D)', () => {
		expect(decodePoints(encodePoints(pts))).toEqual(pts)
		expect(decodePoints(encodePoints(pts, 2), 2)).toEqual(pts.map((p) => ({ ...p, z: 0.5 })))
	})

	it('matches tldraw (bit-compatible both ways)', () => {
		expect(encodePoints(pts)).toBe(b64Vecs.encodePoints(pts))
		const theirs = b64Vecs.encodePoints([{ x: 100.25, y: 7, z: 0.5 }, { x: 140, y: -20, z: 0.5 }])
		expect(decodePoints(theirs)).toEqual(b64Vecs.decodePoints(theirs))
	})

	it('half floats', () => {
		for (const v of [0, 1, -1, 0.5, 2.25, 1000, -0.0001, 65504]) expect(halfToNumber(numberToHalf(v))).toBeCloseTo(v, 2)
	})
})

describe('rich text', () => {
	it('converts to plain text and back', () => {
		expect(richTextToPlain(toRichText('a\n\nb'))).toBe('a\n\nb')
		expect(plainToRichText('a\n\nb')).toEqual(toRichText('a\n\nb'))
		expect(richTextToPlain({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }, { type: 'hardBreak' }, { type: 'text', text: 'y', marks: [{ type: 'bold' }] }] }] })).toBe('x\ny')
		expect(richTextToPlain(null)).toBe('')
	})
})

describe('indexKey', () => {
	it('is strictly ascending and valid for tldraw', () => {
		const keys = Array.from({ length: 4000 }, (_, i) => indexKey(i))
		for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true)
		expect(keys.slice(0, 2)).toEqual(['a0', 'a1'])
		expect(keys[62]).toBe('b00')
	})
})

describe('fromTldrawSnapshot — Octonote mermaid canvas', () => {
	const warnings: string[] = []
	const doc = fromTldrawSnapshot(octonoteFlowchart(), { onWarning: (w) => warnings.push(w) })
	const { ir, diagnostics } = parseOcto(doc.code)
	const node = (k: string) => ir.nodes.find((n) => n.key === k)!

	it('produces a valid document with parseable code', () => {
		expect(validateDocument(doc).ok).toBe(true)
		expect(diagnostics).toEqual([])
		expect(isTldrawSnapshot(octonoteFlowchart())).toBe(true)
		expect(isTldrawSnapshot({ code: 'x' })).toBe(false)
	})

	it('maps geo shapes to nodes with shapes, colors and links', () => {
		expect(ir.nodes.map((n) => n.key).sort()).toEqual(['API', 'App servers', 'Box 1', 'Cache hit?', 'Love it', 'Redis', 'User'].sort())
		expect(node('User').shape).toBe('ellipse')
		expect(node('Cache hit?').shape).toBe('diamond')
		expect(node('Redis').style?.color).toBe('blue')
		expect(node('API').link).toBe('https://example.com')
		expect(node('Love it').ext).toEqual({ geo: 'heart' })
		expect(node('Box 1').label).toBe('')
		expect(warnings).toContain('geo "heart" has no octo shape; imported as a rectangle')
	})

	it('turns the dashed box into a group by containment', () => {
		expect(node('App servers').isContainer).toBe(true)
		expect(node('API').parent).toBe('App servers')
		expect(node('Cache hit?').parent).toBe('App servers')
		expect(node('User').parent).toBeUndefined()
	})

	it('turns bound arrows into edges', () => {
		expect(ir.edges.map((e) => [e.from, e.to])).toEqual([
			['User', 'API'],
			['API', 'Cache hit?'],
			['Cache hit?', 'Redis'],
		])
		const yes = ir.edges[2]
		expect(yes.label).toBe('yes')
		expect(yes.style?.dash ?? yes.line.dash).toBe('dotted')
		expect(yes.arrow).toEqual({ start: 'arrow', end: 'arrow' })
		expect(yes.style?.color).toBe('red')
		expect(ir.direction).toBe('right')
	})

	it('pins leaf nodes so their centers stay where they were', async () => {
		expect(Object.keys(doc.pins).sort()).toEqual(['API', 'Box 1', 'Cache hit?', 'Love it', 'Redis', 'User'].sort())
		const layout = await layoutDiagram(ir, { pinned: doc.pins })
		const api = layout.nodes['API']
		expect(api.x + api.w / 2).toBeCloseTo(260, 0)
		expect(api.y + api.h / 2).toBeCloseTo(108, 0)
		const group = layout.nodes['App servers']
		expect(group.x).toBeLessThan(api.x)
	})
})

describe('fromTldrawSnapshot — hand-drawn board', () => {
	const warnings: string[] = []
	const doc = fromTldrawSnapshot(sketchBoard(), { onWarning: (w) => warnings.push(w) })
	const { ir } = parseOcto(doc.code)
	const free = (id: string) => doc.shapes.find((s) => s.id === id)!

	it('picks the first page by index and uses its name as title', () => {
		expect(doc.title).toBe('Board')
		expect(ir.nodes.find((n) => n.key === 'Elsewhere')).toBeUndefined()
	})

	it('maps frames to groups and parents their children, deduplicating keys', () => {
		const frame = ir.nodes.find((n) => n.key === 'Backend')!
		expect(frame.isContainer).toBe(true)
		const kids = ir.nodes.filter((n) => n.parent === 'Backend')
		expect(kids.map((k) => k.key)).toEqual(['Worker', 'Worker (2)'])
		expect(kids[1].label).toBe('Worker')
		expect(kids[0].style?.color).toBe('green')
		expect(doc.pins['Worker'].x).toBeGreaterThan(1000)
	})

	it('converts text through tldraw groups with absolute positions', () => {
		const t = free('text')
		expect(t).toMatchObject({ type: 'text', x: 110, y: 120, text: 'Hello\nworld', size: 3, color: '#ef4444' })
	})

	it('decodes draw segments (with scale) into pen points', () => {
		const d = free('draw')
		expect(d.type).toBe('pen')
		expect(d.pressure).toBe(true)
		expect(d.points).toEqual([[300, 300, 0.5], [320, 305, 0.6], [340, 300, 0.4]])
		expect(d.color).toBe('#3b82f6')
	})

	it('converts lines, notes, images and loose arrows', () => {
		expect(free('line').points).toEqual([[0, 500, 0.5], [50, 550, 0.5]])
		expect(free('note')).toMatchObject({ type: 'sticky', x: 600, y: 0, w: 200, h: 200, text: 'Remember', color: 'ink' })
		expect(free('img')).toMatchObject({ type: 'image', w: 64, h: 48, src: 'https://example.com/cat.png' })
		expect(free('loose')).toMatchObject({ type: 'arrow', points: [[0, 800, 0.5], [80, 840, 0.5]] })
		expect(validateDocument(doc).ok).toBe(true)
	})

	it('warns about lost rotation', () => {
		expect(warnings).toContain('1 rotated shape(s) imported without rotation')
	})

	it('accepts a bare record list and rejects junk', () => {
		const records = Object.values(octonoteFlowchart().store)
		expect(parseOcto(fromTldrawSnapshot(records).code).ir.edges).toHaveLength(3)
		expect(() => fromTldrawSnapshot(42)).toThrow(/not a tldraw snapshot/)
	})
})

describe('toTldrawSnapshot', () => {
	it('declares the schema of tldraw 5.5', () => {
		expect(TLDRAW_SCHEMA).toEqual(createTLSchema().serialize())
	})

	it('produces records tldraw accepts, with bound arrows and dashed groups', async () => {
		const doc = createDocument({
			title: 'Demo',
			code: `Users [shape: oval]\nBackend [color: blue] {\n  API [shape: cylinder, link: "https://x.dev"]\n  Worker\n}\nUsers > API: HTTPS\nAPI --> Worker\nAPI <> Users [color: red]\n`,
			shapes: [
				{ id: 'p', type: 'pen', x: 0, y: 0, w: 0, h: 0, points: [[10, 10, 0.5], [20, 30, 0.6]], color: 'ink', size: 2, pressure: true },
				{ id: 'r', type: 'rect', x: 0, y: 0, w: 50, h: 40, color: '#ef4444', size: 1 },
				{ id: 'e', type: 'ellipse', x: 0, y: 0, w: 50, h: 40, color: 'ink', size: 4 },
				{ id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [[0, 0, 0.5], [40, 40, 0.5]], color: 'ink', size: 1 },
				{ id: 't', type: 'text', x: 5, y: 5, w: 60, h: 20, text: 'note\nhere', color: 'ink', size: 2 },
				{ id: 's', type: 'sticky', x: 300, y: 5, w: 200, h: 240, text: 'todo', color: '#22c55e', size: 1 },
				{ id: 'i', type: 'image', x: 600, y: 5, w: 64, h: 32, src: 'data:image/png;base64,iVBORw0KGgo=', color: 'ink', size: 1 },
			],
		})
		const layout = await layoutDiagram(parseOcto(doc.code).ir)
		const snap = toTldrawSnapshot(doc, layout)
		const records = Object.values(snap.store)
		const store = validateWithTldraw(records)
		expect(store.allRecords().length).toBe(records.length)

		const shapes = records.filter((r) => r.typeName === 'shape') as any[]
		const group = shapes.find((s) => s.meta.octo?.key === 'Backend')
		expect(group.props).toMatchObject({ dash: 'dashed', fill: 'none', color: 'blue' })
		const nodes = shapes.filter((s) => s.type === 'geo' && s.meta.octo?.key)
		expect(nodes.every((n) => n === group || n.index > group.index)).toBe(true)
		expect(records.filter((r) => r.typeName === 'binding')).toHaveLength(6)
		expect(shapes.filter((s) => s.type === 'draw')).toHaveLength(1)
		const api = shapes.find((s) => s.meta.octo?.key === 'API')
		expect(api.props.url).toBe('https://x.dev')

		// and back: keys, groups, shapes and edge styles survive
		const back = fromTldrawSnapshot(snap)
		const ir = parseOcto(back.code).ir
		expect(ir.nodes.find((n) => n.key === 'API')).toMatchObject({ shape: 'cylinder', parent: 'Backend' })
		expect(ir.nodes.find((n) => n.key === 'Users')?.shape).toBe('oval')
		expect(ir.edges.map((e) => `${e.from}>${e.to}:${e.line.dash}:${e.label ?? ''}`)).toEqual(['Users>API:solid:HTTPS', 'API>Worker:dotted:', 'API>Users:solid:'])
		expect(ir.edges[2].arrow).toEqual({ start: 'arrow', end: 'arrow' })
		expect(back.shapes.map((s) => s.type).sort()).toEqual(['arrow', 'ellipse', 'image', 'pen', 'rect', 'sticky', 'text'])
		expect(back.shapes.find((s) => s.type === 'sticky')).toMatchObject({ id: 's', w: 200, h: 240, text: 'todo', color: '#22c55e' })
		expect(back.shapes.find((s) => s.type === 'image')).toMatchObject({ id: 'i', src: 'data:image/png;base64,iVBORw0KGgo=' })
		expect(back.shapes.find((s) => s.type === 'rect')).toMatchObject({ id: 'r', w: 50, h: 40, color: '#ef4444' })
		const pen = back.shapes.find((s) => s.type === 'pen')!
		expect(pen.points).toEqual([[10, 10, 0.5], [20, 30, 0.6]])
	})

	it('produces a snapshot a tldraw store can load and migrate', async () => {
		const doc = fromTldrawSnapshot(octonoteFlowchart())
		const layout = await layoutDiagram(parseOcto(doc.code).ir, { pinned: doc.pins })
		const snap = toTldrawSnapshot(doc, layout)
		const store = new Store({ schema: createTLSchema(), props: { defaultName: '', assets: {}, onMount: () => {} } } as never)
		store.loadStoreSnapshot(snap as never)
		expect(store.allRecords().filter((r: any) => r.typeName === 'shape').length).toBeGreaterThan(5)
	})
})
