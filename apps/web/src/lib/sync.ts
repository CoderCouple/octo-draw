import { create } from 'zustand'
import type { FreeShape, Point } from '@octo-draw/core'
import { createSyncClient, type PeerPresence, type PersistedClientState, type Presence, type RemoteEvent, type SyncClient, type TextChange } from '@octo-draw/core/src/sync'
import { pushHistory, selectedIds, selectedKeys, snapshot, useStore } from '../store'
import { expectPresence } from './presence'

/**
 * Live sync with the server room over WebSocket (/api/sync, docs/SYNC.md).
 *
 * - Code: CodeMirror transactions go out as OT changes (`localCodeEdit`), remote
 *   ops come back as CodeMirror changes so carets stay put; any other store code
 *   change (toolbar, undo, AI generate, examples) is diffed with `setCode`.
 * - Records: pins → `setPin`, free shapes → `upsertShape`/`deleteShape`, title → `setMeta`.
 * - Presence: our canvas cursor, selection and agent status; peers land in `usePeers`.
 */

export type ConnState = 'off' | 'connecting' | 'synced' | 'syncing' | 'reconnecting' | 'offline'

interface PeersState {
	peers: PeerPresence[]
	conn: ConnState
}
export const usePeers = create<PeersState>(() => ({ peers: [], conn: 'off' }))

const NAME_KEY = 'octo-draw:name'
const COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f']

function myName(): string {
	try {
		const saved = localStorage.getItem(NAME_KEY)
		if (saved) return saved
		const name = `Guest ${Math.floor(1000 + Math.random() * 9000)}`
		localStorage.setItem(NAME_KEY, name)
		return name
	} catch {
		return 'Guest'
	}
}

/** Stable color for a participant (by client id). */
export function peerColor(id: string): string {
	let h = 0
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
	return COLORS[Math.abs(h) % COLORS.length]
}

/** Display name: agents' sources look like `agent:AI`. */
export const peerName = (p: PeerPresence) => p.state.name ?? p.origin.name.replace(/^(agent|web|human):/, '')

/** This tab's source id for REST calls (the agent stream writes into the room under an agent origin). */
const mySource = `web:${Math.random().toString(36).slice(2)}`
export const syncSource = () => mySource

let client: SyncClient | null = null
/** Bound = our local state mirrors the client's (after restoring storage or the first hello). */
let bound = false
let lastCode = ''
let lastPins: Record<string, Point> = {}
let lastShapes: FreeShape[] = []
let lastTitle = ''
let badgeTimer: ReturnType<typeof setTimeout> | undefined

/** True while the server room is the writer of record (agent runs then skip local writes). */
export const syncOnline = () => !!client && client.status === 'online' && bound

// ---- editor bridge

interface EditorBridge {
	getText(): string
	/** Apply changes (in coordinates of the current editor text) without echoing them back. */
	applyRemote(changes: TextChange[]): void
}
let editor: EditorBridge | null = null

export function bindEditor(bridge: EditorBridge): () => void {
	editor = bridge
	return () => {
		if (editor === bridge) editor = null
	}
}

/** Called by the editor for each local transaction, before the store sees the new text. */
export function localCodeEdit(changes: TextChange[], nextText: string) {
	if (!client || !bound || !changes.length) return
	if (client.getCode() !== lastCode) return // diverged; the store subscription diffs instead
	try {
		client.applyLocalCodeEdit(changes)
		lastCode = client.getCode()
		if (lastCode !== nextText) {
			client.setCode(nextText)
			lastCode = nextText
		}
	} catch (err) {
		console.warn('sync: local edit failed', err)
	}
}

// ---- remote → local

function shapesFromClient(c: SyncClient): FreeShape[] {
	return c.getShapes()
}

function applyRemoteCode(text: string, changes: TextChange[]) {
	const s = useStore.getState()
	if (text === s.code) {
		lastCode = text
		return
	}
	// hand CodeMirror the op itself when it is still on the text the op was made for
	if (editor && editor.getText() === lastCode && s.code === lastCode) editor.applyRemote(changes)
	lastCode = text
	useStore.setState({ code: text })
}

function onRemote(e: RemoteEvent) {
	if (!client) return
	if (!bound) return bindFromServer()
	// our own agent run already made its undo step and presence window
	const isAgent = e.origin?.kind === 'agent' && !(presence.status === 'thinking' || presence.status === 'drawing')
	if (isAgent) {
		pushHistory(snapshot(), 'agent-remote', 4000)
		expectPresence(e.origin!.name.replace(/^agent:/, '') || 'Agent', 2500)
		const s = useStore.getState()
		if (!s.aiBusy) useStore.setState({ aiBusy: 'Agent is drawing…' })
		clearTimeout(badgeTimer)
		badgeTimer = setTimeout(() => {
			if (useStore.getState().aiBusy === 'Agent is drawing…') useStore.setState({ aiBusy: null })
		}, 1600)
	}
	if (e.code) applyRemoteCode(e.code.text, e.code.changes)
	if (e.records?.length) {
		const patch: Partial<ReturnType<typeof useStore.getState>> = {}
		if (e.records.some((r) => r.id.startsWith('pin:'))) {
			lastPins = client.getPins()
			patch.pins = lastPins
		}
		if (e.records.some((r) => r.id.startsWith('shape:'))) {
			lastShapes = shapesFromClient(client)
			patch.shapes = lastShapes
		}
		if (e.records.some((r) => r.id === 'meta')) {
			const title = client.getMeta()?.title
			if (typeof title === 'string' && title !== useStore.getState().title) {
				lastTitle = title
				patch.title = title
			}
		}
		if (Object.keys(patch).length) useStore.setState(patch)
	}
}

/** First contact with the server: an empty room gets our document, otherwise the room wins. */
function bindFromServer() {
	if (!client || bound) return
	bound = true
	const s = useStore.getState()
	const serverCode = client.getCode()
	const serverEmpty = !serverCode.trim() && !client.getShapes().length
	if (serverEmpty) {
		if (s.code.trim()) client.setCode(s.code)
		lastCode = client.getCode()
		pushRecords()
		return
	}
	lastCode = serverCode
	lastPins = client.getPins()
	lastShapes = shapesFromClient(client)
	const title = client.getMeta()?.title
	lastTitle = typeof title === 'string' ? title : s.title
	useStore.setState({ code: serverCode, pins: lastPins, shapes: lastShapes, title: lastTitle })
}

// ---- local → remote

function pushRecords() {
	if (!client || !bound) return
	const s = useStore.getState()
	try {
		if (s.pins !== lastPins) {
			for (const [k, p] of Object.entries(s.pins)) if (!lastPins[k] || lastPins[k].x !== p.x || lastPins[k].y !== p.y) client.setPin(k, p)
			for (const k of Object.keys(lastPins)) if (!s.pins[k]) client.setPin(k, null)
			lastPins = s.pins
		}
		if (s.shapes !== lastShapes) {
			const before = new Map(lastShapes.map((x) => [x.id, x]))
			const now = new Set(s.shapes.map((x) => x.id))
			for (const sh of s.shapes) if (before.get(sh.id) !== sh) safe(() => client!.upsertShape(sh))
			for (const id of before.keys()) if (!now.has(id)) client.deleteShape(id)
			lastShapes = s.shapes
		}
		if (s.title !== lastTitle) {
			lastTitle = s.title
			client.setMeta({ title: s.title })
		}
	} catch (err) {
		console.warn('sync: record write failed', err)
	}
}

const safe = (fn: () => void) => {
	try {
		fn()
	} catch (err) {
		console.warn('sync:', (err as Error).message)
	}
}

// ---- presence

let presence: Presence = {}
function updatePresence(patch: Partial<Presence>) {
	presence = { ...presence, ...patch }
	client?.setPresence(presence)
}

/** Canvas pointer in world coordinates (null when it leaves the canvas). */
export function setLocalCursor(p: Point | null) {
	if (!client) return
	const cur = presence.cursor
	if (p && cur && Math.abs(cur.x - p.x) < 0.5 && Math.abs(cur.y - p.y) < 0.5) return
	updatePresence({ cursor: p ? { x: Math.round(p.x), y: Math.round(p.y) } : null })
}

/** What this tab's AI is doing, shown to peers ("Guest 1234's AI is thinking…"). */
export function setAgentStatus(status: Presence['status'], message?: string) {
	updatePresence({ status, message })
}

// ---- storage (offline queue survives reloads). Per tab: sessionStorage, because the
// saved state carries the clientId and two tabs sharing one would look like replays.

const storage = {
	load(docId: string): PersistedClientState | null {
		try {
			const raw = sessionStorage.getItem(`octo-draw:sync:${docId}`)
			return raw ? (JSON.parse(raw) as PersistedClientState) : null
		} catch {
			return null
		}
	},
	save(docId: string, state: PersistedClientState) {
		try {
			sessionStorage.setItem(`octo-draw:sync:${docId}`, JSON.stringify(state))
		} catch {
			// quota: the server still has everything confirmed
		}
	},
}

function connState(c: SyncClient): ConnState {
	if (c.status === 'online') return c.hasPending() ? 'syncing' : 'synced'
	if (c.status === 'connecting') return bound ? 'reconnecting' : 'connecting'
	if (c.status === 'offline') return 'offline'
	return 'off'
}

export function startSync(docId = new URLSearchParams(location.search).get('doc') || 'default') {
	if (client) return
	const name = myName()
	const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sync`
	let statusTimer: ReturnType<typeof setTimeout> | undefined
	const refreshConn = () => {
		clearTimeout(statusTimer)
		if (client) usePeers.setState({ conn: connState(client) })
		// pending → synced flips without an event; poll briefly while edits are in flight
		if (client?.hasPending()) statusTimer = setTimeout(refreshConn, 300)
	}
	client = createSyncClient({
		url,
		docId,
		origin: { kind: 'human', name },
		storage,
		onRemote,
		onStatus: (st) => {
			if (st === 'online' && !bound) bindFromServer()
			refreshConn()
		},
		onPresence: ({ peers }) => usePeers.setState({ peers }),
		onError: (err) => console.warn('sync:', err.code, err.message),
	})
	presence = { name, color: peerColor(client.clientId), status: 'idle' }
	client.setPresence(presence)
	usePeers.setState({ conn: 'connecting' })

	// restored offline state: show it right away (pending edits replay on connect)
	void client.ready.then(() => {
		if (!client || bound || client.status === 'online') return
		const saved = storage.load(docId)
		if (!saved) return
		bound = true
		lastCode = client.getCode()
		lastPins = client.getPins()
		lastShapes = shapesFromClient(client)
		lastTitle = client.getMeta()?.title ?? useStore.getState().title
		useStore.setState({ code: lastCode, pins: lastPins, shapes: lastShapes, title: lastTitle })
	})

	useStore.subscribe((s, prev) => {
		if (!client) return
		if (bound && s.code !== prev.code && s.code !== lastCode) {
			client.setCode(s.code)
			lastCode = s.code
		}
		if (s.pins !== prev.pins || s.shapes !== prev.shapes || s.title !== prev.title) pushRecords()
		if (s.selection !== prev.selection) updatePresence({ selection: [...selectedKeys(s.selection), ...selectedIds(s.selection)] })
		refreshConn()
	})
	window.addEventListener('online', () => client?.reconnect())
}

// dev-only handle for headless tests
if (import.meta.env.DEV) (globalThis as unknown as { __octoSync?: unknown }).__octoSync = { setAgentStatus, usePeers }
