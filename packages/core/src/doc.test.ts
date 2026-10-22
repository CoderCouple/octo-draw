import { describe, expect, it } from 'vitest'
import {
	createDocument,
	DocumentError,
	migrateDocument,
	OCTO_DOCUMENT_SCHEMA,
	parseDocument,
	serializeDocument,
	validateDocument,
} from './doc'
import type { FreeShape } from './free'

const pen: FreeShape = { id: 'p1', type: 'pen', x: 0, y: 0, w: 0, h: 0, points: [[1, 2, 0.5], [3, 4, 0.5]], color: 'ink', size: 2 }

describe('createDocument / validateDocument', () => {
	it('creates a valid document', () => {
		const doc = createDocument({ code: 'A > B', title: 'T' })
		expect(doc.version).toBe(1)
		expect(doc.format).toBe('octo')
		expect(doc.id).toBeTruthy()
		expect(validateDocument(doc)).toEqual({ ok: true, doc })
	})

	it('reports every problem', () => {
		const r = validateDocument({ version: 1, id: '', title: 3, format: 'octo', code: 'x', pins: { A: { x: 'no' } }, shapes: [{ id: 's', type: 'blob' }], createdAt: 'nope', updatedAt: new Date().toISOString() })
		expect(r.ok).toBe(false)
		if (r.ok) return
		expect(r.errors).toEqual(
			expect.arrayContaining([
				'id must be a non-empty string',
				'title must be a string',
				'pins["A"] must be { x: number, y: number }',
				expect.stringContaining('shapes[0].type must be one of'),
				'shapes[0].x must be a finite number',
				'createdAt must be an ISO date string',
			]),
		)
	})

	it('validates free shapes', () => {
		const ok = createDocument({ shapes: [pen, { id: 'a', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [[0, 0, 0.5], [9, 9, 0.5]], color: '#ff0000', size: 1 }] })
		expect(validateDocument(ok).ok).toBe(true)
		const bad = createDocument({ shapes: [{ ...pen, points: undefined }, { ...pen, points: [[1, 2]] as never }, pen] })
		const r = validateDocument(bad)
		expect(r.ok).toBe(false)
		if (!r.ok) {
			expect(r.errors).toContain('shapes[0].points is required for pen')
			expect(r.errors).toContain('shapes[1].points[0] must be [x, y, pressure]')
			expect(r.errors).toContain('shapes: duplicate id "p1"')
		}
	})

	it('validates theme', () => {
		expect(validateDocument(createDocument({ theme: { appearance: 'dark', grid: 'none' } })).ok).toBe(true)
		expect(validateDocument({ ...createDocument(), theme: { appearance: 'blue' } }).ok).toBe(false)
	})
})

describe('migrateDocument', () => {
	it('upgrades the v0 localStorage shape', () => {
		const doc = migrateDocument({ code: 'A > B', title: 'Old', shapes: [pen], pins: { A: { x: 1, y: 2 } } })
		expect(doc).toMatchObject({ version: 1, format: 'octo', code: 'A > B', title: 'Old', shapes: [pen], pins: { A: { x: 1, y: 2 } } })
	})

	it('treats a server doc (numeric revision, no format) as v0', () => {
		const doc = migrateDocument({ code: 'X', version: 42, source: 'web', updatedAt: '2026-01-01T00:00:00.000Z' })
		expect(doc.version).toBe(1)
		expect(doc.updatedAt).toBe('2026-01-01T00:00:00.000Z')
		expect(doc.title).toBe('Untitled diagram')
	})

	it('passes v1 through and keeps unknown meta', () => {
		const v1 = createDocument({ code: 'A', meta: { host: { id: 7 } } })
		expect(migrateDocument(v1)).toEqual(v1)
	})

	it('rejects future versions and junk', () => {
		expect(() => migrateDocument({ ...createDocument(), version: 99 })).toThrow(/unsupported document version 99/)
		expect(() => migrateDocument('x')).toThrow(DocumentError)
		expect(() => migrateDocument({ title: 'no code' })).toThrow(/missing "code"/)
		expect(() => migrateDocument({ ...createDocument(), pins: [] })).toThrow(/pins must be an object/)
	})

	it('does not mutate its input', () => {
		const input = { code: 'A', shapes: [] }
		migrateDocument(input)
		expect(input).toEqual({ code: 'A', shapes: [] })
	})
})

describe('serialize / parse', () => {
	it('round-trips', () => {
		const doc = createDocument({ code: 'A > B\n', shapes: [pen], theme: { grid: 'dots' } })
		const text = serializeDocument(doc)
		expect(text.startsWith('{\n\t"version": 1,')).toBe(true)
		expect(parseDocument(text)).toEqual(doc)
	})

	it('reports bad JSON', () => {
		expect(() => parseDocument('{')).toThrow(/not valid JSON/)
	})
})

describe('JSON schema', () => {
	it('lists the same required keys a created document has', () => {
		const doc = createDocument()
		for (const k of OCTO_DOCUMENT_SCHEMA.required) expect(doc).toHaveProperty(k)
		expect(Object.keys(OCTO_DOCUMENT_SCHEMA.properties).sort()).toEqual(
			['version', 'id', 'title', 'format', 'code', 'pins', 'shapes', 'theme', 'createdAt', 'updatedAt', 'meta'].sort(),
		)
	})
})
