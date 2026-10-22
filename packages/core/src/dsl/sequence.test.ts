import { describe, expect, it } from 'vitest'
import type { DiagramIR, SeqBlock, SeqMessage } from '../ir'
import { parseOcto } from './parse'
import { printOcto } from './print'
import { setNodeProp } from './patch'

const SRC = `sequence
title Checkout
autoNumber on
Web App [icon: monitor, color: blue] > API [icon: server]: POST /order
activate API
API > DB [icon: database]: insert
DB --> API: ok [color: green]
loop [label: every 5s] {
	API > Queue: poll
}
alt [label: paid] {
	API > Web App: 201
} else [label: declined] {
	API > Web App: 402
	note over Web App, API: show retry
}
par {
	API > Mailer: receipt
}
and {
	API > Audit: log
}
deactivate API
note right of DB: replicated
Web App > Web App: render
`

const strip = (ir: DiagramIR): unknown =>
	JSON.parse(JSON.stringify(ir, (k, v) => (k === 'span' ? undefined : v)))

describe('sequence DSL', () => {
	it('parses participants, messages, blocks and notes', () => {
		const { ir, diagnostics } = parseOcto(SRC)
		expect(diagnostics).toEqual([])
		expect(ir.kind).toBe('sequence')
		expect(ir.title).toBe('Checkout')
		expect(ir.sequence?.autoNumber).toBe(true)
		expect(ir.nodes.map((n) => n.key)).toEqual(['Web App', 'API', 'DB', 'Queue', 'Mailer', 'Audit'])
		expect(ir.nodes[0]).toMatchObject({ icon: 'monitor', style: { color: 'blue' } })
		expect(ir.edges).toEqual([])
		const ev = ir.sequence!.events
		expect(ev[0]).toMatchObject({ kind: 'message', from: 'Web App', to: 'API', label: 'POST /order', dash: 'solid' })
		expect(ev[1]).toMatchObject({ kind: 'activate', target: 'API' })
		expect(ev[3]).toMatchObject({ kind: 'message', dash: 'dotted', color: 'green', label: 'ok' })
		const loop = ev[4] as SeqBlock
		expect(loop).toMatchObject({ kind: 'block', type: 'loop' })
		expect(loop.sections[0].label).toBe('every 5s')
		const alt = ev[5] as SeqBlock
		expect(alt.sections.map((s) => s.label)).toEqual(['paid', 'declined'])
		expect(alt.sections[1].events[1]).toMatchObject({ kind: 'note', placement: 'over', targets: ['Web App', 'API'], text: 'show retry' })
		const par = ev[6] as SeqBlock
		expect(par.sections).toHaveLength(2)
		expect(ev[8]).toMatchObject({ kind: 'note', placement: 'right', targets: ['DB'] })
		expect((ev[9] as SeqMessage).from).toBe((ev[9] as SeqMessage).to)
	})

	it('accepts diagramType and the < operator', () => {
		const { ir, diagnostics } = parseOcto('diagramType sequence\nA < B: back')
		expect(diagnostics).toEqual([])
		expect(ir.kind).toBe('sequence')
		expect(ir.sequence!.events[0]).toMatchObject({ from: 'A', to: 'B', arrow: { start: 'arrow', end: 'none' } })
	})

	it('round-trips through printOcto', () => {
		const a = parseOcto(SRC).ir
		const printed = printOcto(a)
		const b = parseOcto(printed)
		expect(b.diagnostics).toEqual([])
		expect(strip(b.ir)).toEqual(strip(a))
		expect(printOcto(b.ir)).toBe(printed)
	})

	it('quotes participants that look like keywords', () => {
		const { ir } = parseOcto('sequence\n"loop service" > note: hi')
		expect(ir.nodes.map((n) => n.key)).toEqual(['loop service', 'note'])
		const again = parseOcto(printOcto(ir))
		expect(again.diagnostics).toEqual([])
		expect(strip(again.ir)).toEqual(strip(ir))
	})

	it('reports problems without throwing', () => {
		const { ir, diagnostics } = parseOcto('sequence\nA > B > C: x\nloop {\n A > B\n')
		expect(diagnostics.some((d) => /exactly two/.test(d.message))).toBe(true)
		expect(diagnostics.some((d) => /Unclosed/.test(d.message))).toBe(true)
		expect(ir.sequence!.events.length).toBeGreaterThan(0)
		const r = parseOcto('sequence\nelse {\n A > B\n}\nautoNumber maybe')
		expect(r.diagnostics.map((d) => d.severity)).toEqual(['error', 'warning'])
	})

	it('supports setNodeProp on participants', () => {
		const out = setNodeProp('sequence\nA [icon: user] > B: hi\n', 'A', 'color', 'red')
		expect(out).toBe('sequence\nA [icon: user, color: red] > B: hi\n')
		expect(parseOcto(out).ir.nodes[0].style?.color).toBe('red')
	})
})
