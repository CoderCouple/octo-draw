/**
 * Wire protocol for live collaboration (JSON text frames over WebSocket).
 * See docs/SYNC.md for the full description and message flow.
 */

import type { RecordChange } from './records'
import type { TextOp } from './textOp'

export const SYNC_PROTOCOL_VERSION = 1

/** Who made a change. Attribution is per push and is kept in the server log. */
export interface Origin {
	kind: 'human' | 'agent'
	name: string
}

/** Ephemeral per-session state. Never persisted. */
export interface Presence {
	name?: string
	color?: string
	/** Canvas pointer in world coordinates (null when off-canvas). */
	cursor?: { x: number; y: number } | null
	/** Selected node keys / shape ids. */
	selection?: string[]
	camera?: { x: number; y: number; z: number }
	/** Code editor selection (UTF-16 offsets into the code). */
	codeSelection?: { anchor: number; head: number } | null
	/** Mostly for agents: what the participant is doing right now. */
	status?: 'idle' | 'thinking' | 'drawing' | 'typing'
	/** Free text shown next to the status, e.g. "adding the cache layer". */
	message?: string
	[k: string]: unknown
}

export interface PeerPresence {
	sessionId: string
	clientId: string
	origin: Origin
	state: Presence
}

// ---- client → server

export interface ConnectMessage {
	t: 'connect'
	protocol: number
	docId: string
	/** Stable per client install/tab; used to de-duplicate replayed pushes. */
	clientId: string
	/** Last server clock this client has fully applied (0 = never synced). */
	lastClock: number
	origin: Origin
}

export interface PushMessage {
	t: 'push'
	/** Per-client sequence number, strictly increasing. */
	seq: number
	/** Server clock the push was made against. */
	baseClock: number
	code?: TextOp
	records?: RecordChange[]
	/** Overrides the session origin for this push (e.g. a named agent run). */
	origin?: Origin
}

export interface PresenceMessage {
	t: 'presence'
	state: Presence | null
}

export type ClientMessage = ConnectMessage | PushMessage | PresenceMessage | { t: 'ping' }

// ---- server → client

export interface HelloMessage {
	t: 'hello'
	docId: string
	sessionId: string
	clock: number
	/** Highest push seq from this clientId the server has applied (0 = none). */
	clientSeq: number
	/** Full current code. */
	code: string
	/** `full`: every record (drop anything else); otherwise only records changed since `lastClock` (null value = deleted). */
	full: boolean
	records: RecordChange[]
	peers: PeerPresence[]
}

export interface AckMessage {
	t: 'ack'
	seq: number
	clock: number
	/** Record writes the server refused, with the authoritative current value (null = absent). */
	rejected?: RecordChange[]
	errors?: string[]
}

export interface ChangeMessage {
	t: 'change'
	clock: number
	code?: TextOp
	records?: RecordChange[]
	origin: Origin
	clientId: string
}

export interface PeerPresenceMessage {
	t: 'presence'
	sessionId: string
	clientId: string
	origin: Origin
	/** null = the peer left. */
	state: Presence | null
}

export type SyncErrorCode = 'bad_message' | 'protocol' | 'bad_doc_id' | 'not_connected' | 'resync' | 'too_large' | 'server_error'

export interface ErrorMessage {
	t: 'error'
	code: SyncErrorCode
	message: string
	/** The server closes the socket after a fatal error. */
	fatal?: boolean
}

export type ServerMessage = HelloMessage | AckMessage | ChangeMessage | PeerPresenceMessage | ErrorMessage | { t: 'pong' }

export const DOC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const isValidDocId = (id: unknown): id is string => typeof id === 'string' && DOC_ID_RE.test(id)

export function isOrigin(v: unknown): v is Origin {
	if (typeof v !== 'object' || v === null) return false
	const o = v as Origin
	return (o.kind === 'human' || o.kind === 'agent') && typeof o.name === 'string' && o.name.length <= 100
}
