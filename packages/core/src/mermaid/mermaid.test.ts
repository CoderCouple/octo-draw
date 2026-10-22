import { describe, expect, it } from 'vitest'
import type { DiagramIR } from '../ir'
import { parseMermaid } from './parse'
import { toMermaid } from './print'

const strip = (ir: DiagramIR) =>
	JSON.parse(
		JSON.stringify(ir, (k, v) => (k === 'span' ? undefined : v)),
	) as DiagramIR

const node = (ir: DiagramIR, key: string) => ir.nodes.find((n) => n.key === key)
const errors = (src: string) => parseMermaid(src).diagnostics.filter((d) => d.severity === 'error')

describe('parseMermaid header and direction', () => {
	it.each([
		['flowchart TD', 'down'],
		['flowchart TB', 'down'],
		['graph BT', 'up'],
		['graph LR', 'right'],
		['flowchart RL', 'left'],
	])('%s → %s', (header, dir) => {
		const { ir, diagnostics } = parseMermaid(`${header}\n  A --> B`)
		expect(ir.direction).toBe(dir)
		expect(diagnostics).toEqual([])
		expect(ir.edges).toHaveLength(1)
	})

	it('defaults to down without direction', () => {
		expect(parseMermaid('flowchart\nA-->B').ir.direction).toBe('down')
	})

	it('warns on a missing header but still parses', () => {
		const { ir, diagnostics } = parseMermaid('A --> B')
		expect(ir.edges).toHaveLength(1)
		expect(diagnostics[0].severity).toBe('warning')
	})

	it('reports unsupported diagram types', () => {
		const { ir, diagnostics } = parseMermaid('classDiagram\n  Animal <|-- Duck')
		expect(ir.nodes).toEqual([])
		expect(diagnostics[0].severity).toBe('error')
		expect(diagnostics[0].message).toMatch(/classDiagram/)
	})

	it('handles a leading ```mermaid fence and keeps offsets', () => {
		const src = '```mermaid\nflowchart LR\n  A --> B\n```\n'
		const { ir, diagnostics } = parseMermaid(src)
		expect(diagnostics).toEqual([])
		expect(ir.direction).toBe('right')
		const a = node(ir, 'A')!
		expect(src.slice(a.span!.from, a.span!.to)).toBe('A')
		expect(a.span!.line).toBe(3)
	})

	it('reads the front-matter title', () => {
		const { ir } = parseMermaid('---\ntitle: My flow\n---\nflowchart TD\nA-->B')
		expect(ir.title).toBe('My flow')
		expect(ir.nodes.map((n) => n.key)).toEqual(['A', 'B'])
	})

	it('accepts semicolons and a statement on the header line', () => {
		const { ir } = parseMermaid('graph TD;A-->B;B-->C;')
		expect(ir.edges.map((e) => `${e.from}${e.to}`)).toEqual(['AB', 'BC'])
	})
})

describe('parseMermaid node shapes', () => {
	it.each([
		['A[rect]', 'rectangle', 'rect'],
		['A(round)', 'oval', 'round'],
		['A([stadium])', 'oval', 'stadium'],
		['A[(db)]', 'cylinder', 'db'],
		['A((circle))', 'ellipse', 'circle'],
		['A(((double)))', 'ellipse', 'double'],
		['A{decide}', 'diamond', 'decide'],
		['A{{hex}}', 'hexagon', 'hex'],
		['A[/in/]', 'parallelogram', 'in'],
		['A[\\out\\]', 'parallelogram', 'out'],
		['A[/trap\\]', 'trapezoid', 'trap'],
		['A[\\inv/]', 'trapezoid', 'inv'],
		['A>flag]', 'rectangle', 'flag'],
		['A[[sub]]', 'rectangle', 'sub'],
	])('%s', (decl, shape, label) => {
		const { ir, diagnostics } = parseMermaid(`flowchart TD\n${decl}`)
		expect(diagnostics).toEqual([])
		expect(ir.nodes).toHaveLength(1)
		expect(ir.nodes[0]).toMatchObject({ key: 'A', shape, label })
	})

	it('parses v11 @{} shapes', () => {
		const { ir, diagnostics } = parseMermaid(
			'flowchart TD\nA@{ shape: cyl, label: "Orders DB" }\nB@{ shape: doc }\nC@{ shape: diam, label: \'Ok?\' }\nD@{ icon: "fa:user", label: "User" }',
		)
		expect(diagnostics).toEqual([])
		expect(node(ir, 'A')).toMatchObject({ shape: 'cylinder', label: 'Orders DB' })
		expect(node(ir, 'B')).toMatchObject({ shape: 'document' })
		expect(node(ir, 'C')).toMatchObject({ shape: 'diamond', label: 'Ok?' })
		expect(node(ir, 'D')).toMatchObject({ icon: 'fa:user', label: 'User' })
	})

	it('parses multi-line @{} blocks', () => {
		const { ir } = parseMermaid('flowchart TD\nA@{\n  shape: hex\n  label: "Prep"\n}\nA --> B')
		expect(node(ir, 'A')).toMatchObject({ shape: 'hexagon', label: 'Prep' })
		expect(ir.edges).toHaveLength(1)
	})

	it('warns on unknown @{} shapes', () => {
		const { ir, diagnostics } = parseMermaid('flowchart TD\nA@{ shape: wobble }')
		expect(node(ir, 'A')!.shape).toBe('rectangle')
		expect(diagnostics[0].severity).toBe('warning')
	})

	it('handles quoted labels with brackets, entities and <br>', () => {
		const { ir } = parseMermaid('flowchart TD\nA["Hello [world] (x)"]\nB["say #quot;hi#quot;"]\nC["line1<br/>line2"]\nD["`**md**`"]')
		expect(node(ir, 'A')!.label).toBe('Hello [world] (x)')
		expect(node(ir, 'B')!.label).toBe('say "hi"')
		expect(node(ir, 'C')!.label).toBe('line1 line2')
		expect(node(ir, 'D')!.label).toBe('**md**')
	})

	it('keeps hyphenated and dotted ids', () => {
		const { ir } = parseMermaid('flowchart LR\nmy-node --> api.v2\nx-y-->z')
		expect(ir.nodes.map((n) => n.key)).toEqual(['my-node', 'api.v2', 'x-y', 'z'])
	})

	it('later declarations update shape and label', () => {
		const { ir } = parseMermaid('flowchart TD\nA --> B\nB{Choice}')
		expect(node(ir, 'B')).toMatchObject({ shape: 'diamond', label: 'Choice' })
		expect(ir.nodes).toHaveLength(2)
	})

	it('reports an unclosed shape without throwing', () => {
		const { ir, diagnostics } = parseMermaid('flowchart TD\nA[oops --> B')
		expect(diagnostics.some((d) => d.severity === 'error')).toBe(true)
		expect(ir.edges).toHaveLength(0)
	})
})

describe('parseMermaid edges', () => {
	const edge = (op: string) => parseMermaid(`flowchart LR\nA ${op} B`)
	it.each([
		['-->', 'none', 'arrow', 'solid'],
		['---', 'none', 'none', 'solid'],
		['-.->', 'none', 'arrow', 'dotted'],
		['-.-', 'none', 'none', 'dotted'],
		['==>', 'none', 'arrow', 'solid'],
		['===', 'none', 'none', 'solid'],
		['<-->', 'arrow', 'arrow', 'solid'],
		['<-.->', 'arrow', 'arrow', 'dotted'],
		['--o', 'none', 'arrow', 'solid'],
		['--x', 'none', 'arrow', 'solid'],
		['o--o', 'arrow', 'arrow', 'solid'],
		['---->', 'none', 'arrow', 'solid'],
	])('%s', (op, start, end, dash) => {
		const { ir, diagnostics } = edge(op)
		expect(diagnostics).toEqual([])
		expect(ir.nodes.map((n) => n.key)).toEqual(['A', 'B'])
		expect(ir.edges[0]).toMatchObject({ from: 'A', to: 'B', arrow: { start, end }, line: { dash } })
	})

	it('works without whitespace', () => {
		const { ir } = parseMermaid('flowchart LR\nA-->B\nC-.->D\nE==>F')
		expect(ir.edges.map((e) => `${e.from}${e.to}`)).toEqual(['AB', 'CD', 'EF'])
	})

	it('parses |label| and text-form labels', () => {
		const { ir, diagnostics } = parseMermaid(
			'flowchart LR\nA -->|yes| B\nA -- no --> C\nA -. maybe .-> D\nA == "big deal" ==> E\nA --- |"q|x"| F\nA-->|"a #quot;b#quot;"|G',
		)
		expect(diagnostics).toEqual([])
		expect(ir.edges.map((e) => e.label)).toEqual(['yes', 'no', 'maybe', 'big deal', 'q|x', 'a "b"'])
		expect(ir.edges[2].line.dash).toBe('dotted')
		expect(ir.edges[3].arrow.end).toBe('arrow')
	})

	it('pipe label containing a quote-free pipe-like char', () => {
		const { ir } = parseMermaid('flowchart LR\nA -->|"x #124; y"| B')
		expect(ir.edges[0].label).toBe('x | y')
	})

	it('expands chains and & fan-out', () => {
		const { ir } = parseMermaid('flowchart TD\nA --> B --> C\nA & B --> D & E')
		expect(ir.edges.map((e) => `${e.from}${e.to}`)).toEqual(['AB', 'BC', 'AD', 'AE', 'BD', 'BE'])
	})

	it('derives edge keys with ordinals and supports edge ids', () => {
		const { ir } = parseMermaid('flowchart TD\nA --> B\nA --> B\nA e1@--> C')
		expect(ir.edges.map((e) => e.key)).toEqual(['A->B#0', 'A->B#1', 'e1'])
	})

	it('chains with shapes and labels mixed', () => {
		const { ir, diagnostics } = parseMermaid('flowchart TD\nStart([Start]) --> Q{Valid?} -->|Yes| Save[(DB)]\nQ -->|No| Err[/Error/]')
		expect(diagnostics).toEqual([])
		expect(ir.nodes.map((n) => [n.key, n.shape])).toEqual([
			['Start', 'oval'],
			['Q', 'diamond'],
			['Save', 'cylinder'],
			['Err', 'parallelogram'],
		])
		expect(ir.edges.map((e) => e.label)).toEqual([undefined, 'Yes', 'No'])
	})

	it('ignores invisible links but keeps their nodes', () => {
		const { ir } = parseMermaid('flowchart TD\nA ~~~ B')
		expect(ir.nodes).toHaveLength(2)
		expect(ir.edges).toHaveLength(0)
	})

	it('reports a dangling edge', () => {
		const errs = errors('flowchart TD\nA -->')
		expect(errs).toHaveLength(1)
		expect(errs[0].message).toMatch(/target/)
	})
})

describe('parseMermaid subgraphs, styles, comments', () => {
	it('parses nested subgraphs with titles', () => {
		const { ir, diagnostics } = parseMermaid(`flowchart TB
  subgraph cloud [AWS Cloud]
    direction LR
    subgraph vpc["VPC"]
      api[API] --> db[(DB)]
    end
    cache
  end
  subgraph "Client Side"
    web
  end
  user --> api
  web --> cloud`)
		expect(diagnostics).toEqual([])
		expect(ir.direction).toBe('down')
		expect(node(ir, 'cloud')).toMatchObject({ isContainer: true, label: 'AWS Cloud' })
		expect(node(ir, 'vpc')).toMatchObject({ isContainer: true, label: 'VPC', parent: 'cloud' })
		expect(node(ir, 'api')!.parent).toBe('vpc')
		expect(node(ir, 'db')!.parent).toBe('vpc')
		expect(node(ir, 'cache')!.parent).toBe('cloud')
		expect(node(ir, 'Client_Side')).toMatchObject({ isContainer: true, label: 'Client Side' })
		expect(node(ir, 'web')!.parent).toBe('Client_Side')
		expect(node(ir, 'user')!.parent).toBeUndefined()
		expect(ir.edges.map((e) => `${e.from}->${e.to}`)).toContain('web->cloud')
	})

	it('pulls a top-level node into the subgraph that later mentions it', () => {
		const { ir } = parseMermaid('flowchart TD\nA\nsubgraph G\nA --> B\nend')
		expect(node(ir, 'A')!.parent).toBe('G')
	})

	it('reports end without subgraph and unclosed subgraph', () => {
		expect(errors('flowchart TD\nend')).toHaveLength(1)
		expect(errors('flowchart TD\nsubgraph X\nA')).toHaveLength(1)
	})

	it('maps classDef/class/:::/style to hex colors', () => {
		const { ir, diagnostics } = parseMermaid(`flowchart TD
  A:::hot --> B
  C
  class B,C cool
  classDef hot fill:#f96,stroke:#333,stroke-width:4px
  classDef cool stroke:rgb(0, 128, 255)
  style C fill:LightGreen,stroke-dasharray: 5 5
  linkStyle 0 stroke:#ff3,stroke-width:4px
  click A callback "Tooltip"`)
		expect(diagnostics).toEqual([])
		expect(node(ir, 'A')!.style).toEqual({ color: '#ff9966' })
		expect(node(ir, 'B')!.style).toEqual({ color: '#0080ff' })
		expect(node(ir, 'C')!.style).toEqual({ color: '#90ee90', dash: 'dashed' })
	})

	it('applies classDef default', () => {
		const { ir } = parseMermaid('flowchart TD\nA-->B\nclassDef default fill:#ABCDEF')
		expect(ir.nodes.every((n) => n.style?.color === '#abcdef')).toBe(true)
	})

	it('skips %% comments and init directives', () => {
		const { ir, diagnostics } = parseMermaid(
			'%%{init: {"theme": "dark"}}%%\nflowchart LR\n%% a comment\nA --> B %% trailing\n  %% indented',
		)
		expect(diagnostics).toEqual([])
		expect(ir.direction).toBe('right')
		expect(ir.nodes.map((n) => n.key)).toEqual(['A', 'B'])
	})

	it('reports garbage lines and continues', () => {
		const { ir, diagnostics } = parseMermaid('flowchart TD\nA --> B\n??? !!!\nB --> C')
		expect(diagnostics.filter((d) => d.severity === 'error')).toHaveLength(1)
		expect(ir.edges).toHaveLength(2)
	})

	it('never throws on random input', () => {
		const junk = ['flowchart TD\n[[[', 'graph\n-->', 'flowchart LR\nA@{', 'flowchart\n"', 'flowchart\nA -- unterminated', '']
		for (const j of junk) expect(() => parseMermaid(j)).not.toThrow()
	})
})

describe('toMermaid', () => {
	it('prints shapes, subgraphs, edges and styles', () => {
		const { ir } = parseMermaid(`flowchart LR
  subgraph g [Group "one"]
    a([Start]) --> b{OK?}
  end
  b -->|yes| c[(Store)]
  b -.- d
  c <--> d
  style c fill:#ff0000`)
		const out = toMermaid(ir)
		expect(out).toContain('flowchart LR')
		expect(out).toContain('subgraph g ["Group #quot;one#quot;"]')
		expect(out).toContain('\t\ta("Start")')
		expect(out).toContain('b{"OK?"}')
		expect(out).toContain('b -->|"yes"| c')
		expect(out).toContain('b -.- d')
		expect(out).toContain('c <--> d')
		expect(out).toContain('style c fill:#ff0000')
	})

	it('sanitises ids from octo-style keys and swaps start-only arrows', () => {
		const out = toMermaid({
			version: 1,
			kind: 'flowchart',
			direction: 'down',
			style: {},
			nodes: [{ key: 'API gateway' }, { key: 'end' }, { key: 'API-gateway', label: 'Other' }, { key: 'Docs', shape: 'document' }],
			edges: [
				{ key: 'e', from: 'API gateway', to: 'end', arrow: { start: 'arrow', end: 'none' }, line: { dash: 'solid' }, style: { color: 'blue' } },
			],
		})
		expect(out).toContain('API_gateway["API gateway"]')
		expect(out).toContain('end_["end"]')
		expect(out).toContain('API-gateway["Other"]')
		expect(out).toContain('Docs@{ shape: doc }')
		expect(out).toContain('end_ --> API_gateway')
		expect(out).toContain('linkStyle 0 stroke:#3b82f6')
		const back = parseMermaid(out)
		expect(back.diagnostics).toEqual([])
		expect(back.ir.nodes.map((n) => n.label)).toEqual(['API gateway', 'end', 'Other', undefined])
	})

	const samples = [
		'flowchart TD\nA --> B --> C\nA & B --> D',
		`flowchart LR
  subgraph outer [Outer]
    subgraph inner [Inner]
      x((X)) -.-> y{{Y}}
    end
    z[/Z/]
  end
  y ==> w[(W)]
  w --- q[/q\\]
  q -->|"label with | pipe"| x
  classDef red fill:#f00
  class z red`,
		'---\ntitle: "Quoted: title"\n---\ngraph RL\n  a@{ shape: tri, label: "T" } <-.-> b@{ shape: cloud }',
		'flowchart BT\n  A["He said #quot;hi#quot;"] -- go --> B\n  style A fill:#123456,stroke-dasharray: 3',
	]
	it.each(samples.map((s, i) => [i, s]))('round-trips sample %i', (_i, src) => {
		const first = parseMermaid(src as string)
		expect(first.diagnostics).toEqual([])
		const printed = toMermaid(first.ir)
		const second = parseMermaid(printed)
		expect(second.diagnostics).toEqual([])
		expect(strip(second.ir)).toEqual(strip(first.ir))
		expect(toMermaid(second.ir)).toBe(printed)
	})
})
