/** Rooms keyed by document id, loaded on demand from `<dir>/<id>.json`. */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OctoDocument } from '@octo-draw/core'
import { isValidDocId } from '@octo-draw/core/src/sync'
import { Room, type RoomOptions } from './room'

export const DEFAULT_DOC_ID = 'default'

export interface RoomManagerOptions {
	/** Folder for `<id>.json` + `<id>.log.jsonl`; null keeps everything in memory. */
	dir: string | null
	/** Unload rooms with no sessions/subscribers after this long. Default 60 s (0 = never). */
	idleMs?: number
	room?: Omit<RoomOptions, 'id' | 'file' | 'logFile'>
	/** Seed for a room that does not exist yet (e.g. migrate the legacy single doc into `default`). */
	seed?: (id: string) => OctoDocument | undefined
}

export class RoomManager {
	private rooms = new Map<string, Room>()
	private idleTimer: ReturnType<typeof setInterval> | undefined
	private idleSince = new Map<string, number>()

	constructor(private opts: RoomManagerOptions) {
		const idle = opts.idleMs ?? 60000
		if (idle > 0) {
			this.idleTimer = setInterval(() => this.sweep(idle), Math.min(idle, 30000))
			this.idleTimer.unref?.()
		}
	}

	/** Gets (loading or creating) a room. Throws on an invalid id. */
	get(id: string): Room {
		if (!isValidDocId(id)) throw new Error(`invalid document id ${JSON.stringify(id)}`)
		let room = this.rooms.get(id)
		if (!room) {
			const dir = this.opts.dir
			room = new Room(
				{ ...this.opts.room, id, file: dir ? join(dir, `${id}.json`) : null, logFile: dir ? join(dir, `${id}.log.jsonl`) : null },
				this.opts.seed?.(id),
			)
			this.rooms.set(id, room)
		}
		this.idleSince.delete(id)
		return room
	}

	/** Loaded rooms plus documents on disk. */
	list(): string[] {
		const ids = new Set(this.rooms.keys())
		if (this.opts.dir) {
			try {
				for (const f of readdirSync(this.opts.dir)) {
					const m = /^(.+)\.json$/.exec(f)
					if (m && isValidDocId(m[1])) ids.add(m[1])
				}
			} catch {
				// folder does not exist yet
			}
		}
		return [...ids].sort()
	}

	loaded(id: string): Room | undefined {
		return this.rooms.get(id)
	}

	private sweep(idleMs: number) {
		const now = Date.now()
		for (const [id, room] of this.rooms) {
			if (id === DEFAULT_DOC_ID || room.sessions.size || room.listenerCount) {
				this.idleSince.delete(id)
				continue
			}
			const since = this.idleSince.get(id)
			if (since === undefined) this.idleSince.set(id, now)
			else if (now - since >= idleMs) {
				room.dispose()
				this.rooms.delete(id)
				this.idleSince.delete(id)
			}
		}
	}

	flushAll() {
		for (const r of this.rooms.values()) r.flush()
	}

	close() {
		clearInterval(this.idleTimer)
		for (const r of this.rooms.values()) r.dispose()
		this.rooms.clear()
	}
}
