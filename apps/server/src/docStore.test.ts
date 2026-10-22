import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocStore } from './docStore'

describe('DocStore', () => {
	it('bumps the version on change and ignores identical writes', () => {
		const s = new DocStore(null)
		expect(s.get().version).toBe(0)
		expect(s.set('A > B', 'web').ok).toBe(true)
		expect(s.get()).toMatchObject({ code: 'A > B', version: 1, source: 'web' })
		s.set('A > B', 'web')
		expect(s.get().version).toBe(1)
	})

	it('rejects stale baseVersion', () => {
		const s = new DocStore(null)
		s.set('A', 'web')
		const r = s.set('B', 'mcp', 0)
		expect(r.ok).toBe(false)
		expect(s.get().code).toBe('A')
		expect(s.set('B', 'mcp', 1).ok).toBe(true)
		expect(s.get().version).toBe(2)
	})

	it('notifies subscribers and supports unsubscribe', () => {
		const s = new DocStore(null)
		const events: unknown[] = []
		const off = s.subscribe((e) => events.push(e))
		s.set('X', 'agent')
		off()
		s.set('Y', 'agent')
		expect(events).toEqual([{ code: 'X', version: 1, source: 'agent' }])
	})

	it('persists to disk and reloads', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'octo-')), 'data', 'doc.json')
		const a = new DocStore(file)
		a.set('A > B', 'web')
		a.set('A > C', 'web')
		expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ code: 'A > C', version: 2 })
		const b = new DocStore(file)
		expect(b.get()).toMatchObject({ code: 'A > C', version: 2 })
	})
})
