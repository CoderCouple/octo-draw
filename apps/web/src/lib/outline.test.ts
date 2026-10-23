import { describe, expect, it } from 'vitest'
import { pageNames, pageTree } from '@octo-draw/core'
import DEEP from '@octo-draw/core/fixtures/deep.octo?raw'
import { buildOutline, outlineAncestors, shortPageLabel } from './outline'

const tree = pageTree(DEEP)
const names = pageNames(DEEP)
const CARD = 'Platform / Checkout / Payments / Card processing'
const ISSUER = 'Platform / Checkout / Payments / Card processing / Authorization / Issuer gateway'

describe('outline', () => {
	it('shortens path-style names under their parent', () => {
		expect(shortPageLabel('Platform / Checkout', 'Platform')).toBe('Checkout')
		expect(shortPageLabel('Platform / Checkout', 'Other')).toBe('Platform / Checkout')
		expect(shortPageLabel('Platform', null)).toBe('Platform')
	})

	it('starts with two levels open and counts closed branches', () => {
		const rows = buildOutline(tree, { pageNames: names, current: '', rootLabel: 'Acme' })
		expect(rows.map((r) => [r.label, r.depth])).toEqual([
			['Acme', 0],
			['Platform', 1],
			['Checkout', 2],
			['Catalog', 2],
			['Unlinked', 0],
			['Legacy batch jobs', 1],
		])
		const checkout = rows.find((r) => r.label === 'Checkout')!
		expect(checkout).toMatchObject({ open: false, hasChildren: true, count: 4 })
		expect(rows[0]).toMatchObject({ current: true, page: '', count: 7 })
		expect(rows.find((r) => r.label === 'Unlinked')!.page).toBeNull()
	})

	it('opens the path to the current page and highlights it', () => {
		const rows = buildOutline(tree, { pageNames: names, current: ISSUER })
		const cur = rows.filter((r) => r.current)
		expect(cur).toHaveLength(1)
		expect(cur[0]).toMatchObject({ page: ISSUER, label: 'Issuer gateway', depth: 6 })
		expect(outlineAncestors(tree, ISSUER, names)).toEqual(['', 'Platform', 'Platform / Checkout', 'Platform / Checkout / Payments', CARD, CARD + ' / Authorization'])
	})

	it('respects toggles, but opening a path wins only when not toggled', () => {
		const rows = buildOutline(tree, { pageNames: names, current: '', toggled: { Platform: false } })
		expect(rows.map((r) => r.label)).toEqual(['Root', 'Platform', 'Unlinked', 'Legacy batch jobs'])
		expect(rows[1].count).toBe(6)
	})

	it('filters by search, keeping ancestors, and marks the match', () => {
		const rows = buildOutline(tree, { pageNames: names, current: '', query: 'issuer' })
		expect(rows.map((r) => r.label)).toEqual(['Root', 'Platform', 'Checkout', 'Payments', 'Card processing', 'Authorization', 'Issuer gateway'])
		expect(rows[6].match).toEqual([0, 6])
		expect(buildOutline(tree, { pageNames: names, current: '', query: 'zzz' })).toEqual([])
	})

	it('gives cycle entries their own row ids', () => {
		const rows = buildOutline(tree, { pageNames: names, current: '', openDepth: 9 })
		const ids = rows.map((r) => r.id)
		expect(new Set(ids).size).toBe(ids.length)
		const cyc = rows.find((r) => r.cycle)!
		expect(cyc).toMatchObject({ page: 'Platform', current: false })
	})

	it('stays fast on 300 pages', () => {
		let src = 'Root node [drill: P0]\n'
		for (let i = 0; i < 300; i++) src += `\npage P${i}\nN${i} [drill: P${i + 1}]\nOther${i}\n`
		const t0 = performance.now()
		const big = pageTree(src)
		const rows = buildOutline(big, { pageNames: pageNames(src), current: 'P250' })
		expect(rows.find((r) => r.current)?.page).toBe('P250')
		expect(performance.now() - t0).toBeLessThan(1500)
	})
})
