/**
 * A room is the authoritative copy of one document. Every write (WebSocket
 * push, REST adapter, server-side agent) goes through `commit`, which assigns
 * the next clock, records attribution and broadcasts to every session.
 *
 * - Code: plain-text OT. A push made against `baseClock` is transformed past
 *   every code op committed after it (the server's op wins insert ties).
 * - Records (meta, pins, shapes): last-writer-wins per record, in commit order.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyActions, createDocument, migrateDocument, validateDocument, type AgentAction, type ApplyResult, type OctoDocument } from '@octo-draw/core'
import {
	apply,
	baseLength,
	diffText,
	documentToSync,
	invert,
	isNoop,
	isTextOp,
	jsonEqual,
	syncToDocument,
	transform,
	validateRecordChange,
	type AckMessage,
	type ChangeMessage,
	type HelloMessage,
	type Origin,
	type PeerPresence,
	type Presence,
	type PushMessage,
	type RecordChange,
	type RecordValue,
	type ServerMessage,
	type TextOp,
} from '@octo-draw/core/src/sync'

export interface Session {
	id: string
	clientId: string
	origin: Origin
	send(msg: ServerMessage): void
	presence?: Presence | null
}

/** One committed change: who did what (and how to undo it). */
export interface AttributionEntry {
	clock: number
	at: string
	clientId: string
	origin: Origin
	/** Applied op and its inverse (apply `inverse` to the text right after this clock to undo). */
	code?: { op: TextOp; inverse: TextOp }
	records?: { id: string; before: RecordValue | null; after: RecordValue | null }[]
}

/** Fired after every commit (used by the REST/SSE adapter). */
export interface CommitEvent {
	clock: number
	origin: Origin
	clientId: string
	codeChanged: boolean
	code: string
	records: RecordChange[]
}

export interface RoomOptions {
	id: string
	/** JSON file for the document (null = memory only). */
	file?: string | null
	/** JSONL attribution log (null = memory only). */
	logFile?: string | null
	saveDelayMs?: number
	/** Code ops kept for transforming late pushes. Older bases get a `resync`. */
	historyLimit?: number
	/** Deleted-record clocks kept for delta reconnects. */
	tombstoneLimit?: number
	/** Attribution entries kept in memory. */
	logLimit?: number
}

interface RoomFile {
	format: 'octo-room'
	version: 1
	clock: number
	codeClock: number
	clients: Record<string, number>
	recordClocks: [string, number][]
	tombstoneHorizon: number
	document: OctoDocument
}

export class Room {
	readonly id: string
	clock = 0
	/** Clock of the last code change. */
	codeClock = 0
	/** Who made the last code change. */
	lastCodeOrigin: Origin = { kind: 'human', name: 'init' }
	code = ''
	readonly records = new Map<string, RecordValue>()
	private recordClocks = new Map<string, number>()
	private tombstoneHorizon = 0
	private history: { clock: number; op: TextOp }[] = []
	/** Pushes with baseClock below this cannot be transformed any more. */
	private historyStart = 0
	private clients = new Map<string, number>()
	private docId: string
	private createdAt: string
	updatedAt: string
	private log: AttributionEntry[] = []
	readonly sessions = new Map<string, Session>()
	private listeners = new Set<(e: CommitEvent) => void>()
	private saveTimer: ReturnType<typeof setTimeout> | undefined
	private file: string | null
	private logFile: string | null
	private saveDelayMs: number
	private historyLimit: number
	private tombstoneLimit: number
	private logLimit: number

	constructor(opts: RoomOptions, initial?: OctoDocument) {
		this.id = opts.id
		this.file = opts.file ?? null
		this.logFile = opts.logFile ?? null
		this.saveDelayMs = opts.saveDelayMs ?? 200
		this.historyLimit = opts.historyLimit ?? 2000
		this.tombstoneLimit = opts.tombstoneLimit ?? 5000
		this.logLimit = opts.logLimit ?? 5000
		const doc = (this.file && this.load(this.file)) || initial || createDocument({ id: opts.id })
		this.useDocument(doc)
		this.docId = doc.id
		this.createdAt = doc.createdAt
		this.updatedAt = doc.updatedAt
		this.historyStart = this.clock
	}

	private useDocument(doc: OctoDocument) {
		const s = documentToSync(doc)
		this.code = s.code
		this.records.clear()
		for (const [k, v] of s.records) this.records.set(k, v)
	}

	// ---- persistence

	private load(file: string): OctoDocument | null {
		let raw: unknown
		try {
			raw = JSON.parse(readFileSync(file, 'utf8'))
		} catch {
			return null
		}
		try {
			const r = raw as Partial<RoomFile>
			if (r && r.format === 'octo-room') {
				const doc = migrateDocument(r.document)
				this.useDocument(doc)
				this.clock = Number.isSafeInteger(r.clock) ? (r.clock as number) : 0
				this.codeClock = Number.isSafeInteger(r.codeClock) ? (r.codeClock as number) : this.clock
				this.tombstoneHorizon = Number.isSafeInteger(r.tombstoneHorizon) ? (r.tombstoneHorizon as number) : 0
				for (const [k, v] of Object.entries(r.clients ?? {})) if (typeof v === 'number') this.clients.set(k, v)
				for (const e of r.recordClocks ?? []) if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number') this.recordClocks.set(e[0], e[1])
				return doc
			}
			// a plain OctoDocument (or the legacy { code } shape) dropped into the folder
			const doc = migrateDocument(raw)
			this.useDocument(doc)
			return doc
		} catch (err) {
			console.error(`[octo-draw] room ${this.id}: cannot load ${file}:`, (err as Error).message)
			return null
		}
	}

	/** The current document. */
	snapshot(): OctoDocument {
		return syncToDocument({ code: this.code, records: this.records }, { id: this.docId, createdAt: this.createdAt, updatedAt: this.updatedAt })
	}

	private scheduleSave() {
		if (!this.file || this.saveTimer) return
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined
			this.save()
		}, this.saveDelayMs)
	}

	/** Writes pending changes now. */
	flush() {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer)
			this.saveTimer = undefined
			this.save()
		}
	}

	private save() {
		if (!this.file) return
		const document = this.snapshot()
		const v = validateDocument(document)
		if (!v.ok) {
			console.error(`[octo-draw] room ${this.id}: refusing to save invalid document:`, v.errors.join('; '))
			return
		}
		const data: RoomFile = {
			format: 'octo-room',
			version: 1,
			clock: this.clock,
			codeClock: this.codeClock,
			clients: Object.fromEntries(this.clients),
			recordClocks: [...this.recordClocks],
			tombstoneHorizon: this.tombstoneHorizon,
			document,
		}
		try {
			mkdirSync(dirname(this.file), { recursive: true })
			const tmp = `${this.file}.${process.pid}.tmp`
			writeFileSync(tmp, JSON.stringify(data, null, '\t'))
			renameSync(tmp, this.file)
		} catch (err) {
			console.error(`[octo-draw] room ${this.id}: failed to persist:`, err)
		}
	}

	// ---- sessions

	join(session: Session, lastClock: number): HelloMessage {
		this.sessions.set(session.id, session)
		const full = !(lastClock > 0 && lastClock <= this.clock && lastClock >= this.tombstoneHorizon)
		const records: RecordChange[] = []
		if (full) for (const [id, value] of this.records) records.push({ id, value })
		else
			for (const [id, c] of this.recordClocks) {
				if (c <= lastClock) continue
				records.push({ id, value: this.records.get(id) ?? null })
			}
		const peers: PeerPresence[] = []
		for (const s of this.sessions.values()) if (s.id !== session.id && s.presence) peers.push({ sessionId: s.id, clientId: s.clientId, origin: s.origin, state: s.presence })
		const hello: HelloMessage = {
			t: 'hello',
			docId: this.id,
			sessionId: session.id,
			clock: this.clock,
			clientSeq: this.clients.get(session.clientId) ?? 0,
			code: this.code,
			full,
			records,
			peers,
		}
		session.send(hello)
		return hello
	}

	leave(sessionId: string) {
		const s = this.sessions.get(sessionId)
		if (!s) return
		this.sessions.delete(sessionId)
		if (s.presence) this.broadcast({ t: 'presence', sessionId, clientId: s.clientId, origin: s.origin, state: null }, sessionId)
	}

	setPresence(sessionId: string, state: Presence | null) {
		const s = this.sessions.get(sessionId)
		if (!s) return
		if (state === null && !s.presence) return
		s.presence = state
		this.broadcast({ t: 'presence', sessionId, clientId: s.clientId, origin: s.origin, state }, sessionId)
	}

	private broadcast(msg: ServerMessage, exceptSessionId?: string) {
		for (const s of this.sessions.values()) {
			if (s.id === exceptSessionId) continue
			try {
				s.send(msg)
			} catch {
				// a broken socket is cleaned up by its close handler
			}
		}
	}

	subscribe(fn: (e: CommitEvent) => void): () => void {
		this.listeners.add(fn)
		return () => this.listeners.delete(fn)
	}

	get listenerCount() {
		return this.listeners.size
	}

	// ---- writes

	/** Handles a client push. Sends the ack to the pusher and the change to everyone else. */
	push(session: Session, msg: PushMessage) {
		const last = this.clients.get(session.clientId) ?? 0
		if (!Number.isSafeInteger(msg.seq) || msg.seq <= 0) throw new RoomError('bad_message', 'push seq must be a positive integer')
		if (msg.seq <= last) {
			// replay of something we already applied (lost ack): just confirm
			session.send({ t: 'ack', seq: msg.seq, clock: this.clock })
			return
		}
		if (!Number.isSafeInteger(msg.baseClock) || msg.baseClock < 0 || msg.baseClock > this.clock) throw new RoomError('bad_message', 'bad baseClock')
		if (msg.baseClock < this.historyStart) throw new RoomError('resync', 'base clock is too old; reconnect to rebase')
		let op: TextOp | undefined
		if (msg.code !== undefined) {
			if (!isTextOp(msg.code)) throw new RoomError('bad_message', 'code must be a text op')
			op = msg.code
			for (const h of this.history) if (h.clock > msg.baseClock) op = transform(h.op, op)[1]
			if (baseLength(op) !== this.code.length) throw new RoomError('resync', 'code op does not match the document')
		}
		if (msg.records !== undefined && !Array.isArray(msg.records)) throw new RoomError('bad_message', 'records must be an array')
		const origin = msg.origin ?? session.origin
		const { rejected, errors } = this.commit({ clientId: session.clientId, origin, seq: msg.seq, code: op, records: msg.records ?? [] }, session.id)
		const ack: AckMessage = { t: 'ack', seq: msg.seq, clock: this.clock }
		if (rejected.length) {
			ack.rejected = rejected
			ack.errors = errors
		}
		session.send(ack)
	}

	/**
	 * Applies a change made against the current clock. Invalid record writes are
	 * dropped and reported. Returns the new clock (unchanged if nothing changed).
	 */
	commit(
		change: { clientId: string; origin: Origin; seq?: number; code?: TextOp; records?: readonly RecordChange[] },
		exceptSessionId?: string,
	): { clock: number; rejected: RecordChange[]; errors: string[] } {
		const rejected: RecordChange[] = []
		const errors: string[] = []
		const applied: RecordChange[] = []
		const attributed: NonNullable<AttributionEntry['records']> = []
		const seen = new Set<string>()
		for (const r of change.records ?? []) {
			const errs = validateRecordChange(r)
			const id = typeof r?.id === 'string' ? r.id : ''
			if (errs.length) {
				errors.push(...errs)
				if (id && !seen.has(id)) rejected.push({ id, value: this.records.get(id) ?? null })
				continue
			}
			seen.add(id)
			const before = this.records.get(id) ?? null
			if (jsonEqual(before, r.value)) continue
			applied.push({ id, value: r.value })
			attributed.push({ id, before, after: r.value })
		}
		const op = change.code && !isNoop(change.code) ? change.code : undefined
		if (change.seq !== undefined) this.clients.set(change.clientId, change.seq)
		if (!op && !applied.length) {
			if (change.seq !== undefined) this.scheduleSave()
			return { clock: this.clock, rejected, errors }
		}
		const clock = ++this.clock
		const textBefore = this.code
		if (op) {
			this.code = apply(this.code, op)
			this.codeClock = clock
			this.lastCodeOrigin = change.origin
			this.history.push({ clock, op })
			if (this.history.length > this.historyLimit) {
				const dropped = this.history.splice(0, this.history.length - this.historyLimit)
				this.historyStart = dropped[dropped.length - 1].clock
			}
		}
		for (const { id, value } of applied) {
			if (value === null) this.records.delete(id)
			else this.records.set(id, value)
			this.recordClocks.set(id, clock)
		}
		this.pruneTombstones()
		this.updatedAt = new Date().toISOString()
		const entry: AttributionEntry = { clock, at: this.updatedAt, clientId: change.clientId, origin: change.origin }
		if (op) entry.code = { op, inverse: invert(op, textBefore) }
		if (attributed.length) entry.records = attributed
		this.appendLog(entry)
		const msg: ChangeMessage = { t: 'change', clock, origin: change.origin, clientId: change.clientId }
		if (op) msg.code = op
		if (applied.length) msg.records = applied
		this.broadcast(msg, exceptSessionId)
		const event: CommitEvent = { clock, origin: change.origin, clientId: change.clientId, codeChanged: !!op, code: this.code, records: applied }
		for (const fn of this.listeners) {
			try {
				fn(event)
			} catch {
				// a broken subscriber must not break the writer
			}
		}
		this.scheduleSave()
		return { clock, rejected, errors }
	}

	private pruneTombstones() {
		let dead = 0
		for (const id of this.recordClocks.keys()) if (!this.records.has(id)) dead++
		if (dead <= this.tombstoneLimit) return
		const tombs = [...this.recordClocks].filter(([id]) => !this.records.has(id)).sort((a, b) => a[1] - b[1])
		for (const [id, c] of tombs.slice(0, dead - this.tombstoneLimit)) {
			this.recordClocks.delete(id)
			this.tombstoneHorizon = Math.max(this.tombstoneHorizon, c)
		}
	}

	private appendLog(entry: AttributionEntry) {
		this.log.push(entry)
		if (this.log.length > this.logLimit) this.log.splice(0, this.log.length - this.logLimit)
		if (!this.logFile) return
		try {
			mkdirSync(dirname(this.logFile), { recursive: true })
			appendFileSync(this.logFile, JSON.stringify({ room: this.id, ...entry }) + '\n')
		} catch (err) {
			console.error(`[octo-draw] room ${this.id}: failed to append log:`, (err as Error).message)
		}
	}

	/** Recent attribution entries, optionally filtered. */
	attribution(filter: { kind?: Origin['kind']; name?: string; clientId?: string; sinceClock?: number } = {}): AttributionEntry[] {
		return this.log.filter(
			(e) =>
				(filter.kind === undefined || e.origin.kind === filter.kind) &&
				(filter.name === undefined || e.origin.name === filter.name) &&
				(filter.clientId === undefined || e.clientId === filter.clientId) &&
				(filter.sinceClock === undefined || e.clock > filter.sinceClock),
		)
	}

	// ---- server-side writers (REST adapter, in-process agents)

	/** Replaces the code with `next` (diffed against the current code). */
	setCode(next: string, origin: Origin, clientId = `server:${origin.name}`): number {
		if (next === this.code) return this.clock
		return this.commit({ clientId, origin, code: diffText(this.code, next) }).clock
	}

	/** Applies agent actions to the current code atomically. */
	applyActions(actions: AgentAction[], origin: Origin, clientId = `server:${origin.name}`): ApplyResult & { clock: number } {
		const r = applyActions(this.code, actions)
		return { ...r, clock: this.setCode(r.code, origin, clientId) }
	}

	setRecords(records: RecordChange[], origin: Origin, clientId = `server:${origin.name}`) {
		return this.commit({ clientId, origin, records })
	}

	/**
	 * A writer for a long-running agent that started from `baseCode` and keeps
	 * producing whole new versions of the code. Each `write(next)` is a 3-way
	 * merge: the agent's change (base → next) is transformed past whatever
	 * happened in the room meanwhile (base → current), so concurrent human
	 * typing is kept instead of overwritten.
	 */
	textWriter(origin: Origin, baseCode: string, clientId = `server:${origin.name}`) {
		let view = baseCode
		return {
			write: (next: string): number => {
				const theirs = diffText(view, this.code)
				const mine = diffText(view, next)
				const [, merged] = transform(theirs, mine)
				view = next
				return this.commit({ clientId, origin, code: merged }).clock
			},
		}
	}

	dispose() {
		this.flush()
		this.listeners.clear()
		this.sessions.clear()
	}
}

export class RoomError extends Error {
	constructor(
		public code: 'bad_message' | 'resync',
		message: string,
	) {
		super(message)
	}
}
