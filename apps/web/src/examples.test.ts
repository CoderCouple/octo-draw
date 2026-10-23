import { describe, expect, it } from 'vitest'
import { drillTargets, parseOcto, parseOctoPages, resolveIcon } from '@octo-draw/core'
import { EXAMPLES } from './examples'

describe('examples', () => {
	it.each(EXAMPLES.map((e) => [e.id, e.code]))('%s parses without errors', (_id, code) => {
		const r = parseOctoPages(code).pages[0]
		expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(r.ir.nodes.length).toBeGreaterThan(3)
	})

	it('architecture uses catalog icons, including brand logos', () => {
		const ir = parseOcto(EXAMPLES.find((e) => e.id === 'architecture')!.code).ir
		const icons = ir.nodes.map((n) => n.icon).filter((n): n is string => !!n)
		for (const name of ['aws-lambda', 'postgres', 'redis', 'kafka', 'react']) expect(icons).toContain(name)
		for (const name of icons) expect(resolveIcon(name), name).not.toBeNull()
		expect(ir.nodes.find((n) => n.key === 'DB')?.style?.color).toBe('brand')
	})

	it('drill-down has drillable nodes, a group and a sequence page', () => {
		const { pages, diagnostics } = parseOctoPages(EXAMPLES.find((e) => e.id === 'drill')!.code)
		expect(diagnostics).toEqual([])
		const names = pages.map((p) => p.name)
		expect(names).toEqual(['', 'Checkout flow', 'Payments', 'Fulfillment'])
		const root = pages[0].ir
		expect(drillTargets(root, names, '')).toEqual({ Checkout: 'Checkout flow', Payments: 'Payments', Fulfillment: 'Fulfillment' })
		expect(root.nodes.some((n) => n.isContainer)).toBe(true)
		expect(pages[1].ir.kind).toBe('sequence')
		for (const p of pages) expect(p.ir.nodes.length).toBeGreaterThan(2)
	})
})
