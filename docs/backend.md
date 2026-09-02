# Backend

Node, no framework. Three layers, deliberately stacked so that only the bottom
one knows what a CRDT is.

```
transport/   sockets, rooms, routing, presence      <- engine-agnostic
engines/     concurrency control                    <- the ONLY Yjs-aware layer
storage/     append-only log + snapshots            <- engine-agnostic (opaque bytes)
```

Read `transport/room.js` first. It is the only file that knows about both
sockets and engines, and it is intentionally short.

## Request lifecycle

A client connects to `ws://localhost:8080?doc=<id>&client=<id>`.

1. `transport/server.js` parses `doc` and `client` off the query string and
   finds or creates the `Room` for that document.
2. `Room` constructor loads the document: newest snapshot + every update logged
   after it, handed to `engine.restore()`.
3. `room.join()` sends, in order: `MSG_HELLO`, a presence snapshot of everyone
   already in the room, then whatever `engine.onClientJoin()` returns (for Yjs,
   a `SYNC_STEP1` carrying the server's state vector).
4. Every subsequent frame goes to `room.handle()`, which switches on the
   envelope type and never looks inside an engine payload.

## The engine seam

`engines/doc-engine.js` defines the contract. The important method:

```js
handleMessage(clientId, payload) -> { toSender?: Uint8Array[], toOthers?: Uint8Array[] }
```

It returns a **routing decision**, not bytes. A CRDT engine almost always
returns only `toOthers` — the sender already applied its own edit locally. An
OT engine must return both, because the sender needs an acknowledgement
carrying the revision number the server assigned. Building that in now is what
keeps OT from being a rewrite. See ADR-002.

`YjsEngine` keeps a server-side `Y.Doc` even though it never has to merge
anything, for three reasons: to answer `SYNC_STEP1` with a minimal delta, to
produce compacted snapshots, and so a late joiner does not replay the whole
update log.

One subtlety worth noting: on receiving an update, the engine re-derives the
delta from its own state (`encodeStateAsUpdate(doc, before)`) rather than
forwarding the client's bytes verbatim. That normalises the payload and means a
misbehaving client cannot inject bytes the server never applied.

## The OT engine

`engines/ot-engine.js` is the second implementation of the same interface, and
the reason the interface has the shape it does.

The entire algorithm is four lines in `handleMessage`:

```js
for (const other of concurrent) [op] = TextOperation.transform(op, other);
this.text = op.apply(this.text);
this.history.push(op);
this.rev++;
```

`concurrent` is `history.slice(clientRev - historyBase)` — every revision the
client had not seen when it wrote its op. Everything else in the file is
bookkeeping: persistence, the debug transform log, and the `RESYNC` path.

|  | `YjsEngine` (CRDT) | `OTEngine` |
|---|---|---|
| Server knows the edits? | No, it relays opaque bytes | Yes, it owns the document |
| Ordering | Per-character ids | One revision counter |
| Concurrent edits | Merge by construction | Rebased against history |
| Reply to sender | Never | Always — an `ACK` with the assigned revision |
| Client joins | State vector exchange, delta only | Full document, every time |
| Offline for an hour | Merges on reconnect | `RESYNC`, pending edits discarded |
| Horizontal scale | Route anywhere | One writer per document |

That `toSender` ack is precisely why `handleMessage` returns a routing decision
rather than bytes. See [ADR-004](decisions/004-ot-engine.md).

The algorithm itself lives in `shared/ot`, deliberately outside the server: it
is pure, has no network dependency, and is property-tested on its own by
`tools/ot-properties.mjs`.

### Running it

The engine is process-wide, chosen by flag, so the two run as separate servers:

```bash
npm run dev:server      # port 8080, engine=yjs
npm run dev:server:ot   # port 8081, engine=ot
```

`npm run dev` starts both plus the client. Storage is per-engine — the `yjs`
and `ot` Postgres schemas — because the snapshot formats differ: Yjs writes an
encoded update, OT writes `{text, rev}` as JSON.

## Storage

Postgres, via `pg`. The host's filesystem is ephemeral, so nothing durable may
be written to it and Postgres holds every byte that matters; see
[ADR-019](decisions/019-postgres-source-of-truth.md) for that rule and for what
it allows in front of the database. Two tables:

| Table | Shape | Why |
|---|---|---|
| `updates` | `(seq, doc_id, data bytea, created)` | Append-only. O(1) writes, so a keystroke never waits on a merge. `seq` is a `bigint` identity, so it stays monotonic across rows being deleted beneath it. |
| `snapshots` | `(doc_id, data bytea, through_seq, created)` | Full state as of a sequence number. |

Load = snapshot + updates after `through_seq`. **Compaction** folds the loose
updates into a fresh snapshot and deletes them, at `COMPACT_AFTER` loose
updates (default 200) and on graceful shutdown. It runs inside one
transaction because a crash between "write snapshot" and "delete log" would
otherwise lose edits.

Storage never imports `yjs`. It stores opaque blobs and does not know what they
mean. This is what lets the OT engine reuse it unchanged.

It is also what makes **tabs** almost free. A tab's content is stored under an
id of its own (`<document>~<tab>`), so it is an ordinary document as far as
every table here is concerned — its own log, its own snapshots, its own
compaction, its own history. The `tabs` table records only which documents are
tabs of which, in what order and under what name; a document with no rows in it
is one tab, stored at the document's own id, which is why no existing database
needed migrating ([ADR-014](decisions/014-document-tabs.md)).

Two consequences worth knowing about, both in `store.js`: `roleFor` resolves a
tab id to its document, so access is inherited rather than copied, and
`backfillDocs` skips tab ids, so a tab never gets adopted as a document of its
own.

## HTTP API

One Node `http` server carries both surfaces: the WebSocket upgrade, and a
JSON API for everything about a document that is not its text — accounts,
ownership and sharing, history, comments, tabs, tasks, search and the trash.
The full endpoint list is in the README; the rows below are the ones worth
explaining.

| Route | Returns |
|---|---|
| `GET /api/docs` | Every document in this engine's store, newest first, with size, tab count and current connection count |
| `GET /api/health` | Aggregates for this node: engine, port, open rooms, connected clients, document count, stored bytes, last write, uptime. **Counts only** — no titles, ids or owners, because the route takes no session and one that named documents would be an enumeration endpoint. Plus cumulative counters since boot -- edits merged, frames and bytes out, frames batching removed -- from `transport/metrics.js`, because a Room's own stats die with the Room. No UI renders it: it is the ops endpoint and the keep-alive target, asserted by `tools/landing-test.mjs` |
| `/api/docs/:id/tabs` | The tab list: `GET`, `POST` to add, `PATCH` to rename or reorder, `DELETE` to remove. Never content ([ADR-014](decisions/014-document-tabs.md)) |
| `/api/docs/:id/tasks` | The shared checklist: `GET`, `POST`, `PATCH` to tick or reword, `DELETE`. Anyone who can edit may tick anything ([ADR-015](decisions/015-shared-task-list.md)) |

The rule that decides what belongs here: **nothing that changes a document's
content goes over HTTP.** Content changes go over the WebSocket, where the
engine can order them against concurrent edits — an HTTP write path for text
would be a second way to mutate state that the concurrency control never
observes. Tabs, tasks, comments and sharing are *about* a document rather than
part of it, which is why they are ordinary requests.

`store.listDocs()` aggregates snapshots and loose updates in one union query,
because a document exists if it has either. Titles, owners and access live in
the `docs` table beside it; the aggregate is what answers "what is stored",
and it is cheap enough to run per request at this scale.

The API sets `Access-Control-Allow-Origin: *` because the client is served from
a different origin in development (Vite on 5173) and the endpoint exposes
nothing but document names. Putting both behind one origin should drop it.

## Presence

Lives above the engine seam — the room in `transport/`, the state in
`realtime/presence-store.js` — for three reasons, each of which is a deliberate
design position:

1. **Never persisted.** A cursor position is meaningless after you disconnect,
   and persisting it would put keystroke-rate write load on storage for data
   with a millisecond lifetime.
2. **Not engine-owned.** Cursors must behave identically under CRDT and OT.
   This is also why we avoid `y-protocols/awareness`, which would tie presence
   to Yjs.
3. **Last-write-wins per client, no merging.** Presence is a cache of the most
   recent truth. A lost update is corrected by the next one ~60ms later, so
   "correct" here is weak on purpose.

Cleanup is belt-and-braces: an explicit tombstone (`{clientId: null}`) on
disconnect for immediate removal, plus a 15s reaper for clients that vanished
without a close frame.

## Failure handling

| Failure | Behaviour |
|---|---|
| Client vanishes | Presence tombstone broadcast; room stays open |
| Room empties | Evicted after 30s idle — a page refresh should not cost a full reload from storage |
| Server killed | Clients reconnect with exponential backoff + jitter, so a restart does not produce a synchronised retry storm |
| Server restart | Room rehydrates from snapshot + log; clients' state vectors mean only deltas cross the wire |
| Malformed frame | Caught per-message in `server.js`; logged, connection survives |

Verified in `tools/restart-test.mjs`, which `SIGKILL`s the server (not `SIGINT`
— no chance for a graceful snapshot) with clients connected.

## Configuration

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | WebSocket port |
| `ENGINE` | `yjs` | Active engine |
| `DATABASE_URL` | _(required)_ | Postgres connection string; the server refuses to start without one |
| `DB_SCHEMA` | the engine name | `yjs` or `ot` (or `--schema=`). One schema per engine: an update log is bytes only its own engine can read |
| `PERSIST_WINDOW_MS` | `25` | Write-buffer window; `0` is write-through |
| `COMPACT_AFTER` | `200` | Loose updates before compaction |
| `GOOGLE_CLIENT_ID` | _(unset)_ | OAuth client id that ID tokens must name as their audience. Unset switches Google sign-in off: `/api/auth/google` answers 501 and the button is not rendered. Not a secret — it ships in the bundle too (ADR-020) |

The front end needs the same value at build time as `VITE_GOOGLE_CLIENT_ID`,
because the browser presents it to Google to get a token at all. Two names for
one public string, because one is read by the server and the other is baked
into the bundle by Vite.

Drive import (ADR-021) needs two more **front-end-only** values, because the
server never talks to Drive at all:

| Var | Meaning |
|---|---|
| `VITE_GOOGLE_API_KEY` | Google Picker API key. Restrict it to the Picker API and your origins |
| `VITE_GOOGLE_PROJECT_NUMBER` | The Cloud project *number*, not its id. The Picker sends it as `appId`, which is what makes a picked file fall under the `drive.file` grant — without it the export 404s in a way that looks like a missing file |

All three are public. With any of them missing the Import button is not
rendered, which is the correct state for a checkout with no Google project
behind it.

`GOOGLE_JWKS_URI` and `GOOGLE_ISSUERS` also exist and are **for the harness**.
`tools/google-auth-test.mjs` stands up a local issuer it holds the private key
for, because every assertion worth making about a token verifier is a refusal
the real Google will never issue. Pointing them anywhere but Google in a
deployment means accepting identity assertions from whatever is there instead.

## Known gaps

- One process, one machine. Multi-node fan-out via pub/sub is Phase 8.
- Snapshots are full-state, so compaction cost grows with document size.
- No backpressure. A slow socket buffers without limit.
