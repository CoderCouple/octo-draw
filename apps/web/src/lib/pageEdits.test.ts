import { describe, expect, it } from 'vitest'
import { drillTargets, pageNames, parseOctoPages, parsePage } from '@octo-draw/core'
import { addSubDiagram, childPageName, deletePage, renamePage } from './pageEdits'

const targets = (src: string, page: string) => drillTargets(parsePage(src, page)!.ir, pageNames(src), page)

describe('page edits', () => {
	it('names child pages by path and keeps them unique', () => {
		const src = 'A\n\npage Shop / Cart\nx\n'
		expect(childPageName(src, '', 'Shop')).toBe('Shop')
		expect(childPageName(src, 'Shop', 'Cart')).toBe('Shop / Cart 2')
		expect(childPageName(src, 'Shop / Cart', 'Line item')).toBe('Shop / Cart / Line item')
	})

	it('adds a linked empty sub-diagram, at any depth', () => {
		let src = 'Shop [icon: store]\n'
		let r = addSubDiagram(src, '', 'Shop', 'Shop')
		expect(r.page).toBe('Shop')
		src = r.code
		expect(targets(src, '')).toEqual({ Shop: 'Shop' })
		src = src + 'Cart\n'
		r = addSubDiagram(src, 'Shop', 'Cart', 'Cart')
		src = r.code
		expect(r.page).toBe('Shop / Cart')
		expect(targets(src, 'Shop')).toEqual({ Cart: 'Shop / Cart' })
		expect(parseOctoPages(src).diagnostics).toEqual([])
		expect(parsePage(src, '')!.ir.nodes[0].icon).toBe('store')
	})

	it('renames a page, its links and its path children', () => {
		const src = 'API [drill: Orders]\nOrders\n\npage Orders\nCreate [drill: Orders / Create]\n\npage Orders / Create\nx\n'
		const out = renamePage(src, 'Orders', 'Sales')
		expect(pageNames(out)).toEqual(['', 'Sales', 'Sales / Create'])
		expect(targets(out, '')).toEqual({ API: 'Sales', Orders: 'Sales' })
		expect(targets(out, 'Sales')).toEqual({ Create: 'Sales / Create' })
		expect(renamePage(src, 'Orders', 'orders / create')).toBe(src)
		expect(renamePage(src, '', 'X')).toBe(src)
	})

	it('deletes a page and its explicit links', () => {
		const src = 'API [drill: Orders, icon: server]\n\npage Orders\nx\n\npage Other\ny\n'
		const out = deletePage(src, 'Orders')
		expect(pageNames(out)).toEqual(['', 'Other'])
		expect(out.startsWith('API [icon: server]\n')).toBe(true)
		expect(deletePage(out, 'Other')).toBe('API [icon: server]\n')
	})
})
