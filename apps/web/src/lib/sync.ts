import { pushHistory, snapshot, useStore } from '../store'
import { expectPresence } from './presence'

/**
 * Keeps the server's shared document (/api/doc) in sync with the editor so
 * MCP / external agents can read and edit the live diagram. Writes are
 * debounced; incoming SSE events that echo our own writes are ignored via a
 * per-tab source id + version counter. Everything fails silently when no server runs.
 */
const mySource = `web:${Math.random().toString(36).slice(2)}`

/** This tab's source id: server writes tagged with it are not echoed back as remote edits. */
export const syncSource = () => mySource
let serverVersion = 0
let lastSent: string | null = null
let online = false
let es: EventSource | null = null
let putTimer: ReturnType<typeof setTimeout> | undefined
let retry = 2000
let badgeTimer: ReturnType<typeof setTimeout> | undefined

interface DocMessage {
	code?: string
	version?: number
	source?: string
}

async function put(code: string) {
	if (!online) return
	lastSent = code
	try {
		const res = await fetch('/api/doc', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code, source: mySource }),
		})
		if (!res.ok) return
		const data = (await res.json().catch(() => ({}))) as DocMessage
		if (typeof data.version === 'number') serverVersion = Math.max(serverVersion, data.version)
	} catch {
		// server went away; the event stream error handler takes it offline
	}
}

function applyRemote(msg: DocMessage) {
	if (typeof msg.code !== 'string') return
	if (msg.source === mySource) {
		if (typeof msg.version === 'number') serverVersion = Math.max(serverVersion, msg.version)
		return
	}
	if (typeof msg.version === 'number') {
		if (msg.version <= serverVersion) return
		serverVersion = msg.version
	}
	const s = useStore.getState()
	if (msg.code === s.code || msg.code === lastSent) return
	pushHistory(snapshot())
	lastSent = msg.code
	// an external (MCP) agent edited the doc: animate its presence over the changed nodes
	expectPresence('Agent', 2500)
	useStore.setState({ code: msg.code, aiBusy: s.aiBusy ?? 'Agent is drawing…' })
	clearTimeout(badgeTimer)
	badgeTimer = setTimeout(() => {
		if (useStore.getState().aiBusy === 'Agent is drawing…') useStore.setState({ aiBusy: null })
	}, 1600)
}

function connect() {
	es?.close()
	es = new EventSource('/api/doc/events')
	es.onmessage = (ev) => {
		try {
			applyRemote(JSON.parse(ev.data) as DocMessage)
		} catch {
			// ignore
		}
	}
	es.onerror = () => {
		es?.close()
		es = null
		online = false
		scheduleProbe()
	}
}

let probeTimer: ReturnType<typeof setTimeout> | undefined
function scheduleProbe() {
	clearTimeout(probeTimer)
	probeTimer = setTimeout(probe, retry)
	retry = Math.min(retry * 2, 30000)
}

async function probe() {
	try {
		const res = await fetch('/api/doc', { headers: { accept: 'application/json' } })
		if (!res.ok) throw new Error(String(res.status))
		const data = (await res.json().catch(() => ({}))) as DocMessage
		if (typeof data.version === 'number') serverVersion = data.version
		online = true
		retry = 2000
		// local document wins on (re)connect
		await put(useStore.getState().code)
		connect()
	} catch {
		online = false
		scheduleProbe()
	}
}

export function startSync() {
	useStore.subscribe((s, prev) => {
		if (s.code === prev.code || !online) return
		if (s.code === lastSent) return
		clearTimeout(putTimer)
		putTimer = setTimeout(() => put(useStore.getState().code), s.aiBusy ? 600 : 300)
	})
	void probe()
}
