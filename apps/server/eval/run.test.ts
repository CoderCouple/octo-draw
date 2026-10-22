import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { check, toRegex } from './run'

const { cases } = JSON.parse(readFileSync(join(import.meta.dirname, 'cases.json'), 'utf8')) as {
	cases: { id: string; kind: string; prompt: string; code?: string; expect: Record<string, unknown> }[]
}

describe('eval harness (offline)', () => {
	it('has 18 well-formed cases with compiling regexes', () => {
		expect(cases).toHaveLength(18)
		expect(new Set(cases.map((c) => c.id)).size).toBe(18)
		const strings = JSON.stringify(cases.map((c) => c.expect)).match(/"\/(?:[^"\\]|\\.)*\/[a-z]*"/g) ?? []
		for (const s of strings) expect(() => toRegex(JSON.parse(s))).not.toThrow()
	})

	it('scores an ideal and a bad answer for the cache case', () => {
		const c = cases.find((x) => x.id === 'agent-cache-between')!
		const good = 'direction right\nDB [shape: cylinder]\nCache [icon: database]\nUsers > API\nAPI > Cache\nCache > DB\n'
		expect(check(c.expect, good, c.code!, '')).toEqual([])
		const bad = check(c.expect, c.code!, c.code!, '')
		expect(bad.some((f) => /cache/i.test(f))).toBe(true)
		expect(bad.some((f) => /should be gone/.test(f))).toBe(true)
	})

	it('checks diagram kind and ERD fields', () => {
		const c = cases.find((x) => x.id === 'gen-erd-blog')!
		const good = 'erd\nusers {\n  id string pk\n}\nposts {\n  id string pk\n  authorId string fk\n}\ncomments {\n  id string pk\n}\ntags {\n  id string pk\n}\nusers.id < posts.authorId\n'
		expect(check(c.expect, good, '', '')).toEqual([])
		expect(check(c.expect, 'users > posts\ncomments\ntags\n', '', '').some((f) => /kind/.test(f))).toBe(true)
	})

	it('checks explain answers without touching the code', () => {
		const c = cases.find((x) => x.id === 'explain-spof')!
		expect(check(c.expect, c.code!, c.code!, 'The DB is the single point of failure.')).toEqual([])
		expect(check(c.expect, 'X > Y', c.code!, 'nothing')).toHaveLength(2)
	})
})
