import { describe, expect, it } from 'vitest'
import { fixture } from '../test/helpers'
import { analyzeActions } from './actions'

describe('GitHub Actions analyzer', () => {
	it('draws jobs, needs edges and deploy targets', async () => {
		const r = analyzeActions(await fixture('monorepo'))!
		const keys = r.page.nodes.map((n) => n.key)
		expect(keys).toEqual(expect.arrayContaining(['Deploy workflow', 'Deploy test', 'Deploy image', 'Deploy deploy', 'GHCR', 'Amazon ECS']))
		expect(r.page.nodes.find((n) => n.key === 'Deploy workflow')?.label).toBe('Deploy (push, workflow_dispatch)')
		const edges = r.page.edges.map((e) => `${e.from}>${e.to}`)
		expect(edges).toEqual(expect.arrayContaining(['Deploy test>Deploy image', 'Deploy image>Deploy deploy', 'Deploy image>GHCR', 'Deploy deploy>Amazon ECS']))
		expect(r.targets).not.toContain('Container registry')
	})
})
