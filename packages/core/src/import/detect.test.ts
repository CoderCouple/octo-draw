import { describe, expect, it } from 'vitest'
import { asciiFixtures, mermaidFixtures, octoFixtures } from '../fixtures/ascii'
import { detectFormat, importText, looksMermaid, unfence } from './detect'

describe('unfence', () => {
	it('returns text unchanged without fences', () => {
		expect(unfence('A > B')).toEqual({ body: 'A > B' })
	})
	it('strips a fence and remembers the language', () => {
		expect(unfence('```mermaid\ngraph TD\nA-->B\n```')).toEqual({ lang: 'mermaid', body: 'graph TD\nA-->B' })
	})
	it('picks the diagram block out of a chat answer', () => {
		const chat = 'Here is code:\n```python\nprint(1)\n```\nAnd the diagram:\n```mermaid\nflowchart LR\nA-->B\n```\nHope it helps.'
		expect(unfence(chat)).toEqual({ lang: 'mermaid', body: 'flowchart LR\nA-->B' })
	})
	it('handles an unclosed fence', () => {
		expect(unfence('```\n[A] --> [B]')).toEqual({ lang: '', body: '[A] --> [B]' })
	})
})

describe('looksMermaid', () => {
	it.each([
		['flowchart TD\nA-->B', true],
		['graph LR;A-->B', true],
		['flowchart\nA-->B', true],
		['%% comment\n\ngraph TD\nA-->B', true],
		['---\ntitle: x\n---\nflowchart LR\nA-->B', true],
		['sequenceDiagram\nA->>B: hi', true],
		['timeline\n  title History', true],
		['pie title Pets\n"Dogs": 3', true],
		['timeline of the project is tight', false],
		['graph theory is fun', false],
		['The flowchart TD shows things', false],
		['A --> B', false],
	])('%j → %s', (src, expected) => {
		expect(looksMermaid(src)).toBe(expected)
	})
})

describe('detectFormat', () => {
	it.each(Object.entries(mermaidFixtures))('mermaid fixture %s', (_name, src) => {
		expect(detectFormat(src)).toBe('mermaid')
	})

	it.each(Object.entries(octoFixtures))('octo fixture %s', (_name, src) => {
		expect(detectFormat(src)).toBe('octo')
	})

	const asciiNames = Object.keys(asciiFixtures).filter((k) => k !== 'prose') as (keyof typeof asciiFixtures)[]
	it.each(asciiNames)('ascii fixture %s', (name) => {
		expect(detectFormat(asciiFixtures[name])).toBe('ascii')
	})

	it.each([
		asciiFixtures.prose,
		'Just a normal sentence.',
		'Revenue grew 10% - which is great - and costs fell.',
		'I think A -> B is right, and that is all I have to say about it.',
		'| Name | Age |\n|------|-----|\n| Bob  | 3   |',
		'timeline of the launch:\n- week 1: design\n- week 2: build',
		'',
		'   \n  ',
	])('plain: %j', (src) => {
		expect(detectFormat(src)).toBe('plain')
	})

	it('uses the fence language as a strong hint', () => {
		expect(detectFormat('```mermaid\nA --> B\n```')).toBe('mermaid')
		expect(detectFormat('```octo\nA > B\n```')).toBe('octo')
		expect(detectFormat('```\n┌───┐\n│ A │\n└───┘\n```')).toBe('ascii')
	})

	it('octo arrows with names containing spaces', () => {
		expect(detectFormat('API gateway > Worker, "Pub/Sub"\nWorker > DB > Backups')).toBe('octo')
		expect(detectFormat('A --> B')).toBe('octo')
	})

	it('ascii arrow chains that octo does not accept', () => {
		expect(detectFormat('Client -> Server -> DB')).toBe('ascii')
		expect(detectFormat('Client → Server → DB')).toBe('ascii')
	})
})

describe('importText', () => {
	it('imports fenced mermaid', () => {
		const r = importText(mermaidFixtures.fenced)!
		expect(r.format).toBe('mermaid')
		expect(r.diagnostics).toEqual([])
		expect(r.ir.direction).toBe('right')
		expect(r.ir.edges.map((e) => e.label)).toEqual(['HTTPS', undefined])
	})

	it('imports mermaid sequence diagrams', () => {
		const r = importText(mermaidFixtures.sequence)!
		expect(r.format).toBe('mermaid')
		expect(r.diagnostics).toEqual([])
		expect(r.ir.kind).toBe('sequence')
		expect(r.ir.nodes.map((n) => n.key)).toEqual(['Alice', 'Bob'])
		expect(r.ir.sequence?.events).toHaveLength(2)
	})

	it('imports mermaid ER diagrams', () => {
		const r = importText('```mermaid\nerDiagram\n  CUSTOMER ||--o{ ORDER : places\n```')!
		expect(r.format).toBe('mermaid')
		expect(r.ir.kind).toBe('erd')
		expect(r.ir.edges[0]).toMatchObject({ from: 'CUSTOMER', to: 'ORDER', cardinality: '1-n', label: 'places' })
	})

	it('detects octo sequence and erd sources', () => {
		expect(detectFormat('sequence\nWeb App > DB: query\nDB --> Web App: rows')).toBe('octo')
		expect(detectFormat('erd\nusers {\n  id string pk\n  teamId string\n}\nusers.teamId > teams.id')).toBe('octo')
	})

	it('reports unsupported mermaid diagram types', () => {
		const r = importText('classDiagram\n  Animal <|-- Duck')!
		expect(r.format).toBe('mermaid')
		expect(r.ir.nodes).toEqual([])
		expect(r.diagnostics[0]).toMatchObject({ severity: 'error' })
		expect(r.diagnostics[0].message).toMatch(/classDiagram/)
	})

	it('imports octo DSL through parseOcto', () => {
		const r = importText(octoFixtures.basic)!
		expect(r.format).toBe('octo')
		expect(r.ir.direction).toBe('right')
		expect(r.ir.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['Users', 'API', 'DB']))
	})

	it('imports ASCII with confidence', () => {
		const r = importText('```text\n' + asciiFixtures.stackedUnicode + '```')!
		expect(r.format).toBe('ascii')
		expect(r.ir.nodes.map((n) => n.key)).toEqual(['Client', 'API Gateway', 'Database'])
		expect(r.confidence).toBeGreaterThan(0.9)
	})

	it('returns null for plain text', () => {
		expect(importText(asciiFixtures.prose)).toBeNull()
		expect(importText('hello')).toBeNull()
	})
})
