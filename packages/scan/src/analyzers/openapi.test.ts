import { describe, expect, it } from 'vitest'
import { fixture, files } from '../test/helpers'
import { analyzeOpenApi } from './openapi'

describe('openapi analyzer', () => {
	it('builds a page of tag groups and endpoints', async () => {
		const r = analyzeOpenApi(await fixture('openapi'))
		expect(r.pages).toHaveLength(1)
		const p = r.pages[0]
		expect(p.name).toBe('API Petstore')
		const groups = p.nodes.filter((n) => n.isContainer).map((n) => n.label)
		expect(groups).toEqual(['health', 'pets', 'store'])
		expect(p.nodes.filter((n) => n.parent === 'pets endpoints').map((n) => n.key)).toEqual(['GET /pets', 'POST /pets', 'GET /pets/{petId}'])
	})

	it('reads JSON specs and ignores other JSON', () => {
		const spec = JSON.stringify({ swagger: '2.0', info: { title: 'Legacy' }, paths: { '/a': { get: {} } } })
		const r = analyzeOpenApi(files({ 'docs/swagger.json': spec, 'package.json': '{"name":"x"}' }))
		expect(r.pages.map((p) => p.name)).toEqual(['API Legacy'])
	})
})
