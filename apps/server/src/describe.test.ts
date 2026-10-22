import { describe, expect, it } from 'vitest'
import { describeDiagram } from './describe'

describe('describeDiagram', () => {
	it('summarises structure', () => {
		const { ir, stats, summary } = describeDiagram('title Shop\nUsers > API\nBackend {\n  API\n  Worker\n}\nAPI > DB: sql\nAPI > Worker\nLonely\n')
		expect(ir.nodes.every((n) => !('span' in n))).toBe(true)
		expect(stats).toMatchObject({ title: 'Shop', groups: 1, edges: 3, labelledEdges: 1, isolated: ['Lonely'], sources: ['Users'], maxDepth: 1 })
		expect(stats.hubs[0]).toEqual({ key: 'API', degree: 3 })
		expect(stats.sinks.sort()).toEqual(['DB', 'Worker'])
		expect(summary).toContain('most connected: API (3)')
	})
})
