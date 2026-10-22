/** WebSocket endpoint (`/api/sync`) that connects sessions to rooms. */

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { isOrigin, isValidDocId, SYNC_PROTOCOL_VERSION, type ClientMessage, type ErrorMessage, type ServerMessage } from '@octo-draw/core/src/sync'
import { RoomError, type Room, type Session } from './room'
import type { RoomManager } from './rooms'

export const SYNC_PATH = '/api/sync'

export interface SyncServerOptions {
	path?: string
	/** Max frame size in bytes. Default 8 MB (images are data URLs). */
	maxPayload?: number
	/** Max serialized presence size in bytes. Default 8 KB. */
	maxPresence?: number
	/** ms to wait for the connect message. Default 10 s. */
	connectTimeoutMs?: number
	/** ms between server pings; sockets that miss one are dropped. Default 30 s. */
	heartbeatMs?: number
	/** Allowed browser origins (Origin header). Default: localhost only. Requests without Origin (CLI/agents) are allowed. */
	allowOrigin?: (origin: string) => boolean
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

export interface SyncServer {
	wss: WebSocketServer
	close(): Promise<void>
}

/** Attaches the sync endpoint to an HTTP server. */
export function attachSync(server: Server, rooms: RoomManager, opts: SyncServerOptions = {}): SyncServer {
	const path = opts.path ?? SYNC_PATH
	const maxPresence = opts.maxPresence ?? 8192
	const allowOrigin = opts.allowOrigin ?? ((o: string) => LOCAL_ORIGIN.test(o))
	const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? 8 * 1024 * 1024 })
	const alive = new WeakSet<WebSocket>()

	const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		if (url.pathname.replace(/\/+$/, '') !== path) return
		const origin = req.headers.origin
		if (origin && !allowOrigin(origin)) {
			socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
	}
	server.on('upgrade', onUpgrade)

	wss.on('connection', (ws: WebSocket) => {
		alive.add(ws)
		ws.on('pong', () => alive.add(ws))
		let room: Room | null = null
		let session: Session | null = null
		const send = (msg: ServerMessage) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
		}
		const fail = (code: ErrorMessage['code'], message: string, fatal = false) => {
			send({ t: 'error', code, message, fatal: fatal || undefined })
			if (fatal) ws.close(4000, code)
		}
		const connectTimer = setTimeout(() => fail('protocol', 'expected a connect message', true), opts.connectTimeoutMs ?? 10000)

		ws.on('message', (data, isBinary) => {
			if (isBinary) return fail('bad_message', 'binary frames are not supported', true)
			let msg: ClientMessage
			try {
				msg = JSON.parse(data.toString()) as ClientMessage
			} catch {
				return fail('bad_message', 'invalid JSON', true)
			}
			if (!msg || typeof msg !== 'object') return fail('bad_message', 'message must be an object', true)
			try {
				if (msg.t === 'connect') {
					if (session) return fail('protocol', 'already connected', true)
					if (msg.protocol !== SYNC_PROTOCOL_VERSION) return fail('protocol', `protocol ${SYNC_PROTOCOL_VERSION} required`, true)
					if (!isValidDocId(msg.docId)) return fail('bad_doc_id', 'invalid docId', true)
					if (typeof msg.clientId !== 'string' || !msg.clientId || msg.clientId.length > 128) return fail('bad_message', 'invalid clientId', true)
					if (!isOrigin(msg.origin)) return fail('bad_message', 'origin must be { kind: human|agent, name }', true)
					const lastClock = Number.isSafeInteger(msg.lastClock) && msg.lastClock >= 0 ? msg.lastClock : 0
					clearTimeout(connectTimer)
					room = rooms.get(msg.docId)
					session = { id: randomUUID(), clientId: msg.clientId, origin: msg.origin, send, presence: null }
					room.join(session, lastClock)
					return
				}
				if (msg.t === 'ping') return send({ t: 'pong' })
				if (!room || !session) return fail('not_connected', 'send connect first', true)
				if (msg.t === 'push') {
					if (msg.origin !== undefined && !isOrigin(msg.origin)) return fail('bad_message', 'invalid origin')
					return room.push(session, msg)
				}
				if (msg.t === 'presence') {
					const state = msg.state
					if (state !== null && (typeof state !== 'object' || Array.isArray(state))) return fail('bad_message', 'presence must be an object or null')
					if (state && JSON.stringify(state).length > maxPresence) return fail('too_large', 'presence too large')
					return room.setPresence(session.id, state)
				}
				return fail('bad_message', `unknown message type ${JSON.stringify((msg as { t?: unknown }).t)}`)
			} catch (err) {
				if (err instanceof RoomError) return fail(err.code, err.message)
				console.error('[octo-draw] sync error:', err)
				return fail('server_error', 'internal error')
			}
		})

		ws.on('close', () => {
			clearTimeout(connectTimer)
			if (room && session) room.leave(session.id)
		})
		ws.on('error', () => {})
	})

	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			if (!alive.has(ws)) {
				ws.terminate()
				continue
			}
			alive.delete(ws)
			ws.ping()
		}
	}, opts.heartbeatMs ?? 30000)
	heartbeat.unref?.()

	return {
		wss,
		close: () =>
			new Promise<void>((resolve) => {
				clearInterval(heartbeat)
				server.off('upgrade', onUpgrade)
				for (const ws of wss.clients) ws.terminate()
				wss.close(() => resolve())
			}),
	}
}
