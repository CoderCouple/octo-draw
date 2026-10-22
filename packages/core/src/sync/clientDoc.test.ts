import { describe, expect, it } from 'vitest'
import { ClientDoc } from './clientDoc'
import type { AckMessage, ChangeMessage, HelloMessage, PushMessage, ServerMessage } from './protocol'
import type { RecordChange, RecordValue } from './records'
import { apply, OpBuilder, transform, type TextOp } from './textOp'

/** Minimal reference server: same rules as apps/server's Room, in memory and synchronous. */
class MiniServer {
	clock = 0
	text = ''
	records = new Map<string, RecordValue>()
	history: { clock: number; op: TextOp }[] = []
	applied = new Map<string, number>()
	recordClock = new Map<string, number>()
	outbox = new Map<string, ServerMessage[]>()

	connect(clientId: string, lastClock: number): HelloMessage {
		this.outbox.set(clientId, [])
		const full = lastClock === 0
		const records: RecordChange[] = []
		for (const [id, v] of this.records) if (full || (this.recordClock.get(id) ?? 0) > lastClock) records.push({ id, value: v })
		if (!full) for (const [id, c] of this.recordClock) if (c > lastClock && !this.records.has(id)) records.push({ id, value: null })
		return { t: 'hello', docId: 'd', sessionId: clientId, clock: this.clock, clientSeq: this.applied.get(clientId) ?? 0, code: this.text, full, records, peers: [] }
	}

	push(clientId: string, msg: PushMessage) {
		const out = this.outbox.get(clientId)
		if (msg.seq <= (this.applied.get(clientId) ?? 0)) {
			out?.push({ t: 'ack', seq: msg.seq, clock: this.clock })
			return
		}
		let op = msg.code
		if (op) for (const h of this.history) if (h.clock > msg.baseClock) op = transform(h.op, op)[1]
		this.clock++
		if (op) {
			this.text = apply(this.text, op)
			this.history.push({ clock: this.clock, op })
		}
		for (const r of msg.records ?? []) {
			if (r.value === null) this.records.delete(r.id)
			else this.records.set(r.id, r.value)
			this.recordClock.set(r.id, this.clock)
		}
		this.applied.set(clientId, msg.seq)
		const change: ChangeMessage = { t: 'change', clock: this.clock, code: op, records: msg.records, origin: { kind: 'human', name: clientId }, clientId }
		for (const [id, box] of this.outbox) box.push(id === clientId ? ({ t: 'ack', seq: msg.seq, clock: this.clock } as AckMessage) : change)
	}
}

function rng(seed: number) {
	let s = seed >>> 0
	return () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function randomEdit(r: () => number, text: string): TextOp {
	const b = new OpBuilder()
	const at = Math.floor(r() * (text.length + 1))
	b.retain(at)
	if (r() < 0.6) b.insert(['x', 'A > B\n', 'yz', '\n'][Math.floor(r() * 4)])
	const del = r() < 0.4 ? Math.min(text.length - at, 1 + Math.floor(r() * 3)) : 0
	b.delete(del)
	b.retain(text.length - at - del)
	return b.ops
}

interface Sim {
	doc: ClientDoc
	up: PushMessage[]
	online: boolean
}

function deliver(c: Sim, m: ServerMessage) {
	if (m.t === 'ack') c.doc.onAck(m)
	else if (m.t === 'change') c.doc.onChange(m)
}

describe('ClientDoc against a reference server', () => {
	for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
		it(`random concurrent edits converge (seed ${seed})`, () => {
			const r = rng(seed)
			const server = new MiniServer()
			const sims: Sim[] = ['a', 'b', 'c'].map((id) => ({ doc: new ClientDoc(id), up: [], online: true }))
			for (const s of sims) s.doc.onHello(server.connect(s.doc.clientId, 0))
			for (let step = 0; step < 600; step++) {
				const s = sims[Math.floor(r() * sims.length)]
				const p = r()
				if (p < 0.35) s.doc.localCode(randomEdit(r, s.doc.text))
				else if (p < 0.45) s.doc.localRecord(`pin:n${Math.floor(r() * 3)}`, { x: Math.floor(r() * 100), y: 0 })
				else if (p < 0.6) {
					const m = s.doc.takePush()
					if (m && s.online) s.up.push(m)
				} else if (p < 0.75) {
					const m = s.up.shift()
					if (m) server.push(s.doc.clientId, m)
				} else if (p < 0.97) {
					const m = server.outbox.get(s.doc.clientId)?.shift()
					if (m && s.online) deliver(s, m)
				} else if (s.online) {
					// drop the connection: lose queued messages both ways, then reconnect
					s.online = false
					s.up = []
					server.outbox.delete(s.doc.clientId)
				} else {
					s.online = true
					s.doc.onHello(server.connect(s.doc.clientId, s.doc.clock))
				}
			}
			// settle: reconnect everyone, then pump until quiet
			for (const s of sims) {
				if (!s.online) {
					s.online = true
					s.doc.onHello(server.connect(s.doc.clientId, s.doc.clock))
				}
			}
			for (let guard = 0; guard < 10000; guard++) {
				let busy = false
				for (const s of sims) {
					const m = s.doc.takePush()
					if (m) s.up.push(m)
					const up = s.up.shift()
					if (up) {
						server.push(s.doc.clientId, up)
						busy = true
					}
					const down = server.outbox.get(s.doc.clientId)?.shift()
					if (down) {
						deliver(s, down)
						busy = true
					}
				}
				if (!busy && sims.every((s) => !s.doc.hasPending)) break
			}
			for (const s of sims) {
				expect(s.doc.hasPending).toBe(false)
				expect(s.doc.text).toBe(server.text)
				expect(s.doc.serverText).toBe(server.text)
				expect([...s.doc.records].sort()).toEqual([...server.records].sort())
			}
		})
	}

	it('persists and restores pending offline edits', () => {
		const server = new MiniServer()
		const a = new ClientDoc('a')
		a.onHello(server.connect('a', 0))
		a.localCode(['A > B\n'])
		const m = a.takePush()!
		a.localCode([6, 'B > C\n'])
		a.localRecord('pin:A', { x: 1, y: 2 })
		// the first push reached the server but the ack was lost; the tab was closed
		server.push('a', m)
		const saved = JSON.parse(JSON.stringify(a.persist()))
		const b = ClientDoc.restore(saved)
		expect(b.text).toBe('A > B\nB > C\n')
		b.onHello(server.connect('a', b.clock))
		const p = b.takePush()!
		expect(p.seq).toBe(2)
		server.push('a', p)
		b.onAck(server.outbox.get('a')!.pop() as AckMessage)
		expect(server.text).toBe('A > B\nB > C\n')
		expect(b.text).toBe(server.text)
		expect(server.records.get('pin:A')).toEqual({ x: 1, y: 2 })
	})

	it('reports remote changes in local coordinates', () => {
		const server = new MiniServer()
		const a = new ClientDoc('a')
		const b = new ClientDoc('b')
		a.onHello(server.connect('a', 0))
		b.onHello(server.connect('b', 0))
		a.localCode(['hello'])
		server.push('a', a.takePush()!)
		const u = b.onChange(server.outbox.get('b')!.shift() as ChangeMessage)
		expect(u.code).toEqual({ changes: [{ from: 0, to: 0, insert: 'hello' }], text: 'hello' })
		a.onAck(server.outbox.get('a')!.shift() as AckMessage)
		// b types at the end while a's next op is in flight
		a.localCode([5, ' world'])
		server.push('a', a.takePush()!)
		b.localCode(['>> ', 5])
		const u2 = b.onChange(server.outbox.get('b')!.shift() as ChangeMessage)
		expect(u2.code?.changes).toEqual([{ from: 8, to: 8, insert: ' world' }])
		expect(b.text).toBe('>> hello world')
	})
})
