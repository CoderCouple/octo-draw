import { describe, expect, it } from 'vitest'
import type { DiagramIR, SeqBlock } from '../ir'
import { parseOcto } from '../dsl/parse'
import { parseMermaid } from './parse'
import { toMermaid } from './print'

const strip = (ir: DiagramIR): unknown => JSON.parse(JSON.stringify(ir, (k, v) => (k === 'span' ? undefined : v)))

const SEQ = `sequenceDiagram
	autonumber
	actor U as User
	participant W as Web App
	participant DB
	U->>+W: open page
	W->>DB: query
	DB-->>W: rows
	W-->>-U: html
	loop Every minute
		W-)DB: heartbeat
	end
	alt is cached
		W->W: hit
	else miss
		W-xDB: fetch
	end
	par to mail
		W--)U: email
	and to sms
		W--)U: sms
	end
	critical lock
		DB->>DB: lock
	option timeout
		DB-->DB: abort
	end
	Note over W,DB: shared
	Note left of U: thinking
	rect rgb(200, 200, 255)
		U->>W: click
	end
`

const ERD = `erDiagram
	CUSTOMER ||--o{ ORDER : places
	ORDER ||--|{ LINE-ITEM : contains
	CUSTOMER }|..|{ DELIVERY-ADDRESS : uses
	CUSTOMER {
		string name PK
		string email UK "login"
	}
	ORDER {
		int id PK
		string customerId FK
	}
	PRODUCT ||--|| SKU : has
`

describe('mermaid sequenceDiagram', () => {
	it('parses participants, arrows, activations, blocks and notes', () => {
		const { ir, diagnostics } = parseMermaid(SEQ)
		expect(diagnostics).toEqual([])
		expect(ir.kind).toBe('sequence')
		expect(ir.sequence!.autoNumber).toBe(true)
		expect(ir.nodes.map((n) => [n.key, n.label, n.icon])).toEqual([
			['U', 'User', 'user'],
			['W', 'Web App', undefined],
			['DB', undefined, undefined],
		])
		const ev = ir.sequence!.events
		expect(ev[0]).toMatchObject({ kind: 'message', from: 'U', to: 'W', label: 'open page', dash: 'solid', arrow: { end: 'arrow' } })
		expect(ev[1]).toMatchObject({ kind: 'activate', target: 'W' })
		expect(ev[3]).toMatchObject({ dash: 'dotted' })
		expect(ev[5]).toMatchObject({ kind: 'deactivate', target: 'W' })
		expect((ev[6] as SeqBlock).sections[0]).toMatchObject({ label: 'Every minute' })
		expect((ev[7] as SeqBlock).sections.map((s) => s.label)).toEqual(['is cached', 'miss'])
		expect((ev[7] as SeqBlock).sections[0].events[0]).toMatchObject({ from: 'W', to: 'W', arrow: { end: 'none' } })
		expect((ev[8] as SeqBlock).type).toBe('par')
		expect((ev[9] as SeqBlock).type).toBe('critical')
		expect(ev[10]).toMatchObject({ kind: 'note', placement: 'over', targets: ['W', 'DB'], text: 'shared' })
		expect(ev[11]).toMatchObject({ kind: 'note', placement: 'left', targets: ['U'] })
		// rect contents stay inline
		expect(ev[12]).toMatchObject({ kind: 'message', label: 'click' })
	})

	it('round-trips through toMermaid', () => {
		const a = parseMermaid(SEQ).ir
		const b = parseMermaid(toMermaid(a))
		expect(b.diagnostics).toEqual([])
		expect(strip(b.ir)).toEqual(strip(a))
	})

	it('exports octo sequences with spaces in names', () => {
		const ir = parseOcto('sequence\nWeb App > "API #1": GET; now\nnote over Web App: hi').ir
		const out = toMermaid(ir)
		expect(out).toContain('participant Web_App as Web App')
		expect(out).toContain('Web_App->>API_1: GET#59; now')
		const back = parseMermaid(out).ir
		expect(back.nodes.map((n) => n.label)).toEqual(['Web App', 'API #1'])
		expect(back.sequence!.events[0]).toMatchObject({ label: 'GET; now' })
	})
})

describe('mermaid erDiagram', () => {
	it('parses entities, attributes and cardinalities', () => {
		const { ir, diagnostics } = parseMermaid(ERD)
		expect(diagnostics).toEqual([])
		expect(ir.kind).toBe('erd')
		expect(ir.edges.map((e) => [e.from, e.to, e.cardinality, e.label, e.line.dash])).toEqual([
			['CUSTOMER', 'ORDER', '1-n', 'places', 'solid'],
			['ORDER', 'LINE-ITEM', '1-n', 'contains', 'solid'],
			['CUSTOMER', 'DELIVERY-ADDRESS', 'n-n', 'uses', 'dotted'],
			['PRODUCT', 'SKU', '1-1', 'has', 'solid'],
		])
		expect(ir.nodes.find((n) => n.key === 'CUSTOMER')!.fields).toEqual([
			{ name: 'name', type: 'string', meta: ['pk'] },
			{ name: 'email', type: 'string', meta: ['uk'] },
		])
	})

	it('round-trips through toMermaid', () => {
		const a = parseMermaid(ERD).ir
		const b = parseMermaid(toMermaid(a))
		expect(b.diagnostics).toEqual([])
		expect(strip(b.ir)).toEqual(strip(a))
	})

	it('exports octo ERDs', () => {
		const ir = parseOcto('erd\nusers {\n id string pk\n teamId string fk\n}\nusers.teamId > teams.id: member').ir
		const out = toMermaid(ir)
		expect(out).toContain('users }o--|| teams : "member"')
		expect(out).toContain('string teamId FK')
		const back = parseMermaid(out).ir
		expect(back.edges[0]).toMatchObject({ from: 'users', to: 'teams', cardinality: 'n-1' })
	})
})
