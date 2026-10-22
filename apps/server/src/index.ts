import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { createApp } from './app'
import { createStreamFn, fallbacksEnabled, hasCredentials, MODEL, NO_CREDENTIALS, type StreamFn } from './claude'
import { DocStore } from './docStore'

const PORT = Number(process.env.PORT ?? 8787)
const DOC_FILE = resolve(process.env.OCTO_DOC_FILE ?? './data/doc.json')

const store = new DocStore(DOC_FILE)
let stream: StreamFn | null = null

if (await hasCredentials()) {
	stream = createStreamFn()
	console.log(`[octo-draw] AI enabled (${MODEL}, refusal fallbacks ${fallbacksEnabled() ? 'on' : 'off'})`)
} else {
	console.warn(`[octo-draw] ${NO_CREDENTIALS}. AI endpoints will return 503.`)
}

const server = createServer(createApp({ store, getStream: () => stream }))
server.listen(PORT, () => {
	console.log(`[octo-draw] server on http://localhost:${PORT} (doc: ${DOC_FILE})`)
})

const shutdown = () => {
	server.close(() => process.exit(0))
	server.closeAllConnections()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
