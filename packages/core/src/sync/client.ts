/**
 * Framework-free live-sync client.
 *
 *   const sync = createSyncClient({ url: 'ws://localhost:8787/api/sync', docId: 'default', onRemote })
 *   sync.applyLocalCodeEdit([{ from: 0, to: 0, insert: 'A > B\n' }])
 *
 * Works in browsers and Node 22+ (global WebSocket), or with any constructor
 * passed as `WebSocket`. Reconnects with exponential backoff; unsent edits are
 * kept (and can be persisted through `storage`) and replayed on reconnect.
 */

import type { Point } from '../ir'
import type { FreeShape } from '../free'
import type { AgentAction, ApplyResult } from '../agent'
import { applyActions } from '../agent/apply'
import { ClientDoc, SyncProtocolError, type PersistedClientState, type RemoteUpdate } from './clientDoc'
import { SYNC_PROTOCOL_VERSION, type ClientMessage, type Origin, type PeerPresence, type Presence, type ServerMessage } from './protocol'
import { META_ID, pinId, pinsFromRecords, shapeId, shapesFromRecords, topZ, validateRecordChange, type MetaRecord, type RecordValue, type ShapeRecord } from './records'
import { diffText, fromChanges, type TextChange } from './textOp'

/** The subset of the WHATWG WebSocket the client needs. */
export interface SocketLike {
	readonly readyState: number
	send(data: string): void
	close(code?: number, reason?: string): void
	onopen: ((ev: unknown) => void) | null
	onclose: ((ev: { code?: number; reason?: string }) => void) | null
	onerror: ((ev: unknown) => void) | null
	onmessage: ((ev: { data: unknown }) => void) | null
}

export type SocketCtor = new (url: string) => SocketLike

/** Offline queue persistence (e.g. IndexedDB or localStorage). Both may be async. */
export interface SyncStorage {
	load(docId: string): PersistedClientState | null | undefined | Promise<PersistedClientState | null | undefined>
	save(docId: string, state: PersistedClientState): void | Promise<void>
}

export type SyncStatus = 'connecting' | 'online' | 'offline' | 'closed'

export interface RemoteEvent extends RemoteUpdate {
	/** `change`: a peer's edit; `resync`: catch-up after (re)connecting; `reject`: the server refused some local record writes. */
	reason: 'change' | 'resync' | 'reject'
	origin?: Origin
	clientId?: string
}

export interface PresenceEvent {
	/** All peers currently connected (excluding this session). */
	peers: PeerPresence[]
	/** The peer that changed, or null for a full refresh (on connect). */
	changed: PeerPresence | { sessionId: string; state: null } | null
}

export interface SyncClientOptions {
	url: string
	docId: string
	/** Stable id for de-duplicating replayed pushes; persisted with `storage`. Default: random. */
	clientId?: string
	origin?: Origin
	onRemote?: (e: RemoteEvent) => void
	onPresence?: (e: PresenceEvent) => void
	onStatus?: (s: SyncStatus) => void
	onError?: (err: { code: string; message: string }) => void
	storage?: SyncStorage
	WebSocket?: SocketCtor
	/** Reconnect backoff in ms. Default { min: 250, max: 10000 }. */
	backoff?: { min: number; max: number }
	/** Minimum ms between presence messages. Default 50. */
	presenceInterval?: number
	/** Heartbeat interval in ms (0 disables). Default 20000. */
	pingInterval?: number
}

export interface SyncClient {
	readonly docId: string
	readonly clientId: string
	readonly status: SyncStatus
	/** Resolves once storage is loaded (if any). */
	readonly ready: Promise<void>
	getCode(): string
	getPins(): Record<string, Point>
	getShapes(): FreeShape[]
	getMeta(): MetaRecord | undefined
	getRecord(id: string): RecordValue | undefined
	getPeers(): PeerPresence[]
	/** True while local edits are not yet confirmed by the server. */
	hasPending(): boolean
	/** Resolves when everything local is confirmed (or rejects after `timeoutMs`). */
	whenSynced(timeoutMs?: number): Promise<void>
	/** CodeMirror-style changes in coordinates of the current code. */
	applyLocalCodeEdit(changes: readonly TextChange[], origin?: Origin): void
	/** Replaces the code (diffed into minimal changes so concurrent edits survive). */
	setCode(code: string, origin?: Origin): void
	/** Runs agent actions against the current code and pushes the result. */
	applyAgentActions(actions: AgentAction[], origin?: Origin): ApplyResult
	setPin(key: string, point: Point | null, origin?: Origin): void
	/** Adds or replaces a freehand shape. New shapes go on top unless `z` is given. */
	upsertShape(shape: FreeShape, z?: number, origin?: Origin): void
	deleteShape(id: string, origin?: Origin): void
	setMeta(patch: Partial<MetaRecord>, origin?: Origin): void
	setPresence(state: Presence | null): void
	/** Snapshot for offline persistence (also passed to `storage.save`). */
	persist(): PersistedClientState
	/** Drops the connection and stops reconnecting. */
	close(): void
	/** Forces a reconnect now (e.g. on `online` events). */
	reconnect(): void
}

const OPEN = 1

function randomId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
	return c?.randomUUID ? c.randomUUID() : 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function createSyncClient(opts: SyncClientOptions): SyncClient {
	const Ctor = opts.WebSocket ?? (globalThis as { WebSocket?: SocketCtor }).WebSocket
	if (!Ctor) throw new Error('createSyncClient: no WebSocket implementation available; pass `WebSocket`')
	const origin: Origin = opts.origin ?? { kind: 'human', name: 'anonymous' }
	const backoff = opts.backoff ?? { min: 250, max: 10000 }
	const presenceInterval = opts.presenceInterval ?? 50
	const pingInterval = opts.pingInterval ?? 20000

	let doc = new ClientDoc(opts.clientId ?? randomId())
	let status: SyncStatus = 'connecting'
	let socket: SocketLike | null = null
	let connected = false // hello received
	let closed = false
	let attempt = 0
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined
	let pingTimer: ReturnType<typeof setInterval> | undefined
	let presenceTimer: ReturnType<typeof setTimeout> | undefined
	let saveTimer: ReturnType<typeof setTimeout> | undefined
	let lastPresenceAt = 0
	let presence: Presence | null = null
	let presenceDirty = false
	const peers = new Map<string, PeerPresence>()
	const syncedWaiters = new Set<() => void>()

	const setStatus = (s: SyncStatus) => {
		if (s === status) return
		status = s
		opts.onStatus?.(s)
	}

	const scheduleSave = () => {
		if (!opts.storage || saveTimer) return
		saveTimer = setTimeout(() => {
			saveTimer = undefined
			void Promise.resolve(opts.storage!.save(opts.docId, doc.persist())).catch(() => {})
		}, 50)
	}

	const send = (msg: ClientMessage) => {
		if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(msg))
	}

	const flushPush = () => {
		if (!connected) return
		const msg = doc.takePush()
		if (msg) send(msg)
	}

	const checkSynced = () => {
		if (doc.hasPending) return
		for (const fn of syncedWaiters) fn()
		syncedWaiters.clear()
	}

	const emit = (u: RemoteUpdate, reason: RemoteEvent['reason'], extra?: Pick<RemoteEvent, 'origin' | 'clientId'>) => {
		if (!u.code && !u.records) return
		opts.onRemote?.({ ...u, reason, ...extra })
	}

	const sendPresence = () => {
		presenceTimer = undefined
		if (!presenceDirty || !connected) return
		presenceDirty = false
		lastPresenceAt = Date.now()
		send({ t: 'presence', state: presence })
	}

	const handle = (msg: ServerMessage) => {
		switch (msg.t) {
			case 'hello': {
				connected = true
				attempt = 0
				const u = doc.onHello(msg)
				peers.clear()
				for (const p of msg.peers) peers.set(p.sessionId, p)
				setStatus('online')
				emit(u, 'resync')
				opts.onPresence?.({ peers: [...peers.values()], changed: null })
				if (presence) {
					presenceDirty = true
					sendPresence()
				}
				flushPush()
				scheduleSave()
				checkSynced()
				return
			}
			case 'ack': {
				const u = doc.onAck(msg)
				emit(u, 'reject')
				if (msg.errors?.length) opts.onError?.({ code: 'rejected', message: msg.errors.join('; ') })
				flushPush()
				scheduleSave()
				checkSynced()
				return
			}
			case 'change': {
				const u = doc.onChange(msg)
				emit(u, 'change', { origin: msg.origin, clientId: msg.clientId })
				scheduleSave()
				return
			}
			case 'presence': {
				if (msg.state === null) {
					peers.delete(msg.sessionId)
					opts.onPresence?.({ peers: [...peers.values()], changed: { sessionId: msg.sessionId, state: null } })
				} else {
					const p: PeerPresence = { sessionId: msg.sessionId, clientId: msg.clientId, origin: msg.origin, state: msg.state }
					peers.set(msg.sessionId, p)
					opts.onPresence?.({ peers: [...peers.values()], changed: p })
				}
				return
			}
			case 'error': {
				opts.onError?.({ code: msg.code, message: msg.message })
				// resync: drop the socket; reconnecting sends a fresh hello and rebases pending edits
				if (msg.code === 'resync' || msg.fatal) socket?.close(4000, msg.code)
				return
			}
			case 'pong':
				return
		}
	}

	const scheduleReconnect = () => {
		if (closed || reconnectTimer) return
		const base = Math.min(backoff.max, backoff.min * 2 ** attempt)
		attempt++
		const delay = base / 2 + Math.random() * (base / 2)
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined
			open()
		}, delay)
	}

	const open = () => {
		if (closed) return
		if (status !== 'offline') setStatus('connecting')
		let ws: SocketLike
		try {
			ws = new Ctor(opts.url)
		} catch {
			setStatus('offline')
			scheduleReconnect()
			return
		}
		socket = ws
		ws.onopen = () => {
			if (socket !== ws) return
			send({ t: 'connect', protocol: SYNC_PROTOCOL_VERSION, docId: opts.docId, clientId: doc.clientId, lastClock: doc.clock, origin })
			clearInterval(pingTimer)
			if (pingInterval > 0) pingTimer = setInterval(() => send({ t: 'ping' }), pingInterval)
		}
		ws.onmessage = (ev) => {
			if (socket !== ws) return
			let msg: ServerMessage
			try {
				msg = JSON.parse(String(ev.data)) as ServerMessage
			} catch {
				return
			}
			try {
				handle(msg)
			} catch (err) {
				// our view diverged from the server's: reconnect for a fresh hello
				opts.onError?.({ code: err instanceof SyncProtocolError ? 'protocol' : 'client_error', message: (err as Error).message })
				ws.close(4001, 'client resync')
			}
		}
		ws.onerror = () => {}
		ws.onclose = () => {
			if (socket !== ws) return
			socket = null
			connected = false
			clearInterval(pingTimer)
			if (peers.size) {
				peers.clear()
				opts.onPresence?.({ peers: [], changed: null })
			}
			if (closed) return
			setStatus('offline')
			scheduleReconnect()
		}
	}

	const local = () => {
		scheduleSave()
		flushPush()
	}

	const writeRecord = (id: string, value: RecordValue | null, o?: Origin) => {
		const errors = validateRecordChange({ id, value })
		if (errors.length) throw new Error(`invalid ${id}: ${errors.join('; ')}`)
		doc.localRecord(id, value, o)
		local()
	}

	const ready = (async () => {
		if (!opts.storage) return
		try {
			const saved = await opts.storage.load(opts.docId)
			if (saved && saved.v === 1 && (!opts.clientId || saved.clientId === opts.clientId)) doc = ClientDoc.restore(saved)
		} catch {
			// unreadable offline state: start fresh
		}
	})()

	void ready.then(open)

	const client: SyncClient = {
		docId: opts.docId,
		get clientId() {
			return doc.clientId
		},
		get status() {
			return status
		},
		ready,
		getCode: () => doc.text,
		getPins: () => pinsFromRecords(doc.records),
		getShapes: () => shapesFromRecords(doc.records),
		getMeta: () => doc.records.get(META_ID) as MetaRecord | undefined,
		getRecord: (id) => doc.records.get(id),
		getPeers: () => [...peers.values()],
		hasPending: () => doc.hasPending,
		whenSynced(timeoutMs = 10000) {
			if (!doc.hasPending) return Promise.resolve()
			return new Promise<void>((resolve, reject) => {
				const done = () => {
					clearTimeout(t)
					resolve()
				}
				const t = setTimeout(() => {
					syncedWaiters.delete(done)
					reject(new Error('whenSynced: timed out'))
				}, timeoutMs)
				syncedWaiters.add(done)
			})
		},
		applyLocalCodeEdit(changes, o) {
			if (!changes.length) return
			doc.localCode(fromChanges(doc.text.length, changes), o)
			local()
		},
		setCode(code, o) {
			if (code === doc.text) return
			doc.localCode(diffText(doc.text, code), o)
			local()
		},
		applyAgentActions(actions, o) {
			const r = applyActions(doc.text, actions)
			client.setCode(r.code, o ?? (origin.kind === 'agent' ? origin : undefined))
			return r
		},
		setPin: (key, point, o) => writeRecord(pinId(key), point ? { x: point.x, y: point.y } : null, o),
		upsertShape(shape, z, o) {
			const prev = doc.records.get(shapeId(shape.id)) as ShapeRecord | undefined
			const rec: ShapeRecord = { z: z ?? prev?.z ?? topZ(doc.records), shape }
			writeRecord(shapeId(shape.id), rec, o)
		},
		deleteShape: (id, o) => writeRecord(shapeId(id), null, o),
		setMeta(patch, o) {
			const cur = (doc.records.get(META_ID) as MetaRecord | undefined) ?? { title: 'Untitled diagram' }
			const next: MetaRecord = { ...cur, ...patch }
			for (const k of Object.keys(next) as (keyof MetaRecord)[]) if (next[k] === undefined) delete next[k]
			writeRecord(META_ID, next, o)
		},
		setPresence(state) {
			presence = state
			presenceDirty = true
			if (presenceTimer) return
			const wait = Math.max(0, lastPresenceAt + presenceInterval - Date.now())
			presenceTimer = setTimeout(sendPresence, wait)
		},
		persist: () => doc.persist(),
		close() {
			closed = true
			clearTimeout(reconnectTimer)
			clearTimeout(presenceTimer)
			clearInterval(pingTimer)
			if (saveTimer) {
				clearTimeout(saveTimer)
				saveTimer = undefined
				void Promise.resolve(opts.storage?.save(opts.docId, doc.persist())).catch(() => {})
			}
			socket?.close(1000, 'closed')
			socket = null
			connected = false
			setStatus('closed')
		},
		reconnect() {
			if (closed) return
			clearTimeout(reconnectTimer)
			reconnectTimer = undefined
			attempt = 0
			if (socket) socket.close(4002, 'reconnect')
			else open()
		},
	}
	return client
}
