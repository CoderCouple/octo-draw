/** Single shared diagram document, persisted to JSON, with change subscribers. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Doc {
	code: string
	version: number
	source: string
	updatedAt: string
}

export type DocEvent = Pick<Doc, 'code' | 'version' | 'source'>

export type SetResult = { ok: true; doc: Doc } | { ok: false; conflict: true; doc: Doc }

export class DocStore {
	private doc: Doc = { code: '', version: 0, source: 'init', updatedAt: new Date(0).toISOString() }
	private listeners = new Set<(e: DocEvent) => void>()

	/** `file` null = in-memory only. */
	constructor(private file: string | null) {
		if (file) this.load(file)
	}

	get(): Doc {
		return { ...this.doc }
	}

	/**
	 * Replace the code. If `baseVersion` is given and is not the current
	 * version, nothing changes and a conflict is returned. Setting identical
	 * code is a no-op (no version bump, no broadcast).
	 */
	set(code: string, source = 'unknown', baseVersion?: number): SetResult {
		if (baseVersion !== undefined && baseVersion !== this.doc.version) {
			return { ok: false, conflict: true, doc: this.get() }
		}
		if (code === this.doc.code) return { ok: true, doc: this.get() }
		this.doc = { code, version: this.doc.version + 1, source, updatedAt: new Date().toISOString() }
		this.save()
		const event: DocEvent = { code, version: this.doc.version, source }
		for (const fn of this.listeners) {
			try {
				fn(event)
			} catch {
				// a broken subscriber must not break the writer
			}
		}
		return { ok: true, doc: this.get() }
	}

	subscribe(fn: (e: DocEvent) => void): () => void {
		this.listeners.add(fn)
		return () => this.listeners.delete(fn)
	}

	get subscriberCount(): number {
		return this.listeners.size
	}

	private load(file: string) {
		try {
			const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Doc>
			if (typeof raw.code === 'string' && typeof raw.version === 'number') {
				this.doc = {
					code: raw.code,
					version: raw.version,
					source: typeof raw.source === 'string' ? raw.source : 'disk',
					updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
				}
			}
		} catch {
			// missing or corrupt file: start empty
		}
	}

	private save() {
		if (!this.file) return
		try {
			mkdirSync(dirname(this.file), { recursive: true })
			const tmp = `${this.file}.tmp`
			writeFileSync(tmp, JSON.stringify(this.doc, null, '\t'))
			renameSync(tmp, this.file)
		} catch (err) {
			console.error('[octo-draw] failed to persist doc:', err)
		}
	}
}
