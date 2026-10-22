import { parseOcto, printOcto } from '@octo-draw/core'
import { describe, expect, it } from 'vitest'
import type { Message, StreamFn, StreamRequest } from './claude'
import { EdgesOutput, imageSize, NodesOutput, visionImport, visionToIR, visionTwoPass } from './vision'
import { VISION_EDGES_SCHEMA, VISION_NODES_SCHEMA } from './visionPrompts'

const msg = (text: string, stop_reason = 'end_turn'): Message => ({ content: [{ type: 'text', text }], stop_reason }) as unknown as Message

const node = (id: string, label: string, bbox: [number, number, number, number], extra: Record<string, unknown> = {}) => ({
	id,
	label,
	shape: 'rectangle',
	bbox: { x: bbox[0], y: bbox[1], w: bbox[2], h: bbox[3] },
	parent: null,
	is_container: false,
	color: null,
	icon: null,
	confidence: 0.9,
	...extra,
})

const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({
	from,
	to,
	direction: 'forward',
	label: null,
	dashed: false,
	from_point: null,
	to_point: null,
	confidence: 0.9,
	...extra,
})

const NODES = NodesOutput.parse({
	is_diagram: true,
	kind: 'architecture',
	direction: 'right',
	title: 'Shop',
	nodes: [
		node('n1', 'Users', [20, 400, 120, 100], { shape: 'oval', icon: 'users' }),
		node('g1', 'AWS VPC', [250, 100, 700, 800], { is_container: true }),
		node('n2', 'API', [300, 400, 150, 100], { parent: 'g1', color: 'blue' }),
		node('n3', 'Orders DB', [700, 400, 150, 120], { parent: 'g1', shape: 'cylinder' }),
	],
})

// Minimal PNG header with an IHDR chunk
function pngHeader(w: number, h: number): string {
	const b = Buffer.alloc(33)
	b.writeUInt32BE(0x89504e47, 0)
	b.writeUInt32BE(0x0d0a1a0a, 4)
	b.writeUInt32BE(13, 8)
	b.write('IHDR', 12, 'ascii')
	b.writeUInt32BE(w, 16)
	b.writeUInt32BE(h, 20)
	return b.toString('base64')
}

describe('visionToIR', () => {
	it('converts nodes, groups and edges to IR and valid octo code', () => {
		const edges = EdgesOutput.parse({
			edges: [edge('n1', 'n2', { label: 'HTTPS' }), edge('n2', 'n3', { dashed: true, direction: 'both' })],
		})
		const r = visionToIR(NODES, edges, { width: 1000, height: 500 })
		expect(r.ir.kind).toBe('architecture')
		expect(r.ir.direction).toBe('right')
		expect(r.ir.nodes.find((n) => n.key === 'AWS VPC')).toMatchObject({ isContainer: true })
		expect(r.ir.nodes.find((n) => n.key === 'API')).toMatchObject({ parent: 'AWS VPC', style: { color: 'blue' } })
		expect(r.ir.nodes.find((n) => n.key === 'Users')).toMatchObject({ shape: 'oval', icon: 'users' })
		expect(r.ir.edges.map((e) => [e.from, e.to, e.label, e.arrow.start, e.arrow.end, e.line.dash])).toEqual([
			['Users', 'API', 'HTTPS', 'none', 'arrow', 'solid'],
			['API', 'Orders DB', undefined, 'arrow', 'arrow', 'dotted'],
		])
		expect(r.unresolved).toEqual([])
		expect(r.confidence).toBeGreaterThan(0.8)
		const code = printOcto(r.ir)
		expect(parseOcto(code).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
	})

	it('pins leaf nodes from bboxes, keeping order and aspect ratio', () => {
		const r = visionToIR(NODES, { edges: [] }, { width: 1000, height: 500 })
		expect(Object.keys(r.pins).sort()).toEqual(['API', 'Orders DB', 'Users'])
		expect(r.pins.Users.x).toBeLessThan(r.pins.API.x)
		expect(r.pins.API.x).toBeLessThan(r.pins['Orders DB'].x)
		// same row in the image → same centre line; 2:1 image → x spread ≈ 2× y spread units
		expect(Math.abs(r.pins.API.y - r.pins.Users.y)).toBeLessThan(15)
		const dx = r.pins['Orders DB'].x - r.pins.API.x
		expect(dx).toBeGreaterThan(500)
	})

	it('snaps endpoints by name, by position, and drops the rest', () => {
		const edges = EdgesOutput.parse({
			edges: [
				edge('users', 'API'), // case-insensitive id / exact label
				edge('n9', 'n3', { from_point: { x: 330, y: 450 } }), // unknown id, point inside API
				edge('Orders', 'n1'), // partial label
				edge('ghost', 'n2'), // unresolvable
			],
		})
		const r = visionToIR(NODES, edges, null)
		expect(r.ir.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['Users>API', 'API>Orders DB', 'Orders DB>Users'])
		expect(r.unresolved).toHaveLength(1)
		expect(r.unresolved[0]).toMatch(/ghost/)
		expect(r.warnings.some((w) => /by position/.test(w))).toBe(true)
	})

	it('prefers the innermost node under a point and ignores far points', () => {
		const edges = EdgesOutput.parse({
			edges: [edge('x', 'n2', { from_point: { x: 720, y: 450 } }), edge('y', 'n2', { from_point: { x: 990, y: 990 } })],
		})
		const r = visionToIR(NODES, edges, null)
		expect(r.ir.edges.map((e) => e.from)).toEqual(['Orders DB'])
		expect(r.unresolved).toHaveLength(1)
	})

	it('repairs duplicate ids, unknown parents, cycles and duplicate labels', () => {
		const nodes = NodesOutput.parse({
			is_diagram: true,
			kind: 'flowchart',
			direction: 'down',
			title: null,
			nodes: [
				node('a', 'Worker', [0, 0, 10, 10], { parent: 'b' }),
				node('b', 'Group', [0, 0, 100, 100], { parent: 'a' }),
				node('a', 'Worker', [200, 0, 10, 10]),
				node('c', 'C', [400, 0, 10, 10], { parent: 'zzz' }),
			],
		})
		const r = visionToIR(nodes, { edges: [] }, null)
		expect(r.ir.nodes.map((n) => [n.key, n.label])).toEqual(
			expect.arrayContaining([
				['Worker', undefined],
				['Worker 2', 'Worker'],
				['Group', undefined],
				['C', undefined],
			]),
		)
		expect(r.warnings.join('\n')).toMatch(/Duplicate node id a/)
		expect(r.warnings.join('\n')).toMatch(/unknown parent zzz/)
		expect(r.warnings.join('\n')).toMatch(/cycle/)
	})
})

describe('schemas', () => {
	const walk = (s: unknown, visit: (o: Record<string, unknown>) => void) => {
		if (!s || typeof s !== 'object') return
		if (!Array.isArray(s)) visit(s as Record<string, unknown>)
		for (const v of Object.values(s)) walk(v, visit)
	}
	it.each([
		['nodes', VISION_NODES_SCHEMA],
		['edges', VISION_EDGES_SCHEMA],
	])('%s schema follows structured-output limits', (_n, schema) => {
		walk(schema, (o) => {
			if (o.type === 'object') {
				expect(o.additionalProperties).toBe(false)
				expect(Object.keys(o.properties as object).sort()).toEqual([...(o.required as string[])].sort())
			}
			for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) expect(o[bad]).toBeUndefined()
		})
	})
})

describe('imageSize', () => {
	it('reads PNG dimensions', () => {
		expect(imageSize(pngHeader(1000, 500))).toEqual({ width: 1000, height: 500 })
		expect(imageSize(`data:image/png;base64,${pngHeader(64, 32)}`)).toEqual({ width: 64, height: 32 })
	})
	it('reads GIF and JPEG dimensions', () => {
		const gif = Buffer.alloc(24)
		gif.write('GIF89a', 0, 'ascii')
		gif.writeUInt16LE(320, 6)
		gif.writeUInt16LE(200, 8)
		expect(imageSize(gif.toString('base64'))).toEqual({ width: 320, height: 200 })
		const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0, 0, 0])
		expect(imageSize(jpg.toString('base64'))).toEqual({ width: 600, height: 300 })
	})
	it('returns null on junk', () => {
		expect(imageSize('AAAA')).toBeNull()
	})
})

describe('visionTwoPass with a fake model', () => {
	const nodesJson = JSON.stringify(NODES)
	function fake(replies: ((req: StreamRequest) => Message)[]) {
		const reqs: StreamRequest[] = []
		const stream: StreamFn = async (req) => {
			reqs.push(req)
			const next = replies.shift()
			if (!next) throw new Error('unexpected model call')
			return next(req)
		}
		return { stream, reqs }
	}
	const input = { imageBase64: `data:image/png;base64,${pngHeader(1000, 500)}`, mediaType: 'image/png' as const }

	it('runs nodes then edges with strict JSON formats and returns code, pins, confidence', async () => {
		const { stream, reqs } = fake([
			() => msg(nodesJson),
			(req) => {
				const text = JSON.stringify(req.messages[0].content)
				expect(text).toContain('n2: \\"API\\" bbox=[300,400,150,100]')
				return msg(JSON.stringify({ edges: [edge('n1', 'n2', { label: 'HTTPS' }), edge('n2', 'n3')] }))
			},
		])
		const r = await visionTwoPass(stream, input)
		expect(reqs).toHaveLength(2)
		expect(reqs[0].outputFormat).toEqual({ type: 'json_schema', schema: VISION_NODES_SCHEMA })
		expect(reqs[1].outputFormat).toEqual({ type: 'json_schema', schema: VISION_EDGES_SCHEMA })
		// the image is sent again in pass 2
		expect((reqs[1].messages[0].content as { type: string }[])[0].type).toBe('image')
		expect(r.pipeline).toBe('two-pass')
		expect(r.code).toContain('Users > API: HTTPS')
		expect(r.code).toContain('AWS VPC')
		expect(Object.keys(r.pins!)).toHaveLength(3)
		expect(r.confidence).toBeGreaterThan(0.8)
		expect(parseOcto(r.code).ir.edges).toHaveLength(2)
	})

	it('runs a repair pass for unmatched endpoints and keeps the better result', async () => {
		const { stream, reqs } = fake([
			() => msg(nodesJson),
			() => msg(JSON.stringify({ edges: [edge('n1', 'n2'), edge('nope', 'n3')] })),
			(req) => {
				expect(String(req.messages.at(-1)!.content)).toMatch(/nope/)
				expect(req.messages.at(-2)!.role).toBe('assistant')
				return msg(JSON.stringify({ edges: [edge('n1', 'n2'), edge('n2', 'n3')] }))
			},
		])
		const r = await visionTwoPass(stream, input)
		expect(reqs).toHaveLength(3)
		expect(r.warnings).toEqual([])
		expect(parseOcto(r.code).ir.edges).toHaveLength(2)
	})

	it('keeps nodes when pass 2 is refused', async () => {
		const { stream } = fake([() => msg(nodesJson), () => msg('', 'refusal')])
		const r = await visionTwoPass(stream, input)
		expect(r.warnings![0]).toMatch(/declined/)
		expect(parseOcto(r.code).ir.nodes.length).toBe(4)
	})

	it('falls back to single-pass DSL for sequence diagrams', async () => {
		const { stream, reqs } = fake([
			() => msg(JSON.stringify({ ...NODES, kind: 'sequence' })),
			() => msg('sequence\nA > B: hi'),
		])
		const r = await visionImport(stream, input)
		expect(r).toMatchObject({ pipeline: 'single-pass', code: 'sequence\nA > B: hi' })
		expect(reqs[1].outputFormat).toBeUndefined()
	})

	it('falls back on truncated JSON', async () => {
		const { stream } = fake([() => msg('{"nodes": [', 'max_tokens'), () => msg('A > B')])
		const r = await visionImport(stream, input)
		expect(r.pipeline).toBe('single-pass')
		expect(r.warnings![0]).toMatch(/truncated/)
	})

	it('propagates a pass-1 refusal', async () => {
		const { stream } = fake([() => msg('', 'refusal')])
		await expect(visionImport(stream, input)).rejects.toThrow(/declined/)
	})
})
