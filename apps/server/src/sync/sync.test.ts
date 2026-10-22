import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { parseOcto, validateDocument, type FreeShape } from '@octo-draw/core'
import { createSyncClient, fromChanges, transformIndex, type PersistedClientState, type PresenceEvent, type ServerMessage, type SocketCtor, type SyncClient, type SyncClientOptions } from '@octo-draw/core/src/sync'
import { createApp } from '../app'
import { attachSync, DEFAULT_DOC_ID, RoomDocStore, RoomManager, type SyncServer } from '.'

interface Harness {
	url: string
	base: string
	rooms: RoomManager
	sync: SyncServer
	server: Server
}

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!()
})

async function start(dir: string | null = null): Promise<Harness> {
	const rooms = new RoomManager({ dir, idleMs: 0, room: { saveDelayMs: 5 } })
	const adapters = new Map<string, RoomDocStore>()
	const storeForRoom = (id: string) => {
		let a = adapters.get(id)
		if (!a) adapters.set(id, (a = new RoomDocStore(rooms.get(id))))
		return a
	}
	const server = createServer(createApp({ store: storeForRoom(DEFAULT_DOC_ID), rooms, storeForRoom, getStream: () => null }))
	const sync = attachSync(server, rooms, { heartbeatMs: 60000 })
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const port = (server.address() as AddressInfo).port
	const h = { url: `ws://127.0.0.1:${port}/api/sync`, base: `http://127.0.0.1:${port}`, rooms, sync, server }
	cleanups.push(async () => {
		await sync.close()
		server.closeAllConnections()
		await new Promise<void>((r) => server.close(() => r()))
		rooms.close()
	})
	return h
}

/** A WebSocket constructor whose network can be cut. */
function flakyNet() {
	const net = { down: false }
	const Ctor = function (url: string) {
		return new WebSocket(net.down ? 'ws://127.0.0.1:9/' : url)
	} as unknown as SocketCtor
	return { net, Ctor }
}

function client(h: Harness, opts: Partial<SyncClientOptions> = {}): SyncClient {
	const c = createSyncClient({ url: h.url, docId: DEFAULT_DOC_ID, WebSocket: WebSocket as unknown as SocketCtor, backoff: { min: 10, max: 50 }, presenceInterval: 5, ...opts })
	cleanups.push(() => c.close())
	return c
}

async function waitFor(cond: () => boolean, ms = 3000, what = 'condition') {
	const end = Date.now() + ms
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
		await new Promise((r) => setTimeout(r, 5))
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Everyone has confirmed everything and sees the room's code. */
async function converged(h: Harness, clients: SyncClient[], docId = DEFAULT_DOC_ID) {
	const room = h.rooms.get(docId)
	await waitFor(() => clients.every((c) => c.status === 'online' && !c.hasPending() && c.getCode() === room.code), 5000, 'convergence')
}

function type(c: SyncClient, at: () => number, text: string) {
	for (const ch of text) {
		const p = at()
		c.applyLocalCodeEdit([{ from: p, to: p, insert: ch }])
	}
}

describe('live sync over WebSocket', () => {
	it('a human typing and an agent applying actions concurrently both land', async () => {
		const h = await start()
		// the human's caret, mapped through remote changes like an editor would
		let caret = 0
		const human = client(h, {
			origin: { kind: 'human', name: 'ada' },
			onRemote: (e) => {
				if (!e.code) return
				const delta = e.code.changes.reduce((n, c) => n + c.insert.length - (c.to - c.from), 0)
				caret = transformIndex(fromChanges(e.code.text.length - delta, e.code.changes), caret, -1)
			},
		})
		const viewer = client(h, { origin: { kind: 'human', name: 'bob' } })
		const agent = client(h, { origin: { kind: 'agent', name: 'claude' } })
		await waitFor(() => [human, viewer, agent].every((c) => c.status === 'online'))
		human.setCode('title Shop\nUsers > Web\n')
		await converged(h, [human, viewer, agent])
		caret = 'title Shop'.length // the human presses Enter after the title and types new lines there

		// human keeps typing a new line at the end, one key at a time, while the agent edits
		const typing = (async () => {
			for (const chunk of ['\n', 'Web > ', 'API', '\n', 'API > ', 'DB']) {
				type(human, () => caret++, chunk)
				await sleep(2)
			}
		})()
		const agentErrors: unknown[] = []
		const agentRun = (async () => {
			agent.setPresence({ status: 'drawing', message: 'adding cache' })
			for (const a of [
				{ type: 'addNode', key: 'Cache', shape: 'cylinder' },
				{ type: 'addEdge', from: 'Web', to: 'Cache' },
				{ type: 'updateNode', key: 'Users', icon: 'users' },
			] as const) {
				agentErrors.push(...agent.applyAgentActions([a]).errors)
				await sleep(3)
			}
			agent.setPresence({ status: 'idle' })
		})()
		await Promise.all([typing, agentRun])
		await converged(h, [human, viewer, agent])
		expect(agentErrors).toEqual([])

		const code = h.rooms.get(DEFAULT_DOC_ID).code
		// both of the human's lines survive intact, wherever the agent's lines interleave
		const lines = code.split('\n')
		expect(lines).toContain('Web > API')
		expect(lines).toContain('API > DB')
		expect(code).toContain('Cache')
		expect(code).toContain('Web > Cache')
		expect(code).toMatch(/Users \[icon: users\]/)
		expect(parseOcto(code).diagnostics.filter((d) => d.severity === 'error')).toEqual([])
		expect(viewer.getCode()).toBe(code)

		// attribution: who did what
		const room = h.rooms.get(DEFAULT_DOC_ID)
		const agentEntries = room.attribution({ kind: 'agent' })
		expect(agentEntries.length).toBeGreaterThanOrEqual(3)
		expect(agentEntries.every((e) => e.origin.name === 'claude' && e.code)).toBe(true)
		expect(room.attribution({ name: 'ada' }).length).toBeGreaterThan(0)
		const log = await json(fetch(`${h.base}/api/docs/default/log?kind=agent`))
		expect(log.entries.length).toBe(agentEntries.length)
	})

	it('random concurrent typing from three clients converges', async () => {
		const h = await start()
		const cs = [client(h), client(h), client(h)]
		await waitFor(() => cs.every((c) => c.status === 'online'))
		let seed = 7
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
		for (let i = 0; i < 150; i++) {
			const c = cs[Math.floor(rnd() * cs.length)]
			const len = c.getCode().length
			const from = Math.floor(rnd() * (len + 1))
			const to = Math.min(len, from + (rnd() < 0.3 ? Math.floor(rnd() * 3) : 0))
			c.applyLocalCodeEdit([{ from, to, insert: rnd() < 0.8 ? 'ab\n'[Math.floor(rnd() * 3)] : '' }])
			if (i % 10 === 0) await sleep(1)
		}
		await converged(h, cs)
	})

	it('records are last-writer-wins and validated', async () => {
		const h = await start()
		const a = client(h)
		const b = client(h)
		await waitFor(() => a.status === 'online' && b.status === 'online')
		const shape: FreeShape = { id: 's1', type: 'rect', x: 0, y: 0, w: 10, h: 10, color: 'ink', size: 2 }
		a.upsertShape(shape)
		a.setPin('API', { x: 1, y: 1 })
		await waitFor(() => b.getShapes().length === 1 && b.getPins().API?.x === 1)
		a.setPin('API', { x: 2, y: 2 })
		b.setPin('API', { x: 3, y: 3 })
		await converged(h, [a, b])
		await waitFor(() => a.getPins().API?.x === b.getPins().API?.x)
		expect(h.rooms.get(DEFAULT_DOC_ID).records.get('pin:API')).toEqual(a.getPins().API)
		b.upsertShape({ ...shape, x: 50 })
		await waitFor(() => a.getShapes()[0]?.x === 50)
		a.deleteShape('s1')
		await waitFor(() => b.getShapes().length === 0)
		expect(() => a.setPin('X', { x: Number.NaN, y: 0 })).toThrow()
		a.setMeta({ title: 'Renamed' })
		await waitFor(() => b.getMeta()?.title === 'Renamed')
		expect(h.rooms.get(DEFAULT_DOC_ID).snapshot().title).toBe('Renamed')
	})

	it('server rejects invalid records and de-duplicates replayed pushes', async () => {
		const h = await start()
		const ws = new WebSocket(h.url)
		const inbox: ServerMessage[] = []
		ws.on('message', (d) => inbox.push(JSON.parse(d.toString())))
		await new Promise((r) => ws.on('open', r))
		ws.send(JSON.stringify({ t: 'connect', protocol: 1, docId: 'raw', clientId: 'raw-1', lastClock: 0, origin: { kind: 'agent', name: 'script' } }))
		await waitFor(() => inbox.some((m) => m.t === 'hello'))
		const push = { t: 'push', seq: 1, baseClock: 0, code: ['A > B\n'], records: [{ id: 'pin:A', value: { x: 'nope' } }, { id: 'pin:B', value: { x: 1, y: 2 } }] }
		ws.send(JSON.stringify(push))
		await waitFor(() => inbox.some((m) => m.t === 'ack'))
		const ack = inbox.find((m) => m.t === 'ack')!
		expect(ack).toMatchObject({ t: 'ack', seq: 1, clock: 1, rejected: [{ id: 'pin:A', value: null }] })
		ws.send(JSON.stringify(push)) // lost-ack replay
		await waitFor(() => inbox.filter((m) => m.t === 'ack').length === 2)
		const room = h.rooms.get('raw')
		expect(room.code).toBe('A > B\n')
		expect(room.clock).toBe(1)
		expect(room.records.get('pin:B')).toEqual({ x: 1, y: 2 })
		ws.send(JSON.stringify({ t: 'push', seq: 2, baseClock: 1, code: [99, 'x'] }))
		await waitFor(() => inbox.some((m) => m.t === 'error'))
		expect(inbox.find((m) => m.t === 'error')).toMatchObject({ code: 'resync' })
		ws.close()
	})

	it('rejects bad connects', async () => {
		const h = await start()
		const ws = new WebSocket(h.url)
		const inbox: ServerMessage[] = []
		ws.on('message', (d) => inbox.push(JSON.parse(d.toString())))
		const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)))
		await new Promise((r) => ws.on('open', r))
		ws.send(JSON.stringify({ t: 'connect', protocol: 1, docId: '../etc', clientId: 'x', lastClock: 0, origin: { kind: 'human', name: 'x' } }))
		expect(await closed).toBe(4000)
		expect(inbox[0]).toMatchObject({ t: 'error', code: 'bad_doc_id', fatal: true })
		const evil = new WebSocket(h.url, { headers: { origin: 'https://evil.example' } })
		await expect(new Promise((_, rej) => evil.on('error', rej))).rejects.toThrow(/403/)
	})

	it('reconnects, replays offline edits and merges them', async () => {
		const h = await start()
		const { net, Ctor } = flakyNet()
		const a = client(h, { WebSocket: Ctor })
		const b = client(h)
		await waitFor(() => a.status === 'online' && b.status === 'online')
		a.setCode('A > B\n')
		await converged(h, [a, b])

		// a goes offline
		net.down = true
		for (const ws of h.sync.wss.clients) ws.terminate()
		await waitFor(() => a.status === 'offline')
		type(a, () => a.getCode().length, 'B > C\n')
		a.setPin('C', { x: 5, y: 5 })
		await waitFor(() => b.status === 'online', 3000, 'b back online')
		b.applyLocalCodeEdit([{ from: 0, to: 0, insert: 'title T\n' }])
		await waitFor(() => !b.hasPending())
		expect(a.hasPending()).toBe(true)

		net.down = false
		a.reconnect()
		await converged(h, [a, b])
		expect(a.getCode()).toBe('title T\nA > B\nB > C\n')
		await waitFor(() => b.getPins().C?.x === 5)
	})

	it('presence is broadcast and cleared on disconnect', async () => {
		const h = await start()
		const events: PresenceEvent[] = []
		const a = client(h, { origin: { kind: 'human', name: 'ada' }, onPresence: (e) => events.push(e) })
		const agent = client(h, { origin: { kind: 'agent', name: 'claude' } })
		await waitFor(() => a.status === 'online' && agent.status === 'online')
		agent.setPresence({ status: 'thinking', cursor: { x: 10, y: 20 } })
		await waitFor(() => a.getPeers().some((p) => p.state.status === 'thinking'))
		const peer = a.getPeers()[0]
		expect(peer.origin).toEqual({ kind: 'agent', name: 'claude' })
		expect(peer.state.cursor).toEqual({ x: 10, y: 20 })
		// a late joiner gets current presence in hello
		const late = client(h)
		await waitFor(() => late.getPeers().length === 1)
		agent.close()
		await waitFor(() => a.getPeers().length === 0)
		expect(events.at(-1)?.changed).toMatchObject({ state: null })
	})

	it('offline queue survives a reload through storage hooks', async () => {
		const h = await start()
		const disk = new Map<string, PersistedClientState>()
		const storage = { load: (id: string) => disk.get(id), save: (id: string, s: PersistedClientState) => void disk.set(id, JSON.parse(JSON.stringify(s))) }
		const { net, Ctor } = flakyNet()
		net.down = true
		const a = client(h, { storage, WebSocket: Ctor })
		await a.ready
		a.setCode('Offline > Edit\n')
		a.upsertShape({ id: 'p', type: 'pen', x: 0, y: 0, w: 0, h: 0, color: 'ink', size: 1, points: [[0, 0, 0.5], [1, 1, 0.5]] })
		a.close() // tab closed while offline
		expect(disk.get(DEFAULT_DOC_ID)?.buffer.code).toBeTruthy()

		const other = client(h)
		await waitFor(() => other.status === 'online')
		other.setCode('Online > Edit\n')
		await converged(h, [other])

		const reloaded = client(h, { storage })
		await converged(h, [reloaded, other])
		expect(reloaded.clientId).toBe(a.clientId)
		const code = h.rooms.get(DEFAULT_DOC_ID).code
		expect(code).toContain('Offline > Edit')
		expect(code).toContain('Online > Edit')
		await waitFor(() => other.getShapes().length === 1)
	})

	it('persists rooms atomically and reloads them', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'octo-sync-'))
		const h = await start(dir)
		const a = client(h, { docId: 'roadmap' })
		await waitFor(() => a.status === 'online')
		a.setCode('Plan > Build\n')
		a.setPin('Plan', { x: 1, y: 2 })
		a.setMeta({ title: 'Roadmap' })
		await converged(h, [a], 'roadmap')
		h.rooms.flushAll()
		const file = JSON.parse(readFileSync(join(dir, 'roadmap.json'), 'utf8'))
		expect(file.format).toBe('octo-room')
		expect(validateDocument(file.document).ok).toBe(true)
		expect(file.document).toMatchObject({ code: 'Plan > Build\n', title: 'Roadmap', pins: { Plan: { x: 1, y: 2 } } })
		expect(readFileSync(join(dir, 'roadmap.log.jsonl'), 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(1)

		const again = new RoomManager({ dir, idleMs: 0 })
		const room = again.get('roadmap')
		expect(room.code).toBe('Plan > Build\n')
		expect(room.clock).toBe(h.rooms.get('roadmap').clock)
		expect(room.snapshot().pins).toEqual({ Plan: { x: 1, y: 2 } })
		expect(again.list()).toContain('roadmap')
		again.close()
	})
})

describe('REST/SSE adapter on rooms', () => {
	it('PUT /api/doc reaches WebSocket clients and WS edits reach GET/SSE', async () => {
		const h = await start()
		const c = client(h)
		await waitFor(() => c.status === 'online')
		const sse = await fetch(`${h.base}/api/doc/events`)
		const reader = sse.body!.getReader()
		const res = await fetch(`${h.base}/api/doc`, { method: 'PUT', body: JSON.stringify({ code: 'A > B\n', source: 'mcp' }) })
		expect(res.status).toBe(200)
		await waitFor(() => c.getCode() === 'A > B\n')
		c.applyLocalCodeEdit([{ from: 6, to: 6, insert: 'B > C\n' }])
		await converged(h, [c])
		const doc = await json(fetch(`${h.base}/api/doc`))
		expect(doc.code).toBe('A > B\nB > C\n')
		let text = ''
		while (!text.includes('B > C')) text += new TextDecoder().decode((await reader.read()).value)
		expect(text).toContain('"source":"mcp"')
		await reader.cancel()
		// baseVersion conflicts only on code changes
		const stale = await fetch(`${h.base}/api/doc`, { method: 'PUT', body: JSON.stringify({ code: 'X', baseVersion: 1 }) })
		expect(stale.status).toBe(409)
		c.setPin('A', { x: 1, y: 1 })
		await converged(h, [c])
		const fresh = await fetch(`${h.base}/api/doc`, { method: 'PUT', body: JSON.stringify({ code: 'X\n', baseVersion: doc.version }) })
		expect(fresh.status).toBe(200)
	})

	it('docId selects a room for REST and actions', async () => {
		const h = await start()
		const c = client(h, { docId: 'side' })
		await waitFor(() => c.status === 'online')
		const r = await fetch(`${h.base}/api/doc/actions?docId=side`, {
			method: 'POST',
			body: JSON.stringify({ actions: [{ type: 'addEdge', from: 'X', to: 'Y' }], source: 'mcp' }),
		})
		expect((await json(r)).applied).toBe(1)
		await waitFor(() => c.getCode().includes('X > Y'))
		expect((await json(fetch(`${h.base}/api/doc`))).code).toBe('')
		expect((await fetch(`${h.base}/api/doc?docId=../x`)).status).toBe(400)
		const one = await json(fetch(`${h.base}/api/docs/side`))
		expect(one.document.code).toContain('X > Y')
		expect((await json(fetch(`${h.base}/api/docs`))).docs).toContain('side')
	})

	it('a streaming agent writer merges with concurrent typing', async () => {
		const h = await start()
		const human = client(h)
		await waitFor(() => human.status === 'online')
		human.setCode('A > B\n')
		await converged(h, [human])
		const room = h.rooms.get(DEFAULT_DOC_ID)
		const write = new RoomDocStore(room).writer('agent', 'A > B\n')
		let k = 0
		type(human, () => k++, 'title Mine\n')
		await converged(h, [human])
		write('A > B\nB > C\n') // agent step 1 (computed from its stale start)
		type(human, () => human.getCode().length, 'Z > A\n')
		await converged(h, [human])
		write('A > B\nB > C\nC > D\n') // step 2
		await converged(h, [human])
		expect(room.code).toBe('title Mine\nA > B\nB > C\nZ > A\nC > D\n')
	})
})
