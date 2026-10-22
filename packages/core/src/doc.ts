/**
 * OctoDocument — the stable, versioned on-disk / in-database document format.
 *
 * A document is the diagram code (source of truth for the diagram), plus the
 * canvas state that is not code: positions the user pinned by dragging, the
 * freehand drawing layer, and display preferences. Layout is NOT stored; it
 * is recomputed from `code` + `pins` (so documents stay small and diffable).
 *
 * Rules for evolving the format:
 * - Adding an optional field does not need a new version.
 * - Anything else bumps `version`, adds a case to `migrateDocument`, and
 *   keeps every older version loadable.
 */

import type { Point } from './ir'
import { FREE_SHAPE_TYPES, type FreeShape } from './free'

export const DOCUMENT_VERSION = 1 as const

export type Appearance = 'light' | 'dark' | 'system'

export interface DocTheme {
	/** Preferred canvas appearance. Absent means follow the host. */
	appearance?: Appearance
	/** Canvas background pattern. */
	grid?: 'dots' | 'none'
}

export interface OctoDocument {
	version: typeof DOCUMENT_VERSION
	/** Stable id (uuid-like). Hosts may use their own id instead and ignore this. */
	id: string
	title: string
	/** Language of `code`. Only `octo` today; other values are reserved. */
	format: 'octo'
	/** Diagram source in octo DSL. */
	code: string
	/** User-dragged top-left positions, keyed by node key. */
	pins: Record<string, Point>
	/** Freehand layer (not part of the code). */
	shapes: FreeShape[]
	theme?: DocTheme
	/** ISO 8601 timestamps. */
	createdAt: string
	updatedAt: string
	/** Host-specific extra data; preserved, never interpreted. */
	meta?: Record<string, unknown>
}

function newId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	if (c?.randomUUID) return c.randomUUID()
	return 'doc-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** A fresh, valid document. */
export function createDocument(init: Partial<Omit<OctoDocument, 'version' | 'format'>> = {}): OctoDocument {
	const now = new Date().toISOString()
	const doc: OctoDocument = {
		version: DOCUMENT_VERSION,
		id: init.id ?? newId(),
		title: init.title ?? 'Untitled diagram',
		format: 'octo',
		code: init.code ?? '',
		pins: init.pins ?? {},
		shapes: init.shapes ?? [],
		createdAt: init.createdAt ?? now,
		updatedAt: init.updatedAt ?? init.createdAt ?? now,
	}
	if (init.theme) doc.theme = init.theme
	if (init.meta) doc.meta = init.meta
	return doc
}

// ---------------------------------------------------------------------------
// Validation (hand-written so core stays dependency-free)

export type ValidationResult = { ok: true; doc: OctoDocument } | { ok: false; errors: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isIso = (v: unknown) => isStr(v) && !Number.isNaN(Date.parse(v))

function checkPoint(v: unknown, path: string, errors: string[]) {
	if (!isObj(v) || !isNum(v.x) || !isNum(v.y)) errors.push(`${path} must be { x: number, y: number }`)
}

function checkShape(s: unknown, path: string, errors: string[]) {
	if (!isObj(s)) {
		errors.push(`${path} must be an object`)
		return
	}
	if (!isStr(s.id) || !s.id) errors.push(`${path}.id must be a non-empty string`)
	if (!(FREE_SHAPE_TYPES as readonly unknown[]).includes(s.type)) errors.push(`${path}.type must be one of ${FREE_SHAPE_TYPES.join(', ')}`)
	for (const k of ['x', 'y', 'w', 'h', 'size'] as const) if (!isNum(s[k])) errors.push(`${path}.${k} must be a finite number`)
	if (!isStr(s.color)) errors.push(`${path}.color must be a string`)
	if (s.text !== undefined && !isStr(s.text)) errors.push(`${path}.text must be a string`)
	if (s.pressure !== undefined && typeof s.pressure !== 'boolean') errors.push(`${path}.pressure must be a boolean`)
	if (s.src !== undefined && !isStr(s.src)) errors.push(`${path}.src must be a string`)
	if (s.scale !== undefined && !isNum(s.scale)) errors.push(`${path}.scale must be a finite number`)
	if (s.meta !== undefined && !isObj(s.meta)) errors.push(`${path}.meta must be an object`)
	if (s.points !== undefined) {
		if (!Array.isArray(s.points)) errors.push(`${path}.points must be an array`)
		else
			s.points.forEach((p, i) => {
				if (!Array.isArray(p) || p.length !== 3 || !p.every(isNum)) errors.push(`${path}.points[${i}] must be [x, y, pressure]`)
			})
	}
	if ((s.type === 'pen' || s.type === 'arrow') && !Array.isArray(s.points)) errors.push(`${path}.points is required for ${s.type}`)
	if (s.type === 'arrow' && Array.isArray(s.points) && s.points.length !== 2) errors.push(`${path}.points must have exactly 2 points for arrow`)
}

/**
 * Checks that `value` is a valid current-version document. Returns every
 * problem found (not just the first). Does not migrate; see `migrateDocument`.
 */
export function validateDocument(value: unknown): ValidationResult {
	const errors: string[] = []
	if (!isObj(value)) return { ok: false, errors: ['document must be an object'] }
	const d = value
	if (d.version !== DOCUMENT_VERSION) errors.push(`version must be ${DOCUMENT_VERSION}`)
	if (!isStr(d.id) || !d.id) errors.push('id must be a non-empty string')
	if (!isStr(d.title)) errors.push('title must be a string')
	if (d.format !== 'octo') errors.push('format must be "octo"')
	if (!isStr(d.code)) errors.push('code must be a string')
	if (!isObj(d.pins)) errors.push('pins must be an object')
	else for (const [k, p] of Object.entries(d.pins)) checkPoint(p, `pins[${JSON.stringify(k)}]`, errors)
	if (!Array.isArray(d.shapes)) errors.push('shapes must be an array')
	else {
		d.shapes.forEach((s, i) => checkShape(s, `shapes[${i}]`, errors))
		const ids = new Set<unknown>()
		for (const s of d.shapes as { id?: unknown }[]) {
			if (isObj(s) && ids.has(s.id)) errors.push(`shapes: duplicate id ${JSON.stringify(s.id)}`)
			if (isObj(s)) ids.add(s.id)
		}
	}
	if (d.theme !== undefined) {
		if (!isObj(d.theme)) errors.push('theme must be an object')
		else {
			const t = d.theme
			if (t.appearance !== undefined && !['light', 'dark', 'system'].includes(t.appearance as string)) errors.push('theme.appearance must be light, dark or system')
			if (t.grid !== undefined && !['dots', 'none'].includes(t.grid as string)) errors.push('theme.grid must be dots or none')
		}
	}
	if (!isIso(d.createdAt)) errors.push('createdAt must be an ISO date string')
	if (!isIso(d.updatedAt)) errors.push('updatedAt must be an ISO date string')
	if (d.meta !== undefined && !isObj(d.meta)) errors.push('meta must be an object')
	return errors.length ? { ok: false, errors } : { ok: true, doc: d as unknown as OctoDocument }
}

// ---------------------------------------------------------------------------
// Migration

export class DocumentError extends Error {
	constructor(
		message: string,
		public errors: string[] = [],
	) {
		super(errors.length ? `${message}: ${errors.join('; ')}` : message)
	}
}

/**
 * Detects the version of `value` and upgrades it to the current format.
 *
 * - v0: the web app's original localStorage shape `{ code, title?, shapes?, pins? }`
 *   (no `format` field; a numeric `version` there is a server revision, not a format version).
 * - v1: current.
 *
 * Throws `DocumentError` for unknown versions or invalid content. Never mutates `value`.
 */
export function migrateDocument(value: unknown): OctoDocument {
	if (!isObj(value)) throw new DocumentError('document must be an object')
	const version = value.format === undefined ? 0 : value.version
	let doc: Record<string, unknown>
	switch (version) {
		case 0: {
			if (!isStr(value.code)) throw new DocumentError('not an octo document (missing "code")')
			const at = isIso(value.updatedAt) ? (value.updatedAt as string) : new Date().toISOString()
			doc = {
				...createDocument({ createdAt: at, updatedAt: at }),
				title: isStr(value.title) ? value.title : 'Untitled diagram',
				code: value.code,
				pins: isObj(value.pins) ? value.pins : {},
				shapes: Array.isArray(value.shapes) ? value.shapes : Array.isArray(value.drawing) ? value.drawing : [],
			}
			break
		}
		case 1:
			doc = { ...value }
			break
		default:
			throw new DocumentError(`unsupported document version ${JSON.stringify(value.version)} (this build reads up to ${DOCUMENT_VERSION})`)
	}
	const r = validateDocument(doc)
	if (!r.ok) throw new DocumentError('invalid document', r.errors)
	return r.doc
}

/** Parses JSON text into a current-version document (migrating older versions). */
export function parseDocument(json: string): OctoDocument {
	let v: unknown
	try {
		v = JSON.parse(json)
	} catch (err) {
		throw new DocumentError(`not valid JSON (${(err as Error).message})`)
	}
	return migrateDocument(v)
}

/** Canonical JSON text for a document (tab-indented, stable key order). */
export function serializeDocument(doc: OctoDocument): string {
	const ordered: Record<string, unknown> = {
		version: doc.version,
		id: doc.id,
		title: doc.title,
		format: doc.format,
		code: doc.code,
		pins: doc.pins,
		shapes: doc.shapes,
	}
	if (doc.theme) ordered.theme = doc.theme
	ordered.createdAt = doc.createdAt
	ordered.updatedAt = doc.updatedAt
	if (doc.meta) ordered.meta = doc.meta
	return JSON.stringify(ordered, null, '\t') + '\n'
}

// ---------------------------------------------------------------------------
// JSON Schema (draft 2020-12) — for editors, other languages and API docs.

const point = { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } }

export const OCTO_DOCUMENT_SCHEMA = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	$id: 'https://octo-draw.dev/schema/document-v1.json',
	title: 'OctoDocument',
	description: 'An octo-draw diagram document (format version 1).',
	type: 'object',
	required: ['version', 'id', 'title', 'format', 'code', 'pins', 'shapes', 'createdAt', 'updatedAt'],
	properties: {
		version: { const: 1 },
		id: { type: 'string', minLength: 1 },
		title: { type: 'string' },
		format: { const: 'octo' },
		code: { type: 'string', description: 'Diagram source in octo DSL' },
		pins: { type: 'object', additionalProperties: point, description: 'Pinned top-left positions by node key' },
		shapes: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'type', 'x', 'y', 'w', 'h', 'color', 'size'],
				properties: {
					id: { type: 'string', minLength: 1 },
					type: { enum: [...FREE_SHAPE_TYPES] },
					x: { type: 'number' },
					y: { type: 'number' },
					w: { type: 'number' },
					h: { type: 'number' },
					points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } },
					color: { type: 'string' },
					size: { type: 'number' },
					text: { type: 'string' },
					pressure: { type: 'boolean' },
					src: { type: 'string', description: 'image: URL or data URL' },
					scale: { type: 'number', description: 'text: font scale from resizing' },
					meta: { type: 'object' },
				},
			},
		},
		theme: {
			type: 'object',
			properties: {
				appearance: { enum: ['light', 'dark', 'system'] },
				grid: { enum: ['dots', 'none'] },
			},
		},
		createdAt: { type: 'string', format: 'date-time' },
		updatedAt: { type: 'string', format: 'date-time' },
		meta: { type: 'object' },
	},
} as const
