/**
 * A Room is one document + the sockets currently editing it.
 *
 * Everything here is engine-agnostic. The room routes frames; it never
 * inspects an engine payload. Read this file top to bottom to understand the
 * whole server -- it is the only place that knows about both sockets and
 * engines, and it is intentionally small.
 */
import {
  MSG_ENGINE, MSG_AWARENESS, MSG_HELLO, MSG_DEBUG, MSG_COMMENTS, MSG_TASKS, MSG_TABS,
  encode, decode, encodeJson, decodeJson,
} from '@collab/protocol';
import { createEngine } from '../engines/index.js';
import { canEdit } from './api.js';
import { PresenceRoom } from '../realtime/presence-store.js';
import { Store } from '../storage/store.js';
import { config } from '../config.js';
import { metrics, recordRelay } from './metrics.js';

export class Room {
  /**
   * @param {string} docId
   * @param {import('../storage/store.js').Store} store
   */
  constructor(docId, store, { accounts, onFatal } = {}) {
    this.docId = docId;
    this.store = store;
    this.accounts = accounts ?? null;
    /** Called when this room can no longer store what it is serving. */
    this.onFatal = onFatal ?? null;
    /** Set once persistence has failed for good; the room stops writing. */
    this.failed = false;
    /** Guards against concurrent persists each starting their own compaction. */
    this.compacting = false;
    /**
     * Keyed by CONNECTION id, not by the client-supplied id.
     *
     * Keying by clientId was a silent data-loss bug: two tabs sharing a
     * `?client=` value (or one copy-pasted URL) collapsed into a single map
     * entry, so the second connection evicted the first, and because broadcasts
     * exclude the sender by key, the surviving tab stopped receiving updates
     * altogether. It looked exactly like "sync is broken, I have to refresh".
     *
     * Connection id is ours and unique; clientId is a display/presence identity
     * and duplicates of it are merely cosmetic.
     * @type {Map<string, { socket: import('ws').WebSocket, clientId: string,
     *                       role: string, user: object|null }>}
     */
    this.clients = new Map();
    this.presence = new PresenceRoom(config.presenceTimeoutMs);
    /** Bytes written since boot, surfaced in the debug view. */
    this.stats = { bytesIn: 0, bytesOut: 0, updatesPersisted: 0, compactions: 0 };

    /**
     * Outbound engine frames waiting for the batch window to close.
     *
     * Entries are `{ frame, except }`, in the order they were produced. Order
     * is preserved through the flush because the engines' sub-protocols are
     * ordered -- a STEP2 that overtakes the update it was computed against
     * describes a document that never existed.
     *
     * @type {{ frame: Uint8Array, except: string|null }[]}
     */
    this.pending = [];
    this.flushTimer = null;

    /** Pending search-index refresh. See `scheduleReindex`. */
    this.searchTimer = null;

    metrics.roomsOpened++;

    this.engine = createEngine(config.engine, docId, (bytes) => {
      // NOT awaited, and that is the entire point of the write buffer.
      //
      // This callback is the per-keystroke path. Everything in `persist` is
      // a network round trip, and awaiting it here would put that round trip
      // between a keystroke arriving and the room acknowledging it. The
      // engine has already merged the update in memory, so the client is
      // correct the moment this returns -- durability follows behind it,
      // bounded by config.persistWindowMs.
      //
      // `void` rather than a bare call so the floating promise is deliberate
      // and readable; `persist` swallows nothing and logs what it catches.
      void this.persist(bytes);
    });

    // Comment anchors, but only for an engine that cannot keep its own.
    //
    // Under OT an anchor is an index, and transforming indices against
    // concurrent operations does not converge once deletes are involved -- so
    // the server, which already owns the operation order, owns the anchors
    // too. Under the CRDT this stays null and every client resolves its own
    // relative positions. ADR-012 has the measurement behind that split.
    if (this.engine.ownsAnchors) {
      // Fire-and-forget for the same reason `persist` is: this runs once per
      // sequenced revision, which is per keystroke under OT, and the engine
      // hook that calls it is synchronous. Errors are logged rather than
      // becoming unhandled rejections.
      this.engine.onSequenced = (op) => {
        void this.moveAnchors(op).catch((err) =>
          console.error(`[room ${this.docId}] anchor transform failed: ${err.message}`));
      };
    }

    /**
     * Rehydration, which is now a read and therefore cannot happen here.
     *
     * A constructor cannot await, so the load moved to `ready()`. It is
     * memoised rather than run on demand because several connections can join
     * a cold room in the same tick -- a document link opened in three tabs --
     * and each of them awaiting the same promise is one load, where each
     * calling `load()` would be three.
     * @type {Promise<void>|null}
     */
    this.readyPromise = null;

    this.reaper = setInterval(() => {
      void (async () => {
        for (const id of await this.presence.reap()) {
          this.broadcast(encodeJson(MSG_AWARENESS, { [id]: null }), null);
        }
      })();
    }, 5_000);
    this.reaper.unref?.();
  }

  /**
   * Load the document into the engine. Idempotent and safe to await from
   * anywhere: the second and subsequent callers get the first call's promise.
   *
   * Newest snapshot + every update logged after it. This is what makes "kill
   * the server, restart it" a non-event -- and on a host with an ephemeral
   * filesystem it is now what makes "redeploy" a non-event too, because the
   * snapshot and the log are in Postgres rather than on a disk that is about
   * to be discarded.
   */
  ready() {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const loaded = await this.store.load(this.docId);
        this.engine.restore(loaded);
        const restored = (loaded.snapshot ? 1 : 0) + loaded.updates.length;
        if (restored) {
          console.log(
            `[room ${this.docId}] restored from snapshot + ${loaded.updates.length} updates`);
        }
      })();
    }
    return this.readyPromise;
  }

  /**
   * Persist one engine update and do the bookkeeping that hangs off it.
   *
   * Separated from the callback above so the failure path has somewhere to
   * live. A rejected write here is a real problem -- it means an edit did not
   * reach storage -- and it must be logged rather than becoming an unhandled
   * rejection that takes the process down mid-session.
   */
  async persist(bytes) {
    // The append itself. Only THIS failing means the log has a hole in it.
    try {
      await this.store.appendUpdate(this.docId, bytes);
    } catch (err) {
      // The buffer has already retried. Reaching here means the update is not
      // in Postgres and will not be, so the room stops rather than carrying
      // on serving a document whose log is missing an edit everyone can see.
      this.failPersistence(err);
      return;
    }
    this.stats.updatesPersisted++;
    metrics.updates++;

    // Bookkeeping that hangs off a successful append. Deliberately a separate
    // catch: the update IS durable by this point, and a failed `touchDoc` or
    // a compaction that could not run is a nuisance to be retried on the next
    // edit, not a reason to throw everybody out of the document.
    try {
      // Keeps the document list sorted by real activity rather than by when
      // somebody last renamed something.
      await this.store.touchDoc(this.docId);
      await this.maybeCompact();
      this.scheduleReindex();
    } catch (err) {
      console.error(`[room ${this.docId}] post-append bookkeeping failed: ${err.message}`);
    }
  }

  /**
   * What the room does when an update could not be stored.
   *
   * The honest options are to keep going and let the log silently diverge
   * from what everyone is looking at, or to stop. This stops.
   *
   * Clients are closed with 1011, which their sync layer treats as a dropped
   * connection and retries. On reconnect the room is rebuilt from Postgres
   * and each client re-offers the state the server is missing -- that is the
   * ordinary reconnect path (see the restart harness), so the edits are not
   * lost from the user's side, and the server never acknowledges as durable
   * something Postgres does not have.
   *
   * Idempotent: a batch failure rejects many appends at once, and this must
   * not evict a room repeatedly.
   */
  failPersistence(err) {
    if (this.failed) return;
    this.failed = true;
    console.error(
      `[room ${this.docId}] PERSISTENCE FAILED, dropping the room: ${err?.message ?? err}`);
    metrics.persistFailures = (metrics.persistFailures ?? 0) + 1;
    void this.evictAll('the server could not save this document; reconnecting')
      .catch(() => { /* the sockets are going away regardless */ })
      .finally(() => this.onFatal?.(this.docId, err));
  }

  /**
   * Refresh this document's row in the search index (ADR-017).
   *
   * Debounced, and the window is the entire design. Indexing is a full
   * re-tokenise of the document -- there is no such thing as appending one
   * word to an inverted index -- so doing it per keystroke would put a
   * whole-document rewrite on the path of every character typed, next to the
   * append that is supposed to be the cheap part.
   *
   * Leading-edge scheduling, trailing-edge work: the first edit of a burst
   * starts a timer that later edits do NOT extend. Extending it would mean a
   * document somebody types in continuously for ten minutes is never indexed
   * at all, which is exactly backwards -- that is the document they are most
   * likely to go looking for.
   *
   * The cost of the window is that the index lags the document by at most
   * `searchIndexWindowMs`. That is the honest trade and it is stated in
   * ADR-017: this index is a projection, not a record, and a search run
   * mid-keystroke may miss the last two seconds of typing.
   */
  scheduleReindex() {
    if (this.searchTimer) return;
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.reindex();
    }, config.searchIndexWindowMs);
    this.searchTimer.unref?.();
  }

  /**
   * Throw the document away if it was never written in.
   *
   * Two conditions, and a name is not one of them:
   *
   *   unowned   an owned document belongs to an account, which has a Trash and
   *             a Delete of its own. Removing one on a timer is a different
   *             risk, and not one this is allowed to take.
   *   no text   the actual content, read through the engine seam.
   *
   * `Untitled`-and-empty and `named`-and-empty are treated alike: a title is
   * something a person types before they have written anything, so it is no
   * evidence that they did. The other half of "empty or unnamed" is NOT done
   * -- a document with text in it is kept whatever it is called, because
   * discarding one on the strength of its name would delete somebody's
   * writing.
   *
   * A tab makes it ineligible too: a document somebody bothered to split is
   * not one nobody started.
   *
   * @returns {boolean} whether the document was purged
   */
  async discardIfAbandoned() {
    const meta = await this.store.getDoc(this.docId);
    if (!meta || meta.ownerId) return false;
    if (meta.deletedAt) return false;

    if ((await this.store.tabsFor(this.docId)).length > 1) return false;

    let text = '';
    try {
      text = this.engine.readDocument().toString();
    } catch {
      // If the document cannot be read, it cannot be shown to be empty.
      return false;
    }
    if (text.trim()) return false;

    await this.store.purgeDoc(this.docId);
    console.log(`[room ${this.docId}] discarded (never named, never written in)`);
    return true;
  }

  /**
   * Project the document out through the seam and hand the text to storage.
   *
   * `readDocument()` is the one interface method that speaks content rather
   * than opaque bytes, which is what makes this work for BOTH engines with no
   * engine-specific code: the room asks for a RichText and never learns
   * whether a Y.Doc or an OT revision produced it.
   *
   * Failure here must not take the room with it. An unsearchable document is
   * a degraded search box; a room that throws on save is lost edits.
   */
  async reindex() {
    try {
      await this.store.indexDoc(this.docId, this.engine.readDocument().toString());
    } catch (err) {
      console.error(`[room ${this.docId}] search index failed:`, err.message);
    }
  }

  /**
   * Fold the loose update log back into a single snapshot once it gets long.
   * Without this, restarting the server after a long session means replaying
   * every keystroke ever typed.
   */
  async maybeCompact() {
    if (this.compacting) return;
    if (await this.store.looseUpdateCount(this.docId) < config.compactAfterUpdates) return;

    // Persist runs concurrently with itself -- the engine callback is
    // fire-and-forget -- so without this guard several appends crossing the
    // threshold at once each start a compaction, and the last to commit
    // overwrites the snapshot of the furthest-ahead one with an older
    // `through_seq`. Whichever updates the winner had already archived and
    // deleted are then gone from the live log.
    this.compacting = true;
    try {
      const { compacted, throughSeq } =
        await this.store.compactAtomically(this.docId, () => this.engine.snapshot());
      if (!compacted) return;
      this.stats.compactions++;
      console.log(`[room ${this.docId}] compacted log through seq ${throughSeq}`);
    } finally {
      this.compacting = false;
    }
  }

  /**
   * @param {string} connId  unique per socket, assigned by the transport
   * @param {string} clientId  display/presence identity, may collide
   * @param {import('ws').WebSocket} socket
   */
  /**
   * The HELLO payload for one connection.
   *
   * Built in one place because it is sent from two -- on join, and again from
   * `recheckAccess` when a role changes. They drifted apart once already; a
   * field added to one and not the other is a client that learns a fact only
   * if it happened to connect at the right moment.
   */
  async helloFor({ clientId, role, user }) {
    // A tab's room is a room on a document, and the identity a client needs --
    // title, owner, role -- is the DOCUMENT's. Reading `docs` by this room's
    // own id would find nothing for a tab and report the document as untitled
    // and unowned, which is how a tab would come to look claimable (ADR-014).
    const { docId: parentId, tabId } = Store.tabOf(this.docId);
    const doc = await this.store.getDoc(parentId);
    return {
      clientId,
      docId: this.docId,
      // The document this room's content belongs to, and which tab of it this
      // is. Equal to `docId` with `tabId: null` for a document that has never
      // been split, so a client that knows nothing about tabs still works.
      documentId: parentId,
      tabId,
      tabTitle: tabId ? ((await this.store.getTab(tabId))?.title ?? null) : null,
      engine: config.engine,
      peers: this.clients.size,
      // The client needs its role to render a read-only editor. It is NOT
      // where the rule lives -- the server rejects a viewer's edits below --
      // but a UI that lets you type and then silently discards it is worse
      // than one that does not let you type.
      role,
      user,
      title: doc?.title ?? this.docId,
      // Whether this document has an owner at all. The editor cannot infer it
      // from `role`: an unowned document and a document shared with you both
      // report `editor`, and only one of them can be claimed.
      unowned: !doc?.ownerId,
    };
  }

  async join(connId, clientId, socket, { role = 'editor', user = null } = {}) {
    this.clients.set(connId, { socket, clientId, role, user });

    this.send(socket, encodeJson(MSG_HELLO, await this.helloFor({ clientId, role, user })));

    // Seed the newcomer with everyone else's cursors before any editing.
    const existing = await this.presence.snapshot(clientId);
    if (Object.keys(existing).length) {
      this.send(socket, encodeJson(MSG_AWARENESS, existing));
    }

    for (const frame of this.engine.onClientJoin(clientId)) {
      this.send(socket, frame);
    }
    // A queued update predates this client's handshake, and delivering it
    // afterwards would hand them bytes their STEP2 already contained. Harmless
    // under a CRDT, but it makes the frame timeline in the lab read as though
    // the server double-sent -- so the window is drained on join instead.
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushPending(); }
    console.log(`[room ${this.docId}] + ${clientId} (${this.clients.size} online)`);
  }

  async leave(connId) {
    const entry = this.clients.get(connId);
    if (!entry) return;
    const { clientId } = entry;
    this.clients.delete(connId);
    this.engine.onClientLeave(clientId);

    // Only drop the presence entry if no OTHER connection still claims this
    // clientId -- otherwise closing one of two same-named tabs would erase a
    // cursor that is still live.
    const stillHere = [...this.clients.values()].some((c) => c.clientId === clientId);
    if (!stillHere) {
      await this.presence.remove(clientId);
      // null = tombstone, so peers can drop the cursor immediately rather than
      // waiting out the presence timeout.
      this.broadcast(encodeJson(MSG_AWARENESS, { [clientId]: null }), connId);
    }
    console.log(`[room ${this.docId}] - ${clientId} (${this.clients.size} online)`);
  }

  /**
   * @param {string} connId
   * @param {Uint8Array} data raw frame off the wire
   */
  async handle(connId, data) {
    const entry = this.clients.get(connId);
    if (!entry) return;
    const clientId = entry.clientId;
    this.stats.bytesIn += data.length;
    const { type, payload } = decode(data);

    switch (type) {
      case MSG_ENGINE: {
        // Authorisation travels INTO the engine rather than being decided
        // here. The room cannot tell a sync handshake from an edit without
        // understanding the engine's sub-protocol, and refusing both locks
        // viewers out of reading -- see DocEngine.handleMessage.
        //
        // Timed from here to the last frame written, which is this node's
        // whole contribution to how long a keystroke takes to reach someone
        // else: decode, transform or merge, persist, encode, write. The two
        // network legs and the peer's render are not ours to measure and are
        // not included -- see metrics.js.
        const startedAt = performance.now();
        const mayEdit = canEdit(entry.role);
        const { toSender = [], toOthers = [] } =
          this.engine.handleMessage(clientId, payload, { canEdit: mayEdit }) ?? {};
        // An edit dropped for lack of permission is otherwise completely
        // silent: the sender's own editor keeps the text (it applied locally
        // and optimistically), nothing reaches anyone else, and no error is
        // raised anywhere. That is indistinguishable from "sync is broken"
        // from the outside, and it is the state a viewer is legitimately in --
        // so it is logged rather than diagnosed twice.
        if (!mayEdit) {
          console.log(`[room ${this.docId}] dropped an edit from ${clientId} (role=${entry.role})`);
        }
        // Straight out: the sender is waiting on these, and under OT one of
        // them is the ack that lets the client send its next operation.
        for (const frame of toSender) this.send(entry.socket, frame);
        for (const frame of toOthers) this.queueBroadcast(frame, connId);
        // Only edits. A sync handshake produces no outbound frames on either
        // side, and folding those zeros in would drag the percentiles towards
        // a number that describes doing nothing.
        if (toSender.length || toOthers.length) {
          recordRelay(performance.now() - startedAt);
        }
        break;
      }

      case MSG_AWARENESS: {
        // Presence is relayed verbatim and never persisted.
        const states = decodeJson(payload);
        for (const [id, state] of Object.entries(states)) {
          if (state === null) await this.presence.remove(id);
          else await this.presence.set(id, state);
          // Teach the engine who this id is, if it has nowhere of its own to
          // keep that. Only OT does: a CRDT document carries its own author
          // map as part of the document, so it needs nothing from presence and
          // does not implement this (ADR-018).
          // `state.user`, not `state` -- a presence payload is
          // `{ user: {name, color}, cursor, t }`, and reading the name off the
          // envelope silently registered every author as the empty string.
          if (state?.user?.name && this.engine.noteIdentity) {
            this.engine.noteIdentity(id, state.user.name, state.user.color);
          }
        }
        this.broadcast(encode(MSG_AWARENESS, payload), connId);
        break;
      }

      case MSG_DEBUG: {
        this.send(entry.socket, encodeJson(MSG_DEBUG, await this.inspect()));
        break;
      }

      default:
        console.warn(`[room ${this.docId}] unknown frame type ${type} from ${clientId}`);
    }
  }

  async inspect() {
    return {
      docId: this.docId,
      online: [...this.clients.values()].map((c) => c.clientId),
      stats: this.stats,
      looseUpdates: await this.store.looseUpdateCount(this.docId),
      currentSeq: await this.store.currentSeq(this.docId),
      compactAfter: config.compactAfterUpdates,
      engine: this.engine.inspect(),
    };
  }

  /**
   * Move every comment anchor on this document through one sequenced op.
   *
   * Called once per revision, in revision order, on the server only. That is
   * the entire mechanism by which OT comments converge: there is exactly one
   * transformation path, so there is nothing for two replicas to disagree
   * about (ADR-012).
   *
   * Clients mirror this locally as they apply the same ops in the same order,
   * which is why this does not have to broadcast on every keystroke -- their
   * answer will match ours. It broadcasts only when an anchor is ORPHANED,
   * because that is a state change a client cannot infer from the op alone
   * without knowing every anchor, and it is rare.
   *
   * @param {import('@collab/ot').RichTextOperation} op
   */
  async moveAnchors(op) {
    const threads = await this.store.listThreads(this.docId);
    if (threads.length === 0) return;

    const orphaned = [];
    for (const thread of threads) {
      if (thread.orphaned) continue;
      const moved = this.engine.transformRange(
        { from: thread.anchor.from, to: thread.anchor.to }, op);
      if (moved) {
        // Skip the write when nothing actually moved. Most operations are far
        // from most anchors, and this runs on every keystroke.
        if (moved.from !== thread.anchor.from || moved.to !== thread.anchor.to) {
          await this.store.setAnchor(thread.id, { ...thread.anchor, ...moved });
        }
      } else {
        // The commented text is gone. Not resolved -- nobody decided anything,
        // the words simply stopped existing (ADR-012).
        await this.store.orphanThread(thread.id);
        orphaned.push(thread.id);
      }
    }

    if (orphaned.length) {
      this.broadcast(encodeJson(MSG_COMMENTS, { orphaned }), null);
    }
  }

  /**
   * Turn a client's proposed anchor into one this server is willing to store.
   *
   * Under the CRDT it is returned untouched -- it is a relative position, and
   * the server has no opinion about it. Under OT it is caught up through every
   * revision sequenced since the client computed it, which is the moment the
   * server takes ownership of the anchor (ADR-012).
   *
   * @returns {object|null} null if the range no longer exists
   */
  mintAnchor(anchor) {
    if (!this.engine.ownsAnchors) return anchor;
    const caught = this.engine.catchUpRange(
      { from: anchor.from, to: anchor.to }, anchor.rev);
    if (!caught) return null;
    // `rev` was only ever a statement about the request, not about the stored
    // anchor. Dropping it here stops a stale revision number from outliving
    // the catch-up that consumed it.
    const { rev, ...rest } = anchor;
    return { ...rest, ...caught };
  }

  /** Tell every client the comment threads changed and should be re-read. */
  commentsChanged(detail = {}) {
    this.broadcast(encodeJson(MSG_COMMENTS, { changed: true, ...detail }), null);
  }

  /**
   * Tell every client the task list changed.
   *
   * The frame carries no tasks. Clients re-read over HTTP, which keeps one
   * copy of the truth -- the same argument as comments, and the reason a
   * checklist needs no engine support at all (ADR-015).
   */
  tasksChanged(detail = {}) {
    this.broadcast(encodeJson(MSG_TASKS, { changed: true, ...detail }), null);
  }

  /**
   * Tell every client the tab list changed.
   *
   * Sent to this room only. The API fans it out across the document's other
   * rooms, because it is the only party that can see them -- a room knows its
   * own document and deliberately nothing about its siblings (ADR-014).
   */
  tabsChanged(detail = {}) {
    this.broadcast(encodeJson(MSG_TABS, { changed: true, ...detail }), null);
  }

  send(socket, frame) {
    if (!socket || socket.readyState !== socket.OPEN) return;
    this.stats.bytesOut += frame.length;
    metrics.framesOut++;
    metrics.bytesOut += frame.length;
    socket.send(frame);
  }

  broadcast(frame, exceptConnId) {
    for (const [connId, { socket }] of this.clients) {
      if (connId === exceptConnId) continue;
      this.send(socket, frame);
    }
  }

  /**
   * Broadcast, but let the window close first.
   *
   * This is the fix for the first limit `/scale` measures. Without it every
   * keystroke is relayed to everyone else the instant it lands, so a room of
   * N people costs N*(N-1) frames per keystroke-round and traffic grows with
   * the square of the room. Holding frames for `broadcastWindowMs` lets the
   * engine merge a window's worth into one, which turns the fan-out from one
   * frame per client per edit into one frame per client per window.
   *
   * Batching is OFF unless the engine says its frames may be merged. OT says
   * no -- it is server-authoritative and its clients are waiting on acks --
   * and an engine that has not considered the question inherits the safe
   * answer from DocEngine. See ADR-016.
   */
  queueBroadcast(frame, exceptConnId) {
    // Three ways to opt out, and the third is the interesting one: a room too
    // small for the merge to pay for the echo. See config.batchMinClients.
    if (!config.broadcastWindowMs
      || !this.engine.coalescible
      || this.clients.size < config.batchMinClients) {
      this.broadcast(frame, exceptConnId);
      return;
    }

    this.pending.push({ frame, except: exceptConnId });
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushPending(), config.broadcastWindowMs);
    // Do not hold the process open for a window that is about to close anyway.
    this.flushTimer.unref?.();
  }

  /**
   * Send everything the window collected.
   *
   * The merged frame goes to EVERY client, senders included, which is the
   * whole reason this is cheap: computing a different merge per recipient so
   * that each one is spared its own bytes would put the N back into the
   * fan-out. It is safe precisely because `coalescible` promises it -- a Yjs
   * update applied twice is a no-op, so a client receiving its own edit back
   * integrates nothing and notices nothing.
   */
  flushPending() {
    this.flushTimer = null;
    const pending = this.pending;
    this.pending = [];
    if (!pending.length) return;

    const merged = this.engine.coalesce(pending.map((p) => p.frame));

    // What a naive relay would have sent, against what we are about to send.
    // Recorded rather than claimed: this is the number /scale quotes.
    const naive = pending.reduce(
      (n, p) => n + (this.clients.has(p.except) ? this.clients.size - 1 : this.clients.size), 0);
    metrics.framesSaved += Math.max(0, naive - merged.length * this.clients.size);

    for (const frame of merged) this.broadcast(frame, null);
  }

  /**
   * Apply a server-initiated change -- today, restoring an old version.
   *
   * It goes to EVERY client, not "everyone except the sender", because there
   * is no sender. The engine turns it into an ordinary edit, so a client that
   * is mid-keystroke rebases over it exactly as it would over a peer.
   *
   * @param {import('@collab/ot').RichText} doc
   * @param {string} [authorId]
   */
  async applyServerEdit(doc, authorId) {
    // Drain the window first. A restore that overtakes the edits it was
    // computed against describes a document that never existed, and the
    // engines' sub-protocols are ordered for exactly this reason.
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushPending(); }

    const { toOthers = [] } = this.engine.replaceWith(doc, authorId) ?? {};
    for (const frame of toOthers) this.broadcast(frame, null);
    await this.store.touchDoc(this.docId);
    console.log(`[room ${this.docId}] server edit applied by ${authorId ?? 'server'}`);
  }

  /**
   * Re-read every connected client's role after a sharing change.
   *
   * Roles are cached per connection, which is what makes the check on every
   * frame cheap -- and it means a revoked collaborator would otherwise keep
   * editing until they happened to reconnect. Sharing changes are rare, so
   * re-reading all of them here is the cheap side of that trade.
   */
  async recheckAccess() {
    for (const [connId, entry] of [...this.clients]) {
      const role = await this.store.roleFor(this.docId, entry.user?.id,
        { requireOwner: config.requireOwner });
      if (!role) {
        // Two ways to lose access, and they are not the same event to the
        // person it happens to. An anonymous connection loses it when the
        // document gains an owner -- nothing was taken from them, the document
        // stopped being open -- and the only useful next step is signing in.
        await this.evict(connId, entry.user
          ? 'your access to this document was removed'
          : 'this document now has an owner; sign in to ask for access');
      } else if (role !== entry.role) {
        entry.role = role;
        // Tell the client, so a demoted editor's UI goes read-only rather than
        // continuing to accept typing the server is now dropping.
        this.send(entry.socket,
          encodeJson(MSG_HELLO, await this.helloFor({ ...entry, role })));
      }
    }
  }

  async evict(connId, reason) {
    const entry = this.clients.get(connId);
    if (!entry) return;
    await this.leave(connId);
    entry.socket.close(1008, reason);
  }

  /** Used when a document is deleted out from under the people editing it. */
  async evictAll(reason) {
    for (const connId of [...this.clients.keys()]) await this.evict(connId, reason);
  }

  get isEmpty() {
    return this.clients.size === 0;
  }

  async destroy() {
    clearInterval(this.reaper);
    // Anything still in the window belongs to clients that are leaving, but
    // flushing is what keeps the counters honest and costs nothing.
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushPending(); }
    // Index on the way out, unconditionally rather than only when a refresh
    // is pending. The room is evicted when the last client leaves, which is
    // the moment a document stops changing -- so this is the point at which
    // the index and the document are guaranteed to agree, and skipping it
    // would leave the last window's worth of typing unsearchable until
    // somebody opened the document again.
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;

    /*
     * Last chance to notice the document was never really started.
     *
     * A guest opens a URL, a document row is created for them, and they leave
     * without naming it or typing in it. Nothing about that is worth keeping:
     * it has no owner, so nobody can find it, delete it or share it, and it
     * has no name and no text, so there is nothing in it to find. The
     * documents page already declines to list these; that hid the mess rather
     * than not making it.
     *
     * Here rather than on a sweep, because this is the moment the answer is
     * known for certain: the room is being torn down thirty seconds after the
     * last client left, so the document has stopped changing and the text in
     * memory is final.
     */
    if (await this.discardIfAbandoned()) {
      this.engine.destroy();
      return;
    }

    await this.reindex();
    // Snapshot on the way out so the next boot starts from a clean slate.
    //
    // NOT `compact(docId, engine.snapshot(), await currentSeq(docId))`:
    // arguments evaluate left to right, so that takes the snapshot before
    // the round trip that reads the seq. An edit arriving during the trip is
    // then inside `throughSeq` but absent from the snapshot, and compaction
    // deletes exactly the updates at or below `throughSeq`. That keystroke
    // survives only in the archive, which `load()` never reads.
    if (!this.failed) {
      await this.store.compactAtomically(this.docId, () => this.engine.snapshot());
    }
    this.engine.destroy();
  }
}
