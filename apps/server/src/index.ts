import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocument } from '@octo-draw/core'
import { createApp } from './app'
import { createStreamFn, fallbacksEnabled, hasCredentials, MODEL, NO_CREDENTIALS, type StreamFn } from './claude'
import { attachSync, DEFAULT_DOC_ID, RoomDocStore, RoomManager, SYNC_PATH, type Room } from './sync'

const PORT = Number(process.env.PORT ?? 8787)
const DOCS_DIR = resolve(process.env.OCTO_DOCS_DIR ?? './data/docs')
/** Legacy single-document file: seeds the `default` room the first time. */
const LEGACY_DOC_FILE = resolve(process.env.OCTO_DOC_FILE ?? './data/doc.json')

function legacySeed(id: string) {
	if (id !== DEFAULT_DOC_ID || !existsSync(LEGACY_DOC_FILE)) return undefined
	try {
		const raw = JSON.parse(readFileSync(LEGACY_DOC_FILE, 'utf8')) as { code?: unknown }
		return typeof raw.code === 'string' ? createDocument({ id, code: raw.code }) : undefined
	} catch {
		return undefined
	}
}

const rooms = new RoomManager({ dir: DOCS_DIR, seed: legacySeed })
const adapters = new WeakMap<Room, RoomDocStore>()
const storeForRoom = (id: string) => {
	const room = rooms.get(id)
	let a = adapters.get(room)
	if (!a) adapters.set(room, (a = new RoomDocStore(room)))
	return a
}
const store = storeForRoom(DEFAULT_DOC_ID)
let stream: StreamFn | null = null

if (await hasCredentials()) {
	stream = createStreamFn()
	console.log(`[octo-draw] AI enabled (${MODEL}, refusal fallbacks ${fallbacksEnabled() ? 'on' : 'off'})`)
} else {
	console.warn(`[octo-draw] ${NO_CREDENTIALS}. AI endpoints will return 503.`)
}

const server = createServer(createApp({ store, rooms, storeForRoom, getStream: () => stream }))
const sync = attachSync(server, rooms)
server.listen(PORT, () => {
	console.log(`[octo-draw] server on http://localhost:${PORT} (docs: ${DOCS_DIR}, live sync: ws://localhost:${PORT}${SYNC_PATH})`)
})

const shutdown = () => {
	rooms.flushAll()
	void sync.close()
	server.close(() => {
		rooms.close()
		process.exit(0)
	})
	server.closeAllConnections()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
