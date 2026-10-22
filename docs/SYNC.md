# Live sync

People and AI agents edit the same diagram at the same time. The server holds the authoritative copy of each document (a **room**). Clients send it small changes over a WebSocket, and the server orders them, transforms them where needed, saves them and sends them to everyone else.

All of this code was written for octo-draw. None of it comes from tldraw's sync packages, which are proprietary.

| Piece | Where |
|---|---|
| Text OT (ops, transform, compose, invert, diff) | `packages/core/src/sync/textOp.ts` |
| Records model (meta, pins, shapes) | `packages/core/src/sync/records.ts` |
| Wire protocol types | `packages/core/src/sync/protocol.ts` |
| Client state machine (no I/O) | `packages/core/src/sync/clientDoc.ts` |
| Framework-free client (`createSyncClient`) | `packages/core/src/sync/client.ts` |
| Rooms, persistence, attribution | `apps/server/src/sync/room.ts`, `rooms.ts` |
| WebSocket endpoint `/api/sync` | `apps/server/src/sync/socket.ts` |
| `/api/doc` REST + SSE adapter | `apps/server/src/sync/docStoreAdapter.ts` |

Import the client code from `@octo-draw/core/src/sync`. The package root does not re-export it yet.

## Document model

An `OctoDocument` is split into two parts:

- **`code`**: one plain-text string, merged with operational transform (OT). A person typing in CodeMirror and an agent rewriting the code can both be applied.
- **Records**, merged last-writer-wins. Each record is replaced whole, in the order the server commits writes:
  - `meta`: `{ title, theme?, meta? }`
  - `pin:<nodeKey>`: `{ x, y }`
  - `shape:<id>`: `{ z, shape: FreeShape }`. `z` sets the stacking order of the freehand layer.

The room also stores `id`, `createdAt` and `updatedAt`. Layout is never synced; each client recomputes it from the code and the pins.

### Text ops

A `TextOp` is an array that walks the whole base text once:

- `n > 0` keeps the next n characters.
- `-n` deletes the next n characters.
- A string inserts that text.

Positions are UTF-16 code units, the same as JavaScript strings and CodeMirror.

`fromChanges(len, [{ from, to, insert }])` converts CodeMirror changes, which use original-document coordinates, into an op. `toChanges(op)` converts an op back into changes. `diffText(a, b)` builds an op from two whole texts. It compares lines first, then characters within changed lines.

**Ties.** When two ops insert at the same position:

- An insert that ends in `\n` (a whole line) goes first. This way an agent adding a line never splits a word a person is halfway through typing.
- Otherwise the server's op (the one committed earlier) goes first.

Tests: `textOp.test.ts` checks TP1 (transform converges), compose, invert and diff round-trips over thousands of random cases. `clientDoc.test.ts` runs three clients with random latency, dropped connections and reconnects against a reference server, and checks that they all converge.

## Protocol (v1)

Messages are JSON text frames on `ws://<host>/api/sync`. Through the Vite dev proxy, the `/api` entry needs `ws: true`. The client sends the document id in its first message.

### Client → server

| Message | Meaning |
|---|---|
| `{ t: 'connect', protocol: 1, docId, clientId, lastClock, origin: { kind: 'human' \| 'agent', name } }` | Must be the first message. `clientId` stays the same across reconnects (and across reloads, when the client persists its state). `lastClock` is 0 on the first connect. |
| `{ t: 'push', seq, baseClock, code?: TextOp, records?: { id, value \| null }[], origin? }` | Local changes. `seq` increases strictly for each `clientId`. `baseClock` is the server clock the change was made against. `origin` overrides the session origin for this push, for example to name an agent run. |
| `{ t: 'presence', state: Presence \| null }` | Ephemeral state: `cursor`, `selection`, `camera`, `codeSelection`, `status` (`idle`, `thinking`, `drawing` or `typing`), `message`, `name`, `color`. Limited to 8 KB. Never saved. |
| `{ t: 'ping' }` | The server answers with `pong`. |

### Server → client

| Message | Meaning |
|---|---|
| `{ t: 'hello', docId, sessionId, clock, clientSeq, code, full, records, peers }` | The reply to `connect`. `code` is always the full text. If `full` is true, `records` lists every record and the client drops any others. Otherwise `records` lists only the records changed since `lastClock`, with `value: null` meaning deleted. `clientSeq` is the highest push `seq` from this `clientId` that the server has already applied. `peers` lists the current presence of the other sessions. |
| `{ t: 'ack', seq, clock, rejected?, errors? }` | Confirms your push at `clock`. `rejected` lists record writes that failed validation, each with the server's current value. |
| `{ t: 'change', clock, code?, records?, origin, clientId }` | Someone else's committed change. `code` has already been transformed onto the server text at `clock - 1`. |
| `{ t: 'presence', sessionId, clientId, origin, state \| null }` | A peer's presence changed. `null` means the peer left. |
| `{ t: 'error', code, message, fatal? }` | `resync`: the push could not be rebased, so reconnect. `bad_message`, `protocol` or `bad_doc_id`: the request was invalid. Fatal errors close the socket with code 4000. |

Each socket receives messages in commit order. For any push, every `change` committed before it arrives before its `ack`. That ordering is what keeps clients consistent.

### Server push handling

1. If `seq <= clientSeq`, the push is a replay after a lost ack. The server re-acks it and changes nothing.
2. The code op is transformed against every code op committed after `baseClock`. If `baseClock` is older than the kept history (2000 ops), or the op does not fit the text, the server sends `error: resync`.
3. Each record write is checked with `validateRecordChange`, which uses the same checks as `validateDocument`. Invalid writes are dropped and reported in the ack. Writes that change nothing are skipped.
4. If anything changed, the clock goes up by one. The server then:
   - applies the change,
   - appends an attribution entry,
   - sends an `ack` to the pusher and a `change` to everyone else,
   - schedules a save.

### Client algorithm

The client keeps three layers:

- `server`: the text and records as of `clock`,
- `inflight`: at most one unacknowledged push,
- `buffer`: local edits made since that push.

When a remote `change` arrives, its code op is transformed past `inflight` and then past `buffer`, and the result is applied locally. Remote record values are shown unless a local write to the same record is still pending. That local write will reach the server later and win, so showing the remote value would only flicker.

**Reconnect.** The client uses exponential backoff with jitter (250 ms to 10 s by default). On `hello`:

- If `inflight.seq <= clientSeq`, the server already applied the push and the client treats it as confirmed.
- Otherwise the client folds `inflight` back into `buffer` and resends it with a new `seq`.

Pending code is rebased onto the server's text with `diffText(lastConfirmedText, hello.code)`, so offline edits survive any amount of server-side history.

## Client API

```ts
import { createSyncClient } from '@octo-draw/core/src/sync'

const sync = createSyncClient({
	url: 'ws://localhost:8787/api/sync',
	docId: 'default',
	origin: { kind: 'human', name: 'Ada' },
	onRemote(e) {
		// e.code?.changes is CodeMirror-ready: view.dispatch({ changes: e.code.changes, annotations: remote })
		// e.records?: [{ id: 'pin:API', value }] → update store; e.origin says who did it
	},
	onPresence({ peers, changed }) {},
	onStatus(s) {}, // 'connecting' | 'online' | 'offline' | 'closed'
	storage: { load: (docId) => …, save: (docId, state) => … }, // optional offline queue (IndexedDB/localStorage)
})

sync.applyLocalCodeEdit([{ from, to, insert }]) // from a CodeMirror update listener (skip remote-annotated transactions)
sync.setCode(text)                               // whole-text replacement, diffed
sync.applyAgentActions(actions)                  // run AgentActions against the live code
sync.setPin('API', { x, y }) / sync.setPin('API', null)
sync.upsertShape(shape, z?) / sync.deleteShape(id)
sync.setMeta({ title })
sync.setPresence({ cursor, selection, status: 'thinking' })
await sync.whenSynced()
sync.close()
```

`storage.save` receives a JSON-serializable `PersistedClientState`: `clientId`, `clock`, the confirmed text and records, and the inflight push and buffer. It is called about 50 ms after each change. When `storage.load` returns that state, the client restores the same `clientId`, shows the pending edits right away and replays them once it connects. The client works in browsers and in Node 22 or later. To use another socket implementation (for example the `ws` package), pass it as `WebSocket`.

To map a local caret through remote edits, use `transformIndex(fromChanges(prevLen, e.code.changes), pos, -1)`. In CodeMirror you get the same result by dispatching the changes.

## Server

- **Rooms.** Rooms are keyed by `docId` (`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`). They load on demand from `./data/docs/<id>.json` (set the folder with `OCTO_DOCS_DIR`). A room with no sessions is unloaded after 60 s. The `default` room is always loaded, and on first start it is seeded from the legacy `./data/doc.json`.
- **Persistence.** The server saves after a 200 ms debounce, writing a temp file and then renaming it over the original (atomic). A document that fails `validateDocument` is never written. The file format is `{ format: 'octo-room', version: 1, clock, codeClock, clients, recordClocks, tombstoneHorizon, document: OctoDocument }`. A plain `OctoDocument` JSON dropped into the folder also loads.
- **Attribution.** Every commit appends `{ clock, at, clientId, origin, code?: { op, inverse }, records?: [{ id, before, after }] }`. Entries go to `./data/docs/<id>.log.jsonl` and to an in-memory ring of 5000 entries. Read them with `room.attribution({ kind: 'agent', name })` or `GET /api/docs/<id>/log?kind=agent&name=…&since=<clock>`. The `inverse` op and the `before` values are there so "undo agent run" can be built later.
- **Server-side writers.** These go through the same commit path:
  - `room.setCode(text, origin)`
  - `room.applyActions(actions, origin)`
  - `room.setRecords(changes, origin)`
  - `room.textWriter(origin, baseCode).write(next)`: a three-way merge for streaming agents, so concurrent typing is kept.
- **Security.** Browser upgrades must come from a localhost `Origin`. Clients without an `Origin` header, such as CLIs and agents, are allowed. Frames are limited to 8 MB. Unresponsive sockets are dropped after 30 s.

### REST compatibility

`/api/doc`, `/api/doc/events` (SSE), `/api/doc/actions`, `/api/doc/svg` and `/api/agent/stream` still work. They act on the `default` room, or on another room with `?docId=<id>`. Writes become diffs applied to the room, so WebSocket clients see them live. `version` is now the room clock. A PUT with `baseVersion` returns 409 only if the **code** changed after that clock; pin and shape edits don't conflict. `/api/agent/stream` writes each step through `textWriter`, so a person can keep typing while the agent works.

Other routes:

- `GET /api/docs` lists the rooms.
- `GET /api/docs/<id>` returns `{ clock, document }`.

Every MCP tool takes an optional `docId`.

## Known limits / next steps

- **Code ties are resolved by position.** When an agent rewrites a line a person is editing at that moment, both edits land, but the characters can interleave. The agent may then see a transient parse error, such as a half-typed node name. `applyActions` reports this as an error, and the agent can retry.
- **Records are last-writer-wins for the whole record.** Two people dragging the same shape at once end with the later drag.
- **One process.** Rooms live in memory in a single server. Scaling out would need sticky routing per `docId`, for example one Durable Object per room.
- **No auth.** Any local client can join any room.
