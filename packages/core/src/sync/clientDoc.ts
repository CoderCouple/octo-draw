/**
 * Client-side sync state machine, independent of any transport.
 *
 * It keeps three layers:
 * - `server`: the text and records as of `clock` (what the server confirmed),
 * - `inflight`: the one push sent and not yet acknowledged,
 * - `buffer`: local edits made since, not yet sent.
 * The local view is server + inflight + buffer. Remote code ops are transformed
 * past inflight and buffer (server wins insert ties); remote record writes are
 * shown unless a local write to the same record is pending (it will reach the
 * server later and win, so showing the remote value would only flicker).
 */

import type { AckMessage, ChangeMessage, HelloMessage, Origin, PushMessage } from './protocol'
import { jsonEqual, type RecordChange, type RecordValue } from './records'
import { apply, baseLength, compose, diffText, isNoop, toChanges, transform, type TextChange, type TextOp } from './textOp'

export interface Pending {
	code: TextOp | null
	records: [string, RecordValue | null][]
}

export interface InflightPush extends Pending {
	seq: number
	origin?: Origin
}

/** JSON-serialisable snapshot of a client (for offline persistence). */
export interface PersistedClientState {
	v: 1
	clientId: string
	clock: number
	seq: number
	serverText: string
	serverRecords: [string, RecordValue][]
	inflight: InflightPush | null
	buffer: Pending
}

/** What changed locally because of the server (apply this to the UI). */
export interface RemoteUpdate {
	/** Code changes in coordinates of the local text before the update (CodeMirror-friendly). */
	code?: { changes: TextChange[]; text: string }
	records?: RecordChange[]
}

export class SyncProtocolError extends Error {}

export class ClientDoc {
	clock = 0
	seq = 0
	serverText = ''
	serverRecords = new Map<string, RecordValue>()
	text = ''
	records = new Map<string, RecordValue>()
	inflight: InflightPush | null = null
	private bufCode: TextOp | null = null
	private bufRecords = new Map<string, RecordValue | null>()
	private bufOrigin: Origin | undefined

	constructor(readonly clientId: string) {}

	static restore(s: PersistedClientState): ClientDoc {
		const d = new ClientDoc(s.clientId)
		d.clock = s.clock
		d.seq = s.seq
		d.serverText = s.serverText
		d.serverRecords = new Map(s.serverRecords)
		d.inflight = s.inflight
		d.bufCode = s.buffer.code
		d.bufRecords = new Map(s.buffer.records)
		d.text = d.serverText
		d.records = new Map(d.serverRecords)
		if (d.inflight) d.overlay(d.inflight.code, d.inflight.records)
		d.overlay(d.bufCode, s.buffer.records)
		return d
	}

	private overlay(code: TextOp | null, records: Iterable<[string, RecordValue | null]>) {
		if (code) this.text = apply(this.text, code)
		for (const [id, v] of records) setOrDelete(this.records, id, v)
	}

	persist(): PersistedClientState {
		return {
			v: 1,
			clientId: this.clientId,
			clock: this.clock,
			seq: this.seq,
			serverText: this.serverText,
			serverRecords: [...this.serverRecords],
			inflight: this.inflight,
			buffer: { code: this.bufCode, records: [...this.bufRecords] },
		}
	}

	get hasPending(): boolean {
		return this.inflight !== null || this.bufCode !== null || this.bufRecords.size > 0
	}

	// ---- local edits

	localCode(op: TextOp, origin?: Origin) {
		if (isNoop(op)) return
		this.text = apply(this.text, op)
		this.bufCode = this.bufCode ? compose(this.bufCode, op) : op
		if (origin) this.bufOrigin = origin
	}

	localRecord(id: string, value: RecordValue | null, origin?: Origin) {
		const cur = this.records.get(id) ?? null
		if (jsonEqual(cur, value)) return
		setOrDelete(this.records, id, value)
		this.bufRecords.set(id, value)
		if (origin) this.bufOrigin = origin
	}

	/** Moves the buffer into a new inflight push, if nothing is inflight and there is something to send. */
	takePush(): PushMessage | null {
		if (this.inflight || (!this.bufCode && this.bufRecords.size === 0)) return null
		this.inflight = { seq: ++this.seq, code: this.bufCode, records: [...this.bufRecords], origin: this.bufOrigin }
		this.bufCode = null
		this.bufRecords = new Map()
		this.bufOrigin = undefined
		return this.pushMessage()
	}

	/** The push message for the current inflight (also used to resend it). */
	pushMessage(): PushMessage | null {
		const f = this.inflight
		if (!f) return null
		const msg: PushMessage = { t: 'push', seq: f.seq, baseClock: this.clock }
		if (f.code) msg.code = f.code
		if (f.records.length) msg.records = f.records.map(([id, value]) => ({ id, value }))
		if (f.origin) msg.origin = f.origin
		return msg
	}

	private isPending(id: string) {
		return this.bufRecords.has(id) || (this.inflight?.records.some(([k]) => k === id) ?? false)
	}

	// ---- server messages

	/** Applies a server-transformed code op to every layer; returns the op to apply locally. */
	private remoteCode(op: TextOp): TextOp {
		this.serverText = apply(this.serverText, op)
		let r = op
		if (this.inflight?.code) {
			const [r1, f1] = transform(r, this.inflight.code)
			this.inflight.code = f1
			r = r1
		}
		if (this.bufCode) {
			const [r2, b2] = transform(r, this.bufCode)
			this.bufCode = b2
			r = r2
		}
		return r
	}

	private remoteRecords(changes: readonly RecordChange[], out: RecordChange[]) {
		for (const { id, value } of changes) {
			setOrDelete(this.serverRecords, id, value)
			if (this.isPending(id)) continue
			if (jsonEqual(this.records.get(id) ?? null, value)) continue
			setOrDelete(this.records, id, value)
			out.push({ id, value })
		}
	}

	private localUpdate(op: TextOp | null, records: RecordChange[]): RemoteUpdate {
		const u: RemoteUpdate = {}
		if (op && !isNoop(op)) {
			const changes = toChanges(op)
			this.text = apply(this.text, op)
			u.code = { changes, text: this.text }
		}
		if (records.length) u.records = records
		return u
	}

	onChange(msg: ChangeMessage): RemoteUpdate {
		if (msg.clock <= this.clock) return {} // duplicate / already seen
		let op: TextOp | null = null
		if (msg.code) {
			if (baseLength(msg.code) !== this.serverText.length) throw new SyncProtocolError('remote op does not match server text')
			op = this.remoteCode(msg.code)
		}
		const recs: RecordChange[] = []
		if (msg.records) this.remoteRecords(msg.records, recs)
		this.clock = msg.clock
		return this.localUpdate(op, recs)
	}

	onAck(msg: AckMessage): RemoteUpdate {
		const f = this.inflight
		if (!f || f.seq !== msg.seq) throw new SyncProtocolError(`unexpected ack ${msg.seq}`)
		if (f.code) this.serverText = apply(this.serverText, f.code)
		for (const [id, v] of f.records) setOrDelete(this.serverRecords, id, v)
		this.inflight = null
		this.clock = Math.max(this.clock, msg.clock)
		const recs: RecordChange[] = []
		if (msg.rejected?.length) this.remoteRecords(msg.rejected, recs)
		return this.localUpdate(null, recs)
	}

	/**
	 * (Re)connected. The server sends its full code; pending local code is rebased
	 * onto it with a diff from the last confirmed text, so offline edits survive.
	 */
	onHello(msg: HelloMessage): RemoteUpdate {
		const f = this.inflight
		if (f && f.seq <= msg.clientSeq) {
			// the server applied our last push but the ack was lost
			if (f.code && baseLength(f.code) === this.serverText.length) this.serverText = apply(this.serverText, f.code)
			for (const [id, v] of f.records) setOrDelete(this.serverRecords, id, v)
			this.inflight = null
		}
		this.seq = Math.max(this.seq, msg.clientSeq)
		// fold a still-unapplied inflight back into the buffer; it is resent with a new seq
		if (this.inflight) {
			const g = this.inflight
			this.inflight = null
			this.bufCode = g.code && this.bufCode ? compose(g.code, this.bufCode) : (g.code ?? this.bufCode)
			const merged = new Map(g.records)
			for (const [id, v] of this.bufRecords) merged.set(id, v)
			this.bufRecords = merged
			this.bufOrigin = this.bufOrigin ?? g.origin
		}
		let op: TextOp | null = null
		if (msg.code !== this.serverText) op = this.remoteCode(diffText(this.serverText, msg.code))
		const recs: RecordChange[] = []
		if (msg.full) {
			const incoming = new Set(msg.records.map((r) => r.id))
			const gone: RecordChange[] = []
			for (const id of new Set([...this.serverRecords.keys(), ...this.records.keys()])) if (!incoming.has(id)) gone.push({ id, value: null })
			this.remoteRecords(gone, recs)
		}
		this.remoteRecords(msg.records, recs)
		this.clock = msg.clock
		return this.localUpdate(op, recs)
	}
}

function setOrDelete(map: Map<string, RecordValue>, id: string, v: RecordValue | null) {
	if (v === null) map.delete(id)
	else map.set(id, v)
}
