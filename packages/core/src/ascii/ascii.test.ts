import { describe, expect, it } from 'vitest'
import type { DiagramIR } from '../ir'
import { asciiFixtures as F } from '../fixtures/ascii'
import { parseAscii } from './parse'

const keys = (ir: DiagramIR) => ir.nodes.map((n) => n.key)
const edges = (ir: DiagramIR) =>
	ir.edges.map((e) => {
		const op = `${e.arrow.start === 'arrow' ? '<' : ''}${e.line.dash === 'dotted' ? '..' : '--'}${e.arrow.end === 'arrow' ? '>' : ''}`
		return `${e.from} ${op} ${e.to}${e.label ? `: ${e.label}` : ''}`
	})
const node = (ir: DiagramIR, key: string) => ir.nodes.find((n) => n.key === key)

describe('parseAscii fixtures', () => {
	it('stacked unicode boxes with a side label', () => {
		const { ir, confidence, diagnostics } = parseAscii(F.stackedUnicode)
		expect(keys(ir)).toEqual(['Client', 'API Gateway', 'Database'])
		expect(edges(ir)).toEqual(['Client --> API Gateway: HTTPS', 'API Gateway --> Database'])
		expect(ir.direction).toBe('down')
		expect(diagnostics).toEqual([])
		expect(confidence).toBeGreaterThan(0.9)
	})

	it('horizontal ASCII boxes', () => {
		const { ir, confidence } = parseAscii(F.horizontalAscii)
		expect(keys(ir)).toEqual(['Client', 'Server', 'Database'])
		expect(edges(ir)).toEqual(['Client --> Server', 'Server --> Database'])
		expect(ir.direction).toBe('right')
		expect(confidence).toBeGreaterThan(0.9)
	})

	it('fan-out through a bus line', () => {
		const { ir } = parseAscii(F.fanOut)
		expect(edges(ir)).toEqual(['Load Balancer --> Web 1', 'Load Balancer --> Web 2', 'Load Balancer --> Web 3'])
		expect(ir.direction).toBe('down')
	})

	it('container with its title in the top border', () => {
		const { ir } = parseAscii(F.containerTitleBorder)
		expect(node(ir, 'AWS VPC')).toMatchObject({ isContainer: true })
		expect(node(ir, 'API')!.parent).toBe('AWS VPC')
		expect(node(ir, 'Worker')!.parent).toBe('AWS VPC')
		expect(node(ir, 'Users')!.parent).toBeUndefined()
		expect(edges(ir)).toEqual(['API --> Worker', 'Users --> AWS VPC'])
	})

	it('container with its title on the first interior row', () => {
		const { ir, confidence } = parseAscii(F.containerTitleInside)
		expect(keys(ir)).toEqual(['Backend', 'Auth', 'Users DB'])
		expect(node(ir, 'Backend')!.isContainer).toBe(true)
		expect(node(ir, 'Users DB')!.parent).toBe('Backend')
		expect(edges(ir)).toEqual(['Auth --> Users DB'])
		expect(confidence).toBeGreaterThan(0.9)
	})

	it('bracket chain', () => {
		const { ir } = parseAscii(F.bracketChain)
		expect(ir.nodes.map((n) => [n.key, n.shape])).toEqual([
			['User', 'rectangle'],
			['Frontend', 'rectangle'],
			['Backend', 'rectangle'],
			['Postgres', 'cylinder'],
		])
		expect(edges(ir)).toEqual(['User --> Frontend', 'Frontend --> Backend', 'Backend --> Postgres'])
		expect(ir.direction).toBe('right')
	})

	it('inline chains dedupe nodes by label', () => {
		const { ir } = parseAscii(F.inlineChains)
		expect(keys(ir)).toEqual(['Browser', 'CDN', 'Origin', 'Cache'])
		expect(edges(ir)).toEqual(['Browser --> CDN', 'CDN --> Origin', 'Origin --> Cache', 'Cache --> Origin'])
	})

	it('directory tree', () => {
		const { ir, confidence } = parseAscii(F.directoryTree)
		expect(keys(ir)).toEqual(['my-app/', 'src/', 'index.ts', 'components/', 'Button.tsx', 'utils.ts', 'package.json', 'README.md'])
		expect(ir.edges.map((e) => `${e.from}>${e.to}`)).toEqual([
			'my-app/>src/',
			'src/>index.ts',
			'src/>components/',
			'components/>Button.tsx',
			'src/>utils.ts',
			'my-app/>package.json',
			'my-app/>README.md',
		])
		expect(confidence).toBeGreaterThan(0.9)
	})

	it('request/response loop with labels above and inside a corner path', () => {
		const { ir } = parseAscii(F.requestResponse)
		expect(edges(ir)).toEqual(['Client --> Server: request', 'Server --> Client: response'])
	})

	it('label written inside the line', () => {
		expect(edges(parseAscii(F.inlineLabel).ir)).toEqual(['Order --> Ship: paid'])
	})

	it('decision flow with a label left of the line', () => {
		const { ir } = parseAscii(F.decision)
		expect(edges(ir)).toEqual(['Start --> Valid?', 'Valid? --> Save: yes'])
		expect(ir.direction).toBe('down')
	})

	it('vertical text chain without boxes', () => {
		const { ir } = parseAscii(F.verticalTextChain)
		expect(edges(ir)).toEqual(['User --> Load Balancer', 'Load Balancer --> App Server'])
		expect(ir.direction).toBe('down')
	})

	it('tolerates a drifting right border', () => {
		const { ir } = parseAscii(F.misaligned)
		expect(keys(ir)).toEqual(['Service Layer', 'Store'])
		expect(edges(ir)).toEqual(['Service Layer --> Store'])
	})

	it('handles emoji labels', () => {
		const { ir } = parseAscii(F.emoji)
		expect(keys(ir)).toEqual(['🚀 Deploy', '✅ Done'])
		expect(ir.edges).toHaveLength(1)
	})

	it('handles emoji counted as two columns', () => {
		const src = '┌──────────┐\n│ 🚀 Deploy│\n└──────────┘'
		expect(keys(parseAscii(src).ir)).toEqual(['🚀 Deploy'])
	})

	it('bidirectional and dashed ASCII edges', () => {
		const { ir } = parseAscii(F.dashedBidirectional)
		expect(edges(ir)).toEqual(['Cache <--> DB', 'Cache --> Jobs', 'Jobs ..> Logs'])
	})

	it('ASCII + corners fan-out', () => {
		expect(edges(parseAscii(F.asciiCorners).ir)).toEqual(['Queue --> Worker1', 'Queue --> Worker2'])
	})

	it('joins multi-line labels in rounded boxes', () => {
		const { ir } = parseAscii(F.multiLineRounded)
		expect(keys(ir)).toEqual(['Auth Service (JWT issuing)', 'Redis sessions'])
		expect(ir.edges).toHaveLength(1)
	})

	it('uses the first section of a sectioned box', () => {
		const { ir } = parseAscii(F.sectioned)
		expect(keys(ir)).toEqual(['UserService', 'Mailer'])
		expect(edges(ir)).toEqual(['UserService --> Mailer'])
	})

	it('rejects prose', () => {
		const r = parseAscii(F.prose)
		expect(r.ir.nodes).toEqual([])
		expect(r.confidence).toBe(0)
		expect(r.diagnostics[0].severity).toBe('error')
	})
})

describe('parseAscii details', () => {
	it('strips a code fence', () => {
		const { ir } = parseAscii('```\n[A] --> [B]\n```')
		expect(edges(ir)).toEqual(['A --> B'])
	})

	it('ports on box sides and left-pointing heads', () => {
		const { ir } = parseAscii(`
┌──────┐      ┌──────┐
│  A   ├─────►│  B   │
└──────┘      └──┬───┘
                 │
┌──────┐         │
│  C   │◀────────┘
└──────┘`)
		expect(edges(ir)).toEqual(['A --> B', 'B --> C'])
	})

	it('text node feeding a box', () => {
		const { ir } = parseAscii(`
User ──▶ ┌─────────┐ ──▶ ┌────────┐
         │ Website │     │  CDN   │
         └─────────┘     └────────┘`)
		expect(edges(ir)).toEqual(['User --> Website', 'Website --> CDN'])
	})

	it('ASCII boxes with junction ports and labels', () => {
		const { ir } = parseAscii(`
  +-------------+
  |   Browser   |
  +------+------+
         |
         | HTTP GET
         v
  +------+------+          +-----------+
  |  Web Server |--------->|   Redis   |
  +------+------+  cache   +-----------+
         |
         v
  +-------------+
  |  Postgres   |
  +-------------+`)
		expect(edges(ir)).toEqual(['Browser --> Web Server: HTTP GET', 'Web Server --> Redis: cache', 'Web Server --> Postgres'])
	})

	it('bracket decision flow with inline and vertical labels', () => {
		const { ir } = parseAscii(`
[Start]
   |
   v
{Is valid?} --yes--> [Process]
   |
   no
   |
   v
[Reject]`)
		expect(node(ir, 'Is valid?')!.shape).toBe('diamond')
		expect(edges(ir)).toEqual(['Start --> Is valid?', 'Is valid? --> Process: yes', 'Is valid? --> Reject: no'])
	})

	it('unicode arrows between words', () => {
		expect(edges(parseAscii('Client → API → Database').ir)).toEqual(['Client --> API', 'API --> Database'])
		expect(edges(parseAscii('A ← B').ir)).toEqual(['B --> A'])
	})

	it('undirected lines between boxes', () => {
		const { ir } = parseAscii('+---+     +---+\n| A |-----| B |\n+---+     +---+')
		expect(edges(ir)).toEqual(['A -- B'])
	})

	it('dedupes duplicate box labels with a suffix', () => {
		const { ir } = parseAscii('┌────┐   ┌────┐\n│ DB │   │ DB │\n└────┘   └────┘')
		expect(ir.nodes.map((n) => [n.key, n.label])).toEqual([
			['DB', undefined],
			['DB 2', 'DB'],
		])
		expect(ir.direction).toBe('right')
	})

	it('empty boxes get generated keys', () => {
		expect(keys(parseAscii('┌──┐\n│  │\n└──┘').ir)).toEqual(['Box 1'])
	})

	it('nested containers', () => {
		const { ir } = parseAscii(`
┌─ Cloud ──────────────────┐
│ ┌─ VPC ──────────────┐   │
│ │  ┌─────┐  ┌─────┐  │   │
│ │  │ API │─▶│ DB  │  │   │
│ │  └─────┘  └─────┘  │   │
│ └────────────────────┘   │
└──────────────────────────┘`)
		expect(node(ir, 'Cloud')!.isContainer).toBe(true)
		expect(node(ir, 'VPC')).toMatchObject({ isContainer: true, parent: 'Cloud' })
		expect(node(ir, 'API')!.parent).toBe('VPC')
		expect(edges(ir)).toEqual(['API --> DB'])
	})

	it('lines crossing a container border', () => {
		const { ir } = parseAscii(`
            ┌──── Cluster ─────┐
┌────────┐  │   ┌─────────┐    │
│ Client │──────▶│ Ingress │    │
└────────┘  │   └─────────┘    │
            └──────────────────┘`)
		expect(edges(ir)).toEqual(['Client --> Ingress'])
		expect(node(ir, 'Ingress')!.parent).toBe('Cluster')
	})

	it('warns about dangling lines and lowers confidence', () => {
		const good = parseAscii(F.horizontalAscii)
		const r = parseAscii('┌───┐\n│ A │──────▶\n└───┘')
		expect(r.diagnostics.some((d) => d.severity === 'warning')).toBe(true)
		expect(r.confidence).toBeLessThan(good.confidence)
	})

	it('low confidence on prose with an arrow', () => {
		const r = parseAscii('I think A -> B is right, and that is all I have to say about it.')
		expect(r.confidence).toBeLessThan(0.5)
	})

	it('does not treat markdown tables as diagrams', () => {
		const r = parseAscii('| Name | Age |\n|------|-----|\n| Bob  | 3   |')
		expect(r.ir.edges).toEqual([])
	})

	it('never throws on junk', () => {
		const junk = ['', '   ', '┌', '│││\n───', '+-+-+\n|+|+|\n+-+-+', '>>>> <<<<', 'v\nv\nv', '└──┘┌──┐', '\t\t+--\n|']
		for (const j of junk) expect(() => parseAscii(j)).not.toThrow()
	})
})
