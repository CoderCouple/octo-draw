import { describe, expect, it } from 'vitest'
import { parseOcto } from '../dsl/parse'
import { renameNodeLabel, setEdgeProp, setNodeProp } from '../dsl/patch'
import { quoteName } from '../dsl/print'
import { applyActions } from '../agent/apply'
import { addPage, drillTargets, pageAt, pageNames, parseOctoPages, parsePage, parsePageHeader, printPageName, splitPages } from './pages'

/** IR without source spans (they move when an earlier page grows). */
const shape = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'span' ? undefined : v)))

const CHECKOUT = `title Checkout
API [icon: server]
Payments [icon: credit-card, drill: Payments flow]   // explicit target
Orders                                              // implicit: a page named "Orders" exists
API > Payments, Orders

page Payments flow
direction right
Validate > Charge > Receipt

page Orders
Create > Reserve stock > Ship
`

describe('parsePageHeader', () => {
	it('accepts page <name>', () => {
		expect(parsePageHeader('page Orders')).toBe('Orders')
		expect(parsePageHeader('page Payments flow')).toBe('Payments flow')
		expect(parsePageHeader('page   Payments \t flow  ')).toBe('Payments flow')
		expect(parsePageHeader('page main-vpc')).toBe('main-vpc')
		expect(parsePageHeader('page Orders\r')).toBe('Orders')
	})

	it('accepts quoted names', () => {
		expect(parsePageHeader('page "Auth: OAuth"')).toBe('Auth: OAuth')
		expect(parsePageHeader('page "a \\"b\\" c"')).toBe('a "b" c')
		expect(parsePageHeader('page "x" // note')).toBe('x')
		expect(parsePageHeader('page "x" y')).toBeNull()
		expect(parsePageHeader('page "x')).toBeNull()
		expect(parsePageHeader('page ""')).toBeNull()
	})

	it('allows a trailing comment', () => {
		expect(parsePageHeader('page Orders // the orders flow')).toBe('Orders')
		expect(parsePageHeader('page Orders # the orders flow')).toBe('Orders')
		expect(parsePageHeader('page C#')).toBe('C#')
	})

	it('rejects nodes and connections named page', () => {
		expect(parsePageHeader('page')).toBeNull()
		expect(parsePageHeader('page   ')).toBeNull()
		expect(parsePageHeader('page > x')).toBeNull()
		expect(parsePageHeader('page x > y')).toBeNull()
		expect(parsePageHeader('page x -- y')).toBeNull()
		expect(parsePageHeader('page [icon: file]')).toBeNull()
		expect(parsePageHeader('page x [icon: file]')).toBeNull()
		expect(parsePageHeader('page x {')).toBeNull()
		expect(parsePageHeader('page a, b')).toBeNull()
		expect(parsePageHeader('page x: y')).toBeNull()
		expect(parsePageHeader('pages x')).toBeNull()
		expect(parsePageHeader(' page x')).toBeNull()
		expect(parsePageHeader('page // only a comment')).toBeNull()
	})
})

describe('splitPages', () => {
	it('always has a root page', () => {
		expect(splitPages('')).toEqual([{ name: '', from: 0, to: 0, bodyFrom: 0, line: 1 }])
		expect(splitPages('A > B\n')).toEqual([{ name: '', from: 0, to: 6, bodyFrom: 0, line: 1 }])
	})

	it('splits on page lines', () => {
		const pages = splitPages(CHECKOUT)
		expect(pages.map((p) => p.name)).toEqual(['', 'Payments flow', 'Orders'])
		const [root, pay, orders] = pages
		expect(root.from).toBe(0)
		expect(root.to).toBe(pay.from)
		expect(CHECKOUT.slice(pay.from, pay.bodyFrom)).toBe('page Payments flow\n')
		expect(pay.line).toBe(7)
		expect(pay.to).toBe(orders.from)
		expect(orders.to).toBe(CHECKOUT.length)
		expect(orders.line).toBe(11)
		expect(CHECKOUT.slice(orders.bodyFrom, orders.to)).toBe('Create > Reserve stock > Ship\n')
	})

	it('handles a source that starts with a page and a header at EOF', () => {
		const src = 'page A\nX\npage B'
		const pages = splitPages(src)
		expect(pages).toEqual([
			{ name: '', from: 0, to: 0, bodyFrom: 0, line: 1 },
			{ name: 'A', from: 0, to: 9, bodyFrom: 7, line: 1 },
			{ name: 'B', from: 9, to: 15, bodyFrom: 15, line: 3 },
		])
	})

	it('ignores page-like lines that are nodes or connections', () => {
		const src = 'page\npage > x\n  page Indented\npage x [icon: file]\n'
		expect(pageNames(src)).toEqual([''])
		expect(parseOctoPages(src).pages[0].ir).toEqual(parseOcto(src).ir)
	})
})

describe('parsePage', () => {
	it('gives exactly parseOcto for sources without pages', () => {
		for (const src of ['', 'A > B', 'title T\nX [icon: a] {\n Y\n}\nX > Z: hi\n', 'sequence\nA > B: hi\n', 'A > \n} [', 'page > x\npage\n']) {
			expect(parsePage(src, '')).toEqual(parseOcto(src))
			const all = parseOctoPages(src)
			expect(all.pages).toHaveLength(1)
			expect({ ir: all.pages[0].ir, diagnostics: all.pages[0].diagnostics }).toEqual(parseOcto(src))
			expect(all.diagnostics).toEqual(parseOcto(src).diagnostics)
		}
	})

	it('parses each page body on its own', () => {
		const root = parsePage(CHECKOUT, '')!
		expect(root.ir.title).toBe('Checkout')
		expect(root.ir.nodes.map((n) => n.key)).toEqual(['API', 'Payments', 'Orders'])
		const pay = parsePage(CHECKOUT, 'Payments flow')!
		expect(pay.ir.direction).toBe('right')
		expect(pay.ir.title).toBeUndefined()
		expect(pay.ir.nodes.map((n) => n.key)).toEqual(['Validate', 'Charge', 'Receipt'])
		expect(pay.ir.edges.map((e) => e.key)).toEqual(['Validate->Charge#0', 'Charge->Receipt#0'])
		const orders = parsePage(CHECKOUT, 'orders')!
		expect(orders.ir.direction).toBe('down')
		expect(orders.ir.nodes.map((n) => n.key)).toEqual(['Create', 'Reserve stock', 'Ship'])
		expect(parsePage(CHECKOUT, 'Nope')).toBeNull()
	})

	it('reports spans and diagnostics in full-source offsets', () => {
		const pay = parsePage(CHECKOUT, 'Payments flow')!
		const charge = pay.ir.edges[1].span!
		expect(CHECKOUT.slice(charge.from, charge.to)).toBe('Validate > Charge > Receipt')
		expect(charge.line).toBe(9)
		const src = 'A\npage P\nX [icon: a\nY [shape: blob]\n'
		const p = parsePage(src, 'P')!
		const x = p.ir.nodes.find((n) => n.key === 'X')!
		expect(src.slice(x.span!.from, x.span!.to)).toBe('X [icon: a')
		expect(x.span!.line).toBe(3)
		expect(p.diagnostics.map((d) => [d.message, src.slice(d.from, d.to)])).toEqual([
			['Unclosed "["', '[icon: a'],
			[expect.stringContaining('Unknown shape'), 'shape: blob'],
		])
	})

	it('reads title from the root only', () => {
		const src = 'title Root\npage P\ntitle Sub\nA\n'
		expect(parsePage(src, '')!.ir.title).toBe('Root')
		const p = parsePage(src, 'P')!
		expect(p.ir.title).toBeUndefined()
		expect(p.diagnostics).toHaveLength(1)
		expect(src.slice(p.diagnostics[0].from, p.diagnostics[0].to)).toBe('title Sub')
		expect(p.diagnostics[0].severity).toBe('warning')
	})

	it('keeps directives per page', () => {
		const src = 'direction left\ncolorMode bold\nA\npage P\nB\n'
		expect(parsePage(src, '')!.ir.direction).toBe('left')
		expect(parsePage(src, 'P')!.ir.direction).toBe('down')
		expect(parsePage(src, 'P')!.ir.style).toEqual({})
	})

	it('parses sequence and erd pages with their sublanguages', () => {
		const src = `A > B

page Login
// how login works
sequence
autoNumber on
User > API: login
API --> User: token

page Schema
erd
users {
  id string pk
}
posts {
  id string pk
  author_id string fk
}
posts.author_id > users.id
`
		const login = parsePage(src, 'Login')!
		expect(login.ir.kind).toBe('sequence')
		expect(login.diagnostics).toEqual([])
		expect(login.ir.sequence!.events).toHaveLength(2)
		const msg = login.ir.sequence!.events[0]
		expect(msg.kind === 'message' && src.slice(msg.span!.from, msg.span!.to)).toBe('User > API: login')
		const schema = parsePage(src, 'Schema')!
		expect(schema.ir.kind).toBe('erd')
		expect(schema.diagnostics).toEqual([])
		expect(schema.ir.nodes.map((n) => n.key)).toEqual(['users', 'posts'])
		expect(schema.ir.edges[0].fromField).toBe('author_id')
		expect(parsePage(src, '')!.ir.kind).toBe('flowchart')
	})

	it('does not leak nodes between pages', () => {
		const src = 'A > B\npage P\nB > C\n'
		expect(parsePage(src, '')!.ir.nodes.map((n) => n.key)).toEqual(['A', 'B'])
		expect(parsePage(src, 'P')!.ir.nodes.map((n) => n.key)).toEqual(['B', 'C'])
	})
})

describe('parseOctoPages', () => {
	it('parses all pages', () => {
		const { pages, diagnostics } = parseOctoPages(CHECKOUT)
		expect(pages.map((p) => [p.name, p.ir.nodes.length])).toEqual([
			['', 3],
			['Payments flow', 3],
			['Orders', 3],
		])
		expect(diagnostics).toEqual([])
	})

	it('warns about unknown drill targets', () => {
		const src = 'A [drill: Missing]\nB [drill: orders]\nC [drill]\nOrders [drill]\npage Orders\nX\n'
		const { diagnostics } = parseOctoPages(src)
		expect(diagnostics.map((d) => [d.severity, d.message, src.slice(d.from, d.to)])).toEqual([
			['warning', 'No page named "Missing" to drill into', 'drill: Missing'],
			['warning', 'No page named "C" to drill into', 'drill'],
		])
	})

	it('warns when a page drills into itself and about duplicate pages', () => {
		const src = 'page P\nX [drill: P]\npage p\nY\n'
		const { diagnostics } = parseOctoPages(src)
		expect(diagnostics.map((d) => d.message)).toEqual(['No page named "P" to drill into', 'Duplicate page "p" (only the first one is used)'])
		expect(src.slice(diagnostics[1].from, diagnostics[1].to)).toBe('page p')
	})

	it('includes page diagnostics in source order', () => {
		const src = 'A [shape: x]\npage P\nB [shape: y]\n'
		const { diagnostics } = parseOctoPages(src)
		expect(diagnostics.map((d) => src.slice(d.from, d.to))).toEqual(['shape: x', 'shape: y'])
	})
})

describe('drillTargets', () => {
	it('uses explicit drill and implicit page names', () => {
		const ir = parsePage(CHECKOUT, '')!.ir
		expect(drillTargets(ir, pageNames(CHECKOUT))).toEqual({ Payments: 'Payments flow', Orders: 'Orders' })
	})

	it('matches case-insensitively and returns the page spelling', () => {
		const ir = parseOcto('orders\nX [drill: PAYMENTS]\n').ir
		expect(drillTargets(ir, ['', 'Orders', 'Payments'])).toEqual({ orders: 'Orders', X: 'Payments' })
	})

	it('falls back to the key when drill is unknown or bare', () => {
		const ir = parseOcto('Orders [drill: Nope]\nB [drill]\nC\n').ir
		expect(drillTargets(ir, ['', 'Orders', 'B'])).toEqual({ Orders: 'Orders', B: 'B' })
	})

	it('never targets the root and can exclude the current page', () => {
		const ir = parseOcto('Orders\nX [drill: Orders]\n').ir
		expect(drillTargets(ir, [''])).toEqual({})
		expect(drillTargets(ir, ['', 'Orders'], 'Orders')).toEqual({})
	})
})

describe('pageAt', () => {
	it('follows the caret', () => {
		const pages = splitPages(CHECKOUT)
		expect(pageAt(CHECKOUT, 0)).toBe('')
		expect(pageAt(CHECKOUT, pages[1].from - 1)).toBe('')
		expect(pageAt(CHECKOUT, pages[1].from)).toBe('Payments flow')
		expect(pageAt(CHECKOUT, pages[1].bodyFrom + 3)).toBe('Payments flow')
		expect(pageAt(CHECKOUT, pages[2].from)).toBe('Orders')
		expect(pageAt(CHECKOUT, CHECKOUT.length)).toBe('Orders')
		expect(pageAt('A > B', 3)).toBe('')
	})
})

describe('addPage', () => {
	it('appends a page with a blank line before it', () => {
		expect(addPage('A > B\n', 'Detail')).toBe('A > B\n\npage Detail\n')
		expect(addPage('A > B', 'Detail', 'X > Y')).toBe('A > B\n\npage Detail\nX > Y\n')
		expect(addPage('A\n\n', 'P')).toBe('A\n\npage P\n')
		expect(addPage('', 'P')).toBe('page P\n')
	})

	it('quotes names that would not read back', () => {
		const out = addPage('A\n', 'Auth: OAuth', 'X')
		expect(out).toBe('A\n\npage "Auth: OAuth"\nX\n')
		expect(pageNames(out)).toEqual(['', 'Auth: OAuth'])
		for (const name of ['a > b', 'x // y', 'two  spaces', ' lead', 'q"q', 'C#', '#x', 'plain name']) {
			expect(pageNames(addPage('', name))).toEqual(['', name])
		}
		expect(printPageName('plain name')).toBe('plain name')
	})

	it('does not duplicate pages or add empty names', () => {
		expect(addPage(CHECKOUT, 'orders')).toBe(CHECKOUT)
		expect(addPage('A', '  ')).toBe('A')
	})

	it('produces a parseable page', () => {
		const out = addPage(CHECKOUT, 'Ship', 'Pack > Send')
		expect(parsePage(out, 'Ship')!.ir.edges).toHaveLength(1)
		expect(parsePage(out, 'Orders')!.ir.nodes.map((n) => n.key)).toEqual(['Create', 'Reserve stock', 'Ship'])
	})
})

describe('patching a page', () => {
	const pageText = (src: string, name: string) => {
		const p = splitPages(src).find((x) => x.name === name)!
		return src.slice(p.from, p.to)
	}

	it('setNodeProp edits a node on a page and nothing else', () => {
		const src = 'Charge\npage Payments flow\nValidate > Charge [color: red]\nCharge [icon: x]\n\npage Orders\nCharge\n'
		const out = setNodeProp(src, 'Charge', 'icon', 'credit-card', 'Payments flow')
		expect(out).toBe('Charge\npage Payments flow\nValidate > Charge [color: red]\nCharge [icon: credit-card]\n\npage Orders\nCharge\n')
		expect(parsePage(out, 'Payments flow')!.ir.nodes.find((n) => n.key === 'Charge')!.icon).toBe('credit-card')
	})

	it('adds a declaration inside the page for implicit nodes', () => {
		const out = setNodeProp(CHECKOUT, 'Charge', 'icon', 'credit-card', 'Payments flow')
		expect(pageText(out, 'Payments flow')).toBe('page Payments flow\ndirection right\nValidate > Charge > Receipt\nCharge [icon: credit-card]\n\n')
		expect(pageText(out, 'Orders')).toBe(pageText(CHECKOUT, 'Orders'))
		expect(pageText(out, '')).toBe(pageText(CHECKOUT, ''))
		const last = setNodeProp(CHECKOUT, 'Ship', 'shape', 'oval', 'Orders')
		expect(last).toBe(CHECKOUT + 'Ship [shape: oval]\n')
	})

	it('handles a last page without a trailing newline or with an empty body', () => {
		expect(setNodeProp('A\npage P\nX', 'X', 'color', 'red', 'P')).toBe('A\npage P\nX [color: red]')
		expect(setNodeProp('A\npage P\nX', 'Y', 'color', 'red', 'P')).toBe('A\npage P\nX\nY [color: red]\n')
		expect(setNodeProp('A\npage P', 'Y', 'color', 'red', 'P')).toBe('A\npage P\nY [color: red]\n')
		expect(setNodeProp('page P\npage Q\n', 'Y', 'color', 'red', 'P')).toBe('page P\nY [color: red]\npage Q\n')
	})

	it('defaults to the root page', () => {
		const out = setNodeProp(CHECKOUT, 'Ship', 'color', 'red')
		expect(pageText(out, '')).toBe(pageText(CHECKOUT, '').replace(/\n\n$/, '\nShip [color: red]\n\n'))
		expect(pageText(out, 'Orders')).toBe(pageText(CHECKOUT, 'Orders'))
		expect(setNodeProp(CHECKOUT, 'API', 'color', 'blue', '')).toBe(CHECKOUT.replace('API [icon: server]', 'API [icon: server, color: blue]'))
	})

	it('leaves the source alone for an unknown page', () => {
		expect(setNodeProp(CHECKOUT, 'X', 'color', 'red', 'Nope')).toBe(CHECKOUT)
	})

	it('renameNodeLabel works on a page', () => {
		const out = renameNodeLabel(CHECKOUT, 'Reserve stock', 'Reserve', 'Orders')
		expect(parsePage(out, 'Orders')!.ir.nodes.find((n) => n.key === 'Reserve stock')!.label).toBe('Reserve')
		expect(parsePage(out, '')!.ir).toEqual(parsePage(CHECKOUT, '')!.ir)
	})

	it('setEdgeProp works on a page and splits chains there', () => {
		const out = setEdgeProp(CHECKOUT, 'Charge->Receipt#0', 'color', 'red', 'Payments flow')
		expect(pageText(out, 'Payments flow')).toBe('page Payments flow\ndirection right\nValidate > Charge\nCharge > Receipt [color: red]\n\n')
		expect(pageText(out, 'Orders')).toBe(pageText(CHECKOUT, 'Orders'))
		const root = setEdgeProp(CHECKOUT, 'API->Payments#0', 'color', 'red')
		expect(pageText(root, 'Payments flow')).toBe(pageText(CHECKOUT, 'Payments flow'))
		expect(parsePage(root, '')!.ir.edges[0].style).toEqual({ color: 'red' })
		// an edge only on another page is not found from the root
		expect(setEdgeProp(CHECKOUT, 'Create->Reserve stock#0', 'color', 'red')).toBe(CHECKOUT)
	})

	it('never turns a node into a page header', () => {
		expect(quoteName('page X')).toBe('"page X"')
		expect(quoteName('page')).toBe('page')
		const out = setNodeProp('A\n', 'page X', 'color', 'red')
		expect(pageNames(out)).toEqual([''])
		expect(parseOcto(out).ir.nodes.map((n) => n.key)).toEqual(['A', 'page X'])
	})
})

describe('applyActions on a page', () => {
	it('edits only the chosen page', () => {
		const r = applyActions(
			CHECKOUT,
			[
				{ type: 'addNode', key: 'Refund', icon: 'undo' },
				{ type: 'addEdge', from: 'Charge', to: 'Refund', label: 'on failure' },
				{ type: 'updateNode', key: 'Validate', color: 'green' },
				{ type: 'setDirection', direction: 'down' },
			],
			{ page: 'Payments flow' },
		)
		expect(r.errors).toEqual([])
		expect(r.applied).toBe(4)
		const pay = parsePage(r.code, 'Payments flow')!
		expect(pay.diagnostics).toEqual([])
		expect(pay.ir.direction).toBe('down')
		expect(pay.ir.nodes.find((n) => n.key === 'Refund')!.icon).toBe('undo')
		expect(pay.ir.edges.some((e) => e.from === 'Charge' && e.to === 'Refund')).toBe(true)
		expect(parsePage(r.code, '')!.ir).toEqual(parsePage(CHECKOUT, '')!.ir)
		expect(shape(parsePage(r.code, 'Orders')!.ir)).toEqual(shape(parsePage(CHECKOUT, 'Orders')!.ir))
	})

	it('defaults to the root page when pages exist', () => {
		const r = applyActions(CHECKOUT, [{ type: 'addEdge', from: 'API', to: 'Audit' }, { type: 'removeNode', key: 'Orders' }])
		expect(r.errors).toEqual([])
		const root = parsePage(r.code, '')!.ir
		expect(root.nodes.map((n) => n.key)).toEqual(['API', 'Payments', 'Audit'])
		expect(shape(parsePage(r.code, 'Orders')!.ir)).toEqual(shape(parsePage(CHECKOUT, 'Orders')!.ir))
		expect(pageNames(r.code)).toEqual(['', 'Payments flow', 'Orders'])
	})

	it('reports unknown pages per action', () => {
		const r = applyActions(CHECKOUT, [{ type: 'addNode', key: 'X' }], { page: 'Nope' })
		expect(r.code).toBe(CHECKOUT)
		expect(r.errors).toEqual([{ index: 0, message: 'Unknown page "Nope"' }])
	})

	it('replaceCode replaces one page, or the whole source without a page', () => {
		const one = applyActions(CHECKOUT, [{ type: 'replaceCode', code: 'P > Q' }], { page: 'Orders' })
		expect(parsePage(one.code, 'Orders')!.ir.nodes.map((n) => n.key)).toEqual(['P', 'Q'])
		expect(parsePage(one.code, 'Payments flow')!.ir).toEqual(parsePage(CHECKOUT, 'Payments flow')!.ir)
		const mid = applyActions(CHECKOUT, [{ type: 'replaceCode', code: 'P > Q' }], { page: 'Payments flow' })
		expect(pageNames(mid.code)).toEqual(['', 'Payments flow', 'Orders'])
		expect(parsePage(mid.code, 'Payments flow')!.ir.nodes.map((n) => n.key)).toEqual(['P', 'Q'])
		const all = applyActions(CHECKOUT, [{ type: 'replaceCode', code: 'P > Q' }])
		expect(all.code).toBe('P > Q')
	})

	it('adds groups inside a page', () => {
		const r = applyActions(CHECKOUT, [{ type: 'addGroup', key: 'Core', children: ['Create', 'Ship'] }], { page: 'Orders' })
		expect(r.errors).toEqual([])
		const ir = parsePage(r.code, 'Orders')!.ir
		expect(ir.nodes.find((n) => n.key === 'Ship')!.parent).toBe('Core')
	})
})
