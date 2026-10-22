import { describe, expect, it } from 'vitest'
import { parseOcto } from './parse'

const CONTRACT_EXAMPLE = `// comments with // or #
title My system
direction right            // down | up | right | left
colorMode pastel           // pastel | bold | outline
styleMode shadow           // shadow | plain | watercolor
typeface clean             // rough | clean | mono

Users [icon: users, shape: oval]
Backend [color: blue] {
  API gateway [icon: server]
  Worker [icon: cpu]
  "Pub/Sub" [icon: radio]
}
DB [shape: cylinder, icon: database, label: "Postgres 16"]

Users > API gateway: HTTPS
API gateway > Worker, "Pub/Sub"      // branching
Worker > DB > Backups                // chaining, implicit node "Backups"
Worker <> Cache: [color: red]
Worker -- Logs
API gateway --> Audit: async [id: audit-edge]
`

const node = (src: string, key: string) => parseOcto(src).ir.nodes.find((n) => n.key === key)

describe('parseOcto — contract example', () => {
	const { ir, diagnostics } = parseOcto(CONTRACT_EXAMPLE)

	it('has no diagnostics', () => {
		expect(diagnostics).toEqual([])
	})

	it('reads directives', () => {
		expect(ir.title).toBe('My system')
		expect(ir.direction).toBe('right')
		expect(ir.style).toEqual({ colorMode: 'pastel', styleMode: 'shadow', typeface: 'clean' })
		expect(ir.kind).toBe('flowchart')
	})

	it('reads nodes, groups and props', () => {
		expect(ir.nodes.map((n) => n.key)).toEqual([
			'Users',
			'Backend',
			'API gateway',
			'Worker',
			'Pub/Sub',
			'DB',
			'Backups',
			'Cache',
			'Logs',
			'Audit',
		])
		const users = ir.nodes[0]
		expect(users.icon).toBe('users')
		expect(users.shape).toBe('oval')
		const backend = ir.nodes[1]
		expect(backend.isContainer).toBe(true)
		expect(backend.style).toEqual({ color: 'blue' })
		expect(ir.nodes.filter((n) => n.parent === 'Backend').map((n) => n.key)).toEqual(['API gateway', 'Worker', 'Pub/Sub'])
		const db = ir.nodes.find((n) => n.key === 'DB')!
		expect(db).toMatchObject({ shape: 'cylinder', icon: 'database', label: 'Postgres 16' })
		expect(ir.nodes.find((n) => n.key === 'Backups')!.span).toBeUndefined()
	})

	it('reads edges with ops, chains, branches, labels and props', () => {
		const e = ir.edges
		expect(e.map((x) => x.key)).toEqual([
			'Users->API gateway#0',
			'API gateway->Worker#0',
			'API gateway->Pub/Sub#0',
			'Worker->DB#0',
			'DB->Backups#0',
			'Worker->Cache#0',
			'Worker->Logs#0',
			'audit-edge',
		])
		expect(e[0]).toMatchObject({ label: 'HTTPS', arrow: { start: 'none', end: 'arrow' }, line: { dash: 'solid' } })
		expect(e[5]).toMatchObject({ arrow: { start: 'arrow', end: 'arrow' }, style: { color: 'red' } })
		expect(e[5].label).toBeUndefined()
		expect(e[6]).toMatchObject({ arrow: { start: 'none', end: 'none' }, line: { dash: 'dotted' } })
		expect(e[7]).toMatchObject({ from: 'API gateway', to: 'Audit', label: 'async', line: { dash: 'dotted' }, arrow: { end: 'arrow' } })
	})

	it('records spans', () => {
		const db = ir.nodes.find((n) => n.key === 'DB')!
		expect(CONTRACT_EXAMPLE.slice(db.span!.from, db.span!.to)).toBe('DB [shape: cylinder, icon: database, label: "Postgres 16"]')
		expect(db.span!.line).toBe(14)
		const e = ir.edges[3]
		expect(CONTRACT_EXAMPLE.slice(e.span!.from, e.span!.to)).toBe('Worker > DB > Backups')
		expect(e.span!.line).toBe(18)
	})
})

describe('parseOcto — operators', () => {
	it.each([
		['>', 'none', 'arrow', 'solid'],
		['<', 'arrow', 'none', 'solid'],
		['<>', 'arrow', 'arrow', 'solid'],
		['-', 'none', 'none', 'solid'],
		['--', 'none', 'none', 'dotted'],
		['-->', 'none', 'arrow', 'dotted'],
	])('%s', (op, start, end, dash) => {
		const { ir, diagnostics } = parseOcto(`A ${op} B`)
		expect(diagnostics).toEqual([])
		expect(ir.edges).toHaveLength(1)
		expect(ir.edges[0]).toMatchObject({ from: 'A', to: 'B', arrow: { start, end }, line: { dash } })
	})

	it('requires whitespace around operators', () => {
		const { ir } = parseOcto('main-vpc > sub-net\nA>B\nx-->y')
		expect(ir.nodes.map((n) => n.key)).toEqual(['main-vpc', 'sub-net', 'A>B', 'x-->y'])
		expect(ir.edges).toHaveLength(1)
	})

	it('counts ordinals per pair', () => {
		const { ir } = parseOcto('A > B\nA > B\nB > A\nA > B [id: x]\nA > B')
		expect(ir.edges.map((e) => e.key)).toEqual(['A->B#0', 'A->B#1', 'B->A#0', 'x', 'A->B#2'])
	})

	it('branching on both sides and chaining with lists', () => {
		const { ir } = parseOcto('A, B > C, D > E')
		expect(ir.edges.map((e) => `${e.from}${e.to}`)).toEqual(['AC', 'AD', 'BC', 'BD', 'CE', 'DE'])
	})

	it('trailing props without label are edge props', () => {
		const { ir, diagnostics } = parseOcto('A > B [color: green, dash: dashed]')
		expect(diagnostics).toEqual([])
		expect(ir.edges[0].style).toEqual({ color: 'green', dash: 'dashed' })
		expect(node('A > B [color: green]', 'B')!.style).toBeUndefined()
	})

	it('node props inside a connection apply to the node', () => {
		const { ir } = parseOcto('A [icon: x] > B')
		expect(ir.nodes[0].icon).toBe('x')
		expect(ir.nodes[0].span).toBeDefined()
	})

	it('labels can contain colons, commas and operators', () => {
		const { ir } = parseOcto('A > B: a: b, c > d')
		expect(ir.edges[0].label).toBe('a: b, c > d')
		expect(parseOcto('A > B: "x [y]" [color: red]').ir.edges[0]).toMatchObject({ label: 'x [y]', style: { color: 'red' } })
	})

	it('id on a multi-edge statement gets suffixes', () => {
		const { ir } = parseOcto('A > B, C [id: e]')
		expect(ir.edges.map((e) => e.key)).toEqual(['e', 'e#1'])
	})

	it('warns on unknown connection props and duplicate ids', () => {
		const { diagnostics } = parseOcto('A > B [weight: 3]\nC > D [id: x]\nE > F [id: x]')
		expect(diagnostics.map((d) => d.message)).toEqual(['Unknown connection property "weight"', 'Duplicate connection id "x"'])
	})
})

describe('parseOcto — names, props, comments', () => {
	it('names may contain spaces and normalize whitespace', () => {
		expect(parseOcto('API   gateway > Data  store').ir.nodes.map((n) => n.key)).toEqual(['API gateway', 'Data store'])
	})

	it('quoted names keep special characters', () => {
		const { ir } = parseOcto('"a, b: [c]" > "x > y"\n"say \\"hi\\""')
		expect(ir.nodes.map((n) => n.key)).toEqual(['a, b: [c]', 'x > y', 'say "hi"'])
	})

	it('props: flags, unknown → ext, link with colon, hex color', () => {
		const n = node('A [pin, tier: gold, link: https://x.com/a, color: #ff0000]', 'A')!
		expect(n.ext).toEqual({ pin: 'true', tier: 'gold' })
		expect(n.link).toBe('https://x.com/a')
		expect(n.style).toEqual({ color: '#ff0000' })
	})

	it('unknown shape is a warning and survives in ext', () => {
		const { ir, diagnostics } = parseOcto('A [shape: blob]')
		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe('warning')
		expect(diagnostics[0].message).toMatch(/Unknown shape "blob"/)
		expect(ir.nodes[0].shape).toBeUndefined()
		expect(ir.nodes[0].ext).toEqual({ shape: 'blob' })
	})

	it('comments: // and #, but not inside words or hex colors', () => {
		const { ir } = parseOcto('# heading\nA > B # trailing\nC [color: #abc] // x\na//b > y')
		expect(ir.nodes.map((n) => n.key)).toEqual(['A', 'B', 'C', 'a//b', 'y'])
		expect(ir.nodes[2].style!.color).toBe('#abc')
	})

	it('later declarations merge props', () => {
		const n = node('A [icon: a]\nA [color: red]', 'A')!
		expect(n).toMatchObject({ icon: 'a', style: { color: 'red' } })
		expect(n.span!.line).toBe(1)
	})

	it('comma-separated declarations', () => {
		expect(parseOcto('A, B [icon: b], C').ir.nodes.map((n) => n.key)).toEqual(['A', 'B', 'C'])
	})
})

describe('parseOcto — groups', () => {
	it('nests groups', () => {
		const { ir, diagnostics } = parseOcto('Outer {\n  Inner [color: red] {\n    Leaf\n  }\n  Side\n}')
		expect(diagnostics).toEqual([])
		const by = Object.fromEntries(ir.nodes.map((n) => [n.key, n]))
		expect(by.Outer.isContainer).toBe(true)
		expect(by.Inner).toMatchObject({ isContainer: true, parent: 'Outer' })
		expect(by.Leaf.parent).toBe('Inner')
		expect(by.Side.parent).toBe('Outer')
		expect(by.Outer.parent).toBeUndefined()
	})

	it('child references move existing nodes', () => {
		const { ir } = parseOcto('A [icon: a]\nB\nG {\n  A, B\n}\nA > B')
		expect(ir.nodes.find((n) => n.key === 'A')).toMatchObject({ parent: 'G', icon: 'a' })
		expect(ir.nodes.find((n) => n.key === 'B')!.parent).toBe('G')
	})

	it('single-line groups and connections inside groups', () => {
		const { ir, diagnostics } = parseOcto('G { A, B }\nH {\n  X > Y\n}')
		expect(diagnostics).toEqual([])
		expect(ir.nodes.filter((n) => n.parent === 'G').map((n) => n.key)).toEqual(['A', 'B'])
		expect(ir.nodes.find((n) => n.key === 'X')!.parent).toBeUndefined()
		expect(ir.edges).toHaveLength(1)
	})

	it('rejects putting a group inside itself', () => {
		const { ir, diagnostics } = parseOcto('G {\n  G\n}')
		expect(ir.nodes[0].parent).toBeUndefined()
		expect(diagnostics[0].severity).toBe('warning')
	})

	it('empty group is a container', () => {
		expect(node('G {\n}', 'G')).toMatchObject({ isContainer: true })
	})
})

describe('parseOcto — header and directives', () => {
	it('architecture header defaults direction to right', () => {
		const { ir } = parseOcto('architecture\nA > B')
		expect(ir.kind).toBe('architecture')
		expect(ir.direction).toBe('right')
		expect(ir.nodes).toHaveLength(2)
		expect(parseOcto('architecture\ndirection down').ir.direction).toBe('down')
	})

	it('header only counts as first statement', () => {
		const { ir } = parseOcto('A\nflowchart')
		expect(ir.nodes.map((n) => n.key)).toEqual(['A', 'flowchart'])
	})

	it('warns on unknown directive values', () => {
		const { ir, diagnostics } = parseOcto('direction sideways\ncolorMode neon\nstyleMode x\ntypeface y')
		expect(ir.direction).toBe('down')
		expect(diagnostics).toHaveLength(4)
		expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true)
		expect(diagnostics[0]).toMatchObject({ from: 10, to: 18 })
	})

	it('title takes the raw rest of the line', () => {
		expect(parseOcto('title Auth: login, signup // c').ir.title).toBe('Auth: login, signup')
		expect(parseOcto('title "  spaced "').ir.title).toBe('  spaced ')
	})
})

describe('parseOcto — error recovery', () => {
	it('unclosed bracket', () => {
		const { ir, diagnostics } = parseOcto('A [icon: x\nB > C')
		expect(diagnostics).toEqual([{ from: 2, to: 10, severity: 'error', message: 'Unclosed "["' }])
		expect(ir.nodes.map((n) => n.key)).toEqual(['A', 'B', 'C'])
		expect(ir.nodes[0].icon).toBe('x')
	})

	it('unclosed brace', () => {
		const { ir, diagnostics } = parseOcto('G {\n  A\n')
		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]).toMatchObject({ from: 2, to: 3, severity: 'error' })
		expect(ir.nodes.find((n) => n.key === 'A')!.parent).toBe('G')
	})

	it('stray closing brace', () => {
		const { ir, diagnostics } = parseOcto('A\n}\nB')
		expect(diagnostics[0].message).toBe('Unexpected "}"')
		expect(ir.nodes).toHaveLength(2)
	})

	it('unclosed string', () => {
		const { ir, diagnostics } = parseOcto('"abc > d\nX')
		expect(diagnostics[0].message).toBe('Unclosed string')
		expect(ir.nodes.map((n) => n.key)).toContain('X')
	})

	it('dangling operator and missing names', () => {
		const r = parseOcto('A >\n> B\nC, \nD > E')
		expect(r.diagnostics.length).toBeGreaterThanOrEqual(3)
		expect(r.ir.edges.map((e) => e.key)).toEqual(['D->E#0'])
	})

	it('labels on declarations are errors', () => {
		const r = parseOcto('A: hello\nB')
		expect(r.diagnostics[0].severity).toBe('error')
		expect(r.ir.nodes.map((n) => n.key)).toEqual(['A', 'B'])
	})

	it('never throws on garbage', () => {
		const inputs = ['', '\n\n', '[[[', ']]]', '{{{', '}}}', ',,,', ':::', '"', '> > >', 'A [,:,]', 'title', '\\', 'A [x: "]']
		for (const s of inputs) expect(() => parseOcto(s)).not.toThrow()
		let rnd = 7
		const chars = 'Ab >-<[]{},:"#/\n '
		for (let k = 0; k < 300; k++) {
			let s = ''
			for (let i = 0; i < 40; i++) {
				rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
				s += chars[rnd % chars.length]
			}
			const r = parseOcto(s)
			for (const d of r.diagnostics) {
				expect(d.from).toBeGreaterThanOrEqual(0)
				expect(d.to).toBeLessThanOrEqual(s.length)
			}
		}
	})
})
