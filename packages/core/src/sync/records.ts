/**
 * The sync view of an OctoDocument: the diagram code as one text (merged with
 * operational transform) plus a flat map of records merged last-writer-wins.
 *
 * Record ids:
 * - `meta`          → { title, theme?, meta? }
 * - `pin:<nodeKey>` → { x, y }
 * - `shape:<id>`    → { z, shape } (z orders the freehand layer, low to high)
 */

import type { Point } from '../ir'
import { createDocument, validateDocument, type DocTheme, type OctoDocument } from '../doc'
import type { FreeShape } from '../free'

export interface MetaRecord {
	title: string
	theme?: DocTheme
	meta?: Record<string, unknown>
}

export interface ShapeRecord {
	/** Stacking order; shapes render in ascending z (ties broken by id). */
	z: number
	shape: FreeShape
}

export type RecordValue = MetaRecord | Point | ShapeRecord

/** A record write; `value: null` deletes the record. */
export interface RecordChange {
	id: string
	value: RecordValue | null
}

export interface SyncState {
	code: string
	records: Map<string, RecordValue>
}

export const META_ID = 'meta'
export const pinId = (key: string) => `pin:${key}`
export const shapeId = (id: string) => `shape:${id}`

export type RecordKind = 'meta' | 'pin' | 'shape'

export function recordKind(id: string): RecordKind | null {
	if (id === META_ID) return 'meta'
	if (id.startsWith('pin:') && id.length > 4) return 'pin'
	if (id.startsWith('shape:') && id.length > 6) return 'shape'
	return null
}

const MAX_ID = 512

/** Validates one record write. Returns a list of problems (empty when valid). */
export function validateRecordChange(change: unknown): string[] {
	if (typeof change !== 'object' || change === null) return ['record change must be an object']
	const { id, value } = change as { id?: unknown; value?: unknown }
	if (typeof id !== 'string' || !id || id.length > MAX_ID) return ['record id must be a non-empty string']
	const kind = recordKind(id)
	if (!kind) return [`unknown record id ${JSON.stringify(id)}`]
	if (value === null) return kind === 'meta' ? ['meta cannot be deleted'] : []
	const now = new Date(0).toISOString()
	const doc: Record<string, unknown> = { ...createDocument({ id: 'v', createdAt: now }) }
	if (kind === 'meta') {
		if (typeof value !== 'object' || value === null) return ['meta must be an object']
		const m = value as Record<string, unknown>
		doc.title = m.title
		if (m.theme !== undefined) doc.theme = m.theme
		if (m.meta !== undefined) doc.meta = m.meta
	} else if (kind === 'pin') {
		if (id === 'pin:__proto__') return ['pin key "__proto__" is not allowed']
		doc.pins = { [id.slice(4)]: value }
	} else {
		if (typeof value !== 'object' || value === null) return ['shape record must be { z, shape }']
		const r = value as Record<string, unknown>
		if (typeof r.z !== 'number' || !Number.isFinite(r.z)) return ['shape record z must be a finite number']
		const shape = r.shape as { id?: unknown } | undefined
		if (typeof shape !== 'object' || shape === null) return ['shape record needs a shape']
		if (shape.id !== id.slice(6)) return [`shape id ${JSON.stringify(shape.id)} does not match record id ${JSON.stringify(id)}`]
		doc.shapes = [shape]
	}
	const r = validateDocument(doc)
	return r.ok ? [] : r.errors
}

/** Splits a document into its sync state. */
export function documentToSync(doc: OctoDocument): SyncState {
	const records = new Map<string, RecordValue>()
	const meta: MetaRecord = { title: doc.title }
	if (doc.theme) meta.theme = doc.theme
	if (doc.meta) meta.meta = doc.meta
	records.set(META_ID, meta)
	for (const [k, p] of Object.entries(doc.pins)) records.set(pinId(k), { x: p.x, y: p.y })
	doc.shapes.forEach((s, i) => records.set(shapeId(s.id), { z: i, shape: s }))
	return { code: doc.code, records }
}

/** Freehand shapes in stacking order. */
export function shapesFromRecords(records: ReadonlyMap<string, RecordValue>): FreeShape[] {
	const list: ShapeRecord[] = []
	for (const [id, v] of records) if (recordKind(id) === 'shape') list.push(v as ShapeRecord)
	list.sort((a, b) => a.z - b.z || (a.shape.id < b.shape.id ? -1 : a.shape.id > b.shape.id ? 1 : 0))
	return list.map((r) => r.shape)
}

export function pinsFromRecords(records: ReadonlyMap<string, RecordValue>): Record<string, Point> {
	const pins: Record<string, Point> = {}
	for (const [id, v] of records) if (recordKind(id) === 'pin') pins[id.slice(4)] = v as Point
	return pins
}

/** The z for a shape placed above every existing one. */
export function topZ(records: ReadonlyMap<string, RecordValue>): number {
	let z = -1
	for (const [id, v] of records) if (recordKind(id) === 'shape') z = Math.max(z, (v as ShapeRecord).z)
	return z + 1
}

/** Reassembles a document. `base` supplies the fields sync does not carry. */
export function syncToDocument(state: SyncState, base: Pick<OctoDocument, 'id' | 'createdAt' | 'updatedAt'>): OctoDocument {
	const meta = (state.records.get(META_ID) as MetaRecord | undefined) ?? { title: 'Untitled diagram' }
	return createDocument({
		id: base.id,
		createdAt: base.createdAt,
		updatedAt: base.updatedAt,
		title: meta.title,
		code: state.code,
		pins: pinsFromRecords(state.records),
		shapes: shapesFromRecords(state.records),
		theme: meta.theme,
		meta: meta.meta,
	})
}

/** Structural equality for JSON-like values (used to skip no-op writes). */
export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
	if (Array.isArray(a) !== Array.isArray(b)) return false
	const ka = Object.keys(a)
	const kb = Object.keys(b)
	if (ka.length !== kb.length) return false
	for (const k of ka) if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
	return true
}
