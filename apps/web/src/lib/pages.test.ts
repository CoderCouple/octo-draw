import { describe, expect, it } from 'vitest'
import { crumbLabels, drillInto, focusInto, goTo, goUp, jumpTo, pagePins, pinKey, pruneStack, ROOT_CRUMB, withPagePins } from './pages'

describe('pin keys', () => {
	it('keeps root keys plain and prefixes other pages', () => {
		expect(pinKey('', 'API')).toBe('API')
		expect(pinKey('Payments flow', 'Charge')).toBe('Payments flow/Charge')
	})

	it('reads one page out of the shared pin map', () => {
		const pins = { API: { x: 1, y: 1 }, 'main/vpc': { x: 2, y: 2 }, 'Orders/Ship': { x: 3, y: 3 } }
		const names = ['', 'Orders']
		expect(pagePins(pins, '', names)).toEqual({ API: { x: 1, y: 1 }, 'main/vpc': { x: 2, y: 2 } })
		expect(pagePins(pins, 'Orders', names)).toEqual({ Ship: { x: 3, y: 3 } })
	})

	it('prefers the longest page-name prefix', () => {
		const pins = { 'a/b/c': { x: 1, y: 1 } }
		expect(pagePins(pins, 'a/b', ['', 'a', 'a/b'])).toEqual({ c: { x: 1, y: 1 } })
		expect(pagePins(pins, 'a', ['', 'a', 'a/b'])).toEqual({})
	})

	it('replaces only the given page', () => {
		const pins = { API: { x: 1, y: 1 }, 'Orders/Ship': { x: 3, y: 3 } }
		expect(withPagePins(pins, 'Orders', { Create: { x: 9, y: 9 } }, ['', 'Orders'])).toEqual({ API: { x: 1, y: 1 }, 'Orders/Create': { x: 9, y: 9 } })
		expect(withPagePins(pins, '', {}, ['', 'Orders'])).toEqual({ 'Orders/Ship': { x: 3, y: 3 } })
	})

	it('round-trips', () => {
		const local = { a: { x: 1, y: 2 }, 'b c': { x: 3, y: 4 } }
		const all = withPagePins({}, 'P', local)
		expect(pagePins(all, 'P')).toEqual(local)
	})
})

describe('breadcrumb stack', () => {
	it('drills, focuses and goes back up', () => {
		let s = [ROOT_CRUMB]
		s = drillInto(s, 'Payments flow', 'Payments')
		expect(s).toEqual([ROOT_CRUMB, { page: 'Payments flow', via: 'Payments' }])
		s = focusInto(s, 'Backend')
		expect(s[2]).toEqual({ page: 'Payments flow', focus: 'Backend', via: 'Backend' })
		expect(goUp(s)).toEqual(s.slice(0, 2))
		expect(goUp(goUp(goUp(s)))).toEqual([ROOT_CRUMB])
	})

	it('keeps the visited path when a page has several entry nodes', () => {
		let s = drillInto([ROOT_CRUMB], 'Orders', 'Orders')
		s = drillInto(s, 'Ship', 'Ship')
		s = drillInto(s, 'Carrier', 'UPS')
		expect(s.map((c) => c.page)).toEqual(['', 'Orders', 'Ship', 'Carrier'])
		// drilling into a page already on the path goes back to it
		expect(drillInto(s, 'Orders').map((c) => c.page)).toEqual(['', 'Orders'])
	})

	it('goTo truncates to a crumb', () => {
		const s = drillInto(drillInto([ROOT_CRUMB], 'A'), 'B')
		expect(goTo(s, 0)).toEqual([ROOT_CRUMB])
		expect(goTo(s, 1).map((c) => c.page)).toEqual(['', 'A'])
		expect(goTo(s, 9)).toEqual(s)
	})

	it('jumpTo keeps the path when the page is on it', () => {
		const s = drillInto(drillInto([ROOT_CRUMB], 'A'), 'B')
		expect(jumpTo(s, 'A').map((c) => c.page)).toEqual(['', 'A'])
		expect(jumpTo(s, 'C').map((c) => c.page)).toEqual(['', 'C'])
		expect(jumpTo(s, '')).toEqual([ROOT_CRUMB])
	})

	it('prunes levels that no longer exist', () => {
		const s = focusInto(drillInto([ROOT_CRUMB], 'A'), 'G')
		expect(pruneStack(s, ['', 'A'], () => ['G'])).toEqual(s)
		expect(pruneStack(s, ['', 'A'], () => [])).toEqual(s.slice(0, 2))
		expect(pruneStack(s, [''], () => ['G'])).toEqual([ROOT_CRUMB])
		expect(pruneStack([], [''], () => null)).toEqual([ROOT_CRUMB])
	})

	it('labels crumbs', () => {
		const s = focusInto(drillInto([ROOT_CRUMB], 'Payments flow'), 'Backend')
		expect(crumbLabels(s, 'Checkout', (_p, k) => `${k}!`)).toEqual(['Checkout', 'Payments flow', 'Backend!'])
		expect(crumbLabels([ROOT_CRUMB], '', () => '')).toEqual(['Root'])
	})
})
