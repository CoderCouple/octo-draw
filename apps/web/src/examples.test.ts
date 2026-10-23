import { describe, expect, it } from 'vitest'
import { parseOcto, resolveIcon } from '@octo-draw/core'
import { EXAMPLES } from './examples'

describe('examples', () => {
	it.each(EXAMPLES.map((e) => [e.id, e.code]))('%s parses without errors', (_id, code) => {
		const r = parseOcto(code)
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
})
