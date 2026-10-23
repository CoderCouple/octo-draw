import { describe, expect, it } from 'vitest'
import { fixture } from '../test/helpers'
import { analyzeK8s } from './k8s'

describe('kubernetes analyzer', () => {
	it('groups workloads by namespace and links services, ingresses, config and HPAs', async () => {
		const r = analyzeK8s(await fixture('k8s'))
		expect(r.confidence).toBe(0.85)
		const byKey = Object.fromEntries(r.root.nodes.map((n) => [n.key, n]))
		expect(byKey.api).toMatchObject({ parent: 'ns shop', role: 'service' })
		expect(byKey.postgres).toMatchObject({ icon: 'postgres', shape: 'cylinder' })
		expect(byKey['nightly-report']).toMatchObject({ parent: 'ns jobs', icon: 'scheduler' })
		const edges = r.root.edges.map((e) => `${e.from}>${e.to}`)
		expect(edges).toEqual(expect.arrayContaining(['svc api>api', 'svc postgres>postgres', 'ingress public>svc api', 'ingress public>svc web', 'Internet>ingress public', 'Internet>svc lb', 'svc lb>api', 'hpa api>api', 'api>cm api-config', 'api>secret db-credentials', 'postgres>secret db-credentials', 'postgres>pvc pg-data']))
		expect(r.root.edges.find((e) => e.from === 'hpa api')?.label).toBe('2–10')
		expect(r.warnings.join(' ')).toMatch(/templated YAML/)
	})

	it('never outputs secret values', async () => {
		const r = analyzeK8s(await fixture('k8s'))
		expect(JSON.stringify(r)).not.toContain('aHVudGVy')
	})
})
