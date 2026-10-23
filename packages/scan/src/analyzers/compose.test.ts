import { describe, expect, it } from 'vitest'
import { fixture, files } from '../test/helpers'
import { analyzeCompose } from './compose'

describe('compose analyzer', () => {
	it('reads services, deps, links, env hosts, ports, volumes and network groups', async () => {
		const r = analyzeCompose(await fixture('compose'))
		expect(r.confidence).toBe(0.9)
		const byKey = Object.fromEntries(r.root.nodes.map((n) => [n.key, n]))
		expect(byKey.db).toMatchObject({ icon: 'postgres', shape: 'cylinder', role: 'store', tech: 'postgres', parent: 'backend network' })
		expect(byKey.cache.icon).toBe('redis')
		expect(byKey.broker.icon).toBe('kafka')
		expect(byKey.proxy.icon).toBe('nginx')
		expect(byKey.api).toMatchObject({ icon: 'container', dir: 'api' })
		expect(byKey['pgdata volume']).toMatchObject({ shape: 'cylinder', label: 'pgdata' })
		expect(byKey['edge network'].isContainer).toBe(true)
		const edges = r.root.edges.map((e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`)
		expect(edges).toEqual(expect.arrayContaining(['proxy>web', 'proxy>api', 'api>db', 'api>broker', 'api>cache', 'worker>db', 'Internet>proxy::80, :443', 'db>pgdata volume']))
		// bind mounts are not volumes; env values never leak
		expect(r.root.nodes.some((n) => n.key.includes('local'))).toBe(false)
		expect(JSON.stringify(r)).not.toContain('supersecret')
	})

	it('skips network groups when services span several networks', () => {
		const r = analyzeCompose(files({ 'compose.yaml': 'services:\n  a: { image: redis, networks: [x, y] }\n  b: { image: mongo, networks: [x] }\nnetworks: { x: {}, y: {} }\n' }))
		expect(r.root.nodes.every((n) => !n.isContainer)).toBe(true)
		expect(r.root.nodes.find((n) => n.key === 'b')?.icon).toBe('mongodb')
		expect(r.notes.join(' ')).toMatch(/not drawn as groups/)
	})

	it('merges override files and ignores non-compose YAML', () => {
		const r = analyzeCompose(files({ 'docker-compose.yml': 'services:\n  api: { image: node:22 }\n', 'docker-compose.override.yml': 'services:\n  api:\n    ports: ["3000:3000"]\n', 'k8s.yaml': 'kind: Deployment' }))
		expect(r.root.nodes.filter((n) => n.key === 'api')).toHaveLength(1)
		expect(r.root.edges).toContainEqual(expect.objectContaining({ from: 'Internet', to: 'api', label: ':3000' }))
		expect(analyzeCompose(files({ 'a.yaml': 'x: 1' })).confidence).toBe(0)
	})
})
