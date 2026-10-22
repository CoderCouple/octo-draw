/**
 * Presents a room through the old single-document `DocStore` interface, so the
 * existing `/api/doc` REST + SSE routes (current web app, MCP) keep working on
 * top of live sync. `version` is the room clock.
 */

import type { Origin } from '@octo-draw/core/src/sync'
import type { Doc, DocEvent, SetResult } from '../docStore'
import type { Room } from './room'

/** What the HTTP routes need from a document store. */
export interface DocStoreLike {
	get(): Doc
	set(code: string, source?: string, baseVersion?: number): SetResult
	subscribe(fn: (e: DocEvent) => void): () => void
	readonly subscriberCount: number
	/**
	 * Optional: a writer for a streaming agent that started from `baseCode`.
	 * Each write merges with concurrent edits instead of overwriting them.
	 */
	writer?(source: string, baseCode: string): (next: string) => void
}

/** `web:*` sources are people at the editor; everything else counts as an agent. */
export function originFromSource(source: string): Origin {
	const name = source.slice(0, 100) || 'unknown'
	return { kind: source.startsWith('web') || source.startsWith('human') ? 'human' : 'agent', name }
}

export class RoomDocStore implements DocStoreLike {
	constructor(readonly room: Room) {}

	get(): Doc {
		return { code: this.room.code, version: this.room.clock, source: this.room.lastCodeOrigin.name, updatedAt: this.room.updatedAt }
	}

	/**
	 * Replaces the code. With `baseVersion`, fails if the *code* changed after
	 * that clock (pin/shape edits by others do not cause conflicts).
	 */
	set(code: string, source = 'unknown', baseVersion?: number): SetResult {
		if (baseVersion !== undefined && this.room.codeClock > baseVersion) return { ok: false, conflict: true, doc: this.get() }
		this.room.setCode(code, originFromSource(source), source)
		return { ok: true, doc: this.get() }
	}

	subscribe(fn: (e: DocEvent) => void): () => void {
		return this.room.subscribe((e) => {
			if (e.codeChanged) fn({ code: e.code, version: e.clock, source: e.origin.name })
		})
	}

	get subscriberCount(): number {
		return this.room.listenerCount
	}

	writer(source: string, baseCode: string): (next: string) => void {
		const w = this.room.textWriter(originFromSource(source), baseCode, source)
		return (next) => {
			w.write(next)
		}
	}
}
