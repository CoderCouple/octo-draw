import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutDiagram, parseOcto, parseOctoPages, type DiagramIR } from '@octo-draw/core'
import { EXAMPLES } from '../../../apps/web/src/examples'
import { escapeMarkdown, irToMdp, layoutFromMdp, mdpToIr, unescapeMarkdown, withRoutes, type MdpDoc, type MdpElement } from './mdp'
import { routeEdges } from './route'
import { octoResolver, resolveMdp, validateMdp } from './validate'
import { fromOctoDocument, octoDocumentToDsl, toOctoDocument } from './document'

/** IR minus what a round trip legitimately changes (spans, layout geometry). */
function comparable(ir: DiagramIR) {
	return {
		...ir,
		nodes: ir.nodes.map(({ span: _s, geometry: _g, ...n }) => n),
		edges: ir.edges.map(({ span: _s, ...e }) => e),
		sequence: ir.sequence ? JSON.parse(JSON.stringify(ir.sequence, (k, v) => (k === 'span' ? undefined : v))) : undefined,
	}
}

const allPages = () => EXAMPLES.flatMap((ex) => parseOctoPages(ex.code).pages.map((p) => ({ name: `${ex.id}/${p.name}`, ir: p.ir })))

describe('irToMdp', () => {
	it('maps nodes, icons, groups and edges', async () => {
		const ir = parseOcto(`direction right
Users [icon: users]
Box [shape: diamond, color: red]
VPC [color: blue] {
  API [icon: server, shape: rectangle]
  Fn [icon: aws-lambda]
}
Users > API: HTTPS
API <> Fn
Box -- API
Box --> Users`).ir
		const doc = irToMdp(ir, await layoutDiagram(ir))
		const by = Object.fromEntries(doc.entities.map((e) => [e.id, e]))
		expect(by.Users.tag).toBe('Icon')
		expect(by.Users.icon).toBe('users')
		expect(by.Box).toMatchObject({ tag: 'Shape', shape: 'diamond', color: 'red' })
		expect(by.VPC).toMatchObject({ tag: 'Group', title: { text: 'VPC' }, color: 'blue' })
		expect(by.API).toMatchObject({ tag: 'Shape', icon: 'server', containerId: 'VPC' })
		expect(by.Fn).toMatchObject({ tag: 'Icon', containerId: 'VPC' })
		for (const e of doc.entities) {
			expect(e.x).toBeGreaterThanOrEqual(0)
			expect(e.width).toBeGreaterThan(0)
		}
		// group listed before members
		expect(doc.entities.findIndex((e) => e.id === 'VPC')).toBeLessThan(doc.entities.findIndex((e) => e.id === 'API'))
		const c = Object.fromEntries(doc.connections.map((e) => [e.id, e]))
		expect(c['Users->API#0']).toMatchObject({ tag: 'Relationship', from: 'Users', to: 'API', label: 'HTTPS' })
		expect(c['API->Fn#0']).toMatchObject({ startArrowhead: 'triangle' })
		expect(c['Box->API#0']).toMatchObject({ lineStyle: 'dotted', endArrowhead: null })
		expect(c['Box->Users#0']).toMatchObject({ lineStyle: 'dotted' })
		expect(c['Box->Users#0'].endArrowhead).toBeUndefined()
	})

	it('validates every example page against the stock profile', async () => {
		for (const { name, ir } of allPages()) {
			const doc = irToMdp(ir, await layoutDiagram(ir))
			const res = await validateMdp(doc)
			expect(res.errors, name).toEqual([])
			expect(res.warnings, name).toEqual([])
		}
	})

	it('resolves icons through the octo catalog (no network)', async () => {
		const ir = parseOcto('A [icon: react, color: brand]\nB [icon: postgres]\nC [icon: no-such-icon-xyz]\nA > B > C').ir
		const res = await resolveMdp(irToMdp(ir, await layoutDiagram(ir)))
		expect(res.ok).toBe(true)
		expect(Object.keys(res.icons ?? {}).sort()).toEqual(['no-such-icon-xyz', 'postgres', 'react~brand'])
		expect(res.icons!['react~brand']).toMatch(/fill="#61DAFB"/i)
		expect(res.icons!.postgres).toContain('<path')
		expect(res.warnings.map((w) => w.code)).toEqual(['W_UNKNOWN_ICON'])
	})

	it('reports schema errors with JSON pointers', async () => {
		const bad: MdpDoc = { entities: [{ tag: 'Shape', id: 'a', x: -5, y: 0, foo: 1 }], connections: [{ tag: 'Relationship', id: 'r', from: 'a', to: 'nope' }] }
		const res = await validateMdp(bad)
		expect(res.ok).toBe(false)
		const codes = [...res.errors, ...res.warnings].map((i) => `${i.code} ${i.path}`)
		expect(codes.join('\n')).toMatch(/\/entities\/0/)
		expect(codes.join('\n')).toMatch(/E_MISSING_REF/)
	})

	it('a top-level octo key is only a warning; per-element extras are rejected or flagged', async () => {
		const r = await octoResolver()
		const top = await r.validate({ entities: [{ tag: 'Shape', id: 'a', x: 0, y: 0 }], connections: [], octo: { version: 1 } })
		expect(top.ok).toBe(true)
		expect(top.warnings.map((w) => w.code)).toEqual(['W_UNKNOWN_KEY'])
		const el = await r.validate({ entities: [{ tag: 'Shape', id: 'a', x: 0, y: 0, drill: 'Payments' }], connections: [] })
		expect([...el.errors, ...el.warnings].map((w) => w.code)).toContain('W_UNKNOWN_PROP')
	})
})

describe('round trip', () => {
	it('IR -> MDP -> IR keeps every example page (minus spans and geometry)', async () => {
		for (const { name, ir } of allPages()) {
			const doc = irToMdp(ir, await layoutDiagram(ir))
			const back = mdpToIr(JSON.parse(JSON.stringify(doc)))
			expect(comparable(back), name).toEqual(comparable(ir))
			for (const n of back.nodes) if (ir.kind !== 'sequence') expect(n.geometry, `${name} ${n.key}`).toBeDefined()
		}
	})

	it('keeps octo-only props in the sidecar: drill, link, ext, cloud shape, brand and non-stock colors', async () => {
		const ir = parseOcto(`A [drill: Payments, link: "https://x.dev", shape: cloud, color: lightblue, owner: team-a]
B [icon: react, color: brand]
A > B: [color: gray]`).ir
		const doc = irToMdp(ir, await layoutDiagram(ir))
		expect(doc.octo?.elements?.A).toMatchObject({ link: 'https://x.dev', shape: 'cloud', color: 'lightblue', ext: { drill: 'Payments', owner: 'team-a' } })
		expect(doc.entities.find((e) => e.id === 'A')).not.toHaveProperty('shape')
		expect(comparable(mdpToIr(doc))).toEqual(comparable(ir))
	})

	it('pre-routes on the doc’s own geometry and stores route-local points', async () => {
		const ir = parseOcto('direction right\nA [icon: server]\nB [shape: diamond]\nA > B: go').ir
		const doc = irToMdp(ir, await layoutDiagram(ir))
		const routed = routeEdges(layoutFromMdp(doc), ir, { repair: false })
		const out = withRoutes(doc, routed.edges)
		const c = out.connections[0] as MdpElement & { x: number; y: number; points: { x: number; y: number }[] }
		expect(c.points[0]).toEqual({ x: 0, y: 0 })
		expect(c.points.length).toBeGreaterThanOrEqual(2)
		expect((await validateMdp(out)).errors).toEqual([])
	})

	it('escapes markdown in labels', () => {
		for (const s of ['a*b*', '# not a heading', '1. item', '[x](y)', 'snake_case', 'back\\slash', 'a - b', '<b>']) {
			expect(unescapeMarkdown(escapeMarkdown(s))).toBe(s)
		}
	})

	it('multi-page envelope round-trips through the DSL', async () => {
		const drill = EXAMPLES.find((e) => e.id === 'drill')!.code
		const doc = await toOctoDocument(drill)
		expect(doc.pages.map((p) => p.name)).toEqual(['', 'Checkout flow', 'Payments', 'Fulfillment'])
		expect(doc.pages[0].mdp.octo?.elements?.Checkout?.ext?.drill).toBe('Checkout flow')
		const pages = fromOctoDocument(JSON.parse(JSON.stringify(doc)))
		const dsl = octoDocumentToDsl(doc)
		const again = parseOctoPages(dsl).pages
		expect(again.map((p) => p.name)).toEqual(pages.map((p) => p.name))
		for (let i = 0; i < pages.length; i++) {
			const strip = (ir: DiagramIR) => comparable({ ...ir, nodes: ir.nodes.map(({ geometry: _g, ...n }) => n) })
			expect(strip(again[i].ir), pages[i].name).toEqual(strip(pages[i].ir))
		}
	})
})

describe('eraser corpus', () => {
	const fixtures = ['canopy-ai-chatbot-architecture', 'erd-order-system', 'garden-plant-lookup-pipeline', 'node-branching-structure-with-five-subdivisions', 'bpmn-order-fulfillment']
	const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/eraser/${name}.json`, import.meta.url), 'utf8'))

	for (const name of fixtures) {
		it(`${name}: mdpToIr -> irToMdp stays valid and keeps structure`, async () => {
			const src = load(name)
			const elements = src.elements ?? [...src.entities, ...src.connections]
			const ir = mdpToIr(src)
			const ents = elements.filter((e: { from?: string }) => !e.from)
			const conns = elements.filter((e: { from?: string }) => e.from)
			expect(ir.nodes.length).toBe(ents.length)
			expect(ir.edges.length).toBe(conns.length)
			// layout from the fixture's own geometry
			const layout = {
				nodes: Object.fromEntries(ir.nodes.map((n) => [n.key, { key: n.key, x: n.geometry?.x ?? 0, y: n.geometry?.y ?? 0, w: n.geometry?.w ?? 120, h: n.geometry?.h ?? 60, isContainer: !!n.isContainer, depth: 0 }])),
				edges: {},
				bounds: { x: 0, y: 0, w: 0, h: 0 },
			}
			const back = irToMdp(ir, layout)
			const res = await validateMdp(back)
			expect(res.errors, JSON.stringify(res.errors.slice(0, 3))).toEqual([])
			// containment and endpoints survive
			const containers = (d: { id: string; containerId?: unknown }[]) => d.map((e) => `${e.id}<${e.containerId ?? ''}`).sort()
			expect(containers(back.entities)).toEqual(containers(ents))
			const ends = (d: Record<string, unknown>[]) => d.map((e) => `${e.from}>${e.to}`).sort()
			expect(ends(back.connections)).toEqual(ends(conns))
		})
	}
})
