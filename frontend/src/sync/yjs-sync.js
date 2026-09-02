/**
 * CRDT client. Hand-written sync loop -- no y-websocket.
 *
 * Deliberately free of DOM/React so the same class can be driven from a Node
 * test harness (Node 22+ ships a global WebSocket). CodeMirror binding lives
 * behind `editorExtensions()`, which the headless harness simply never calls.
 */
import * as Y from 'yjs';
import { RichText, inlineOnly } from '@collab/ot';
import {
  MSG_ENGINE, MSG_AWARENESS, MSG_HELLO, MSG_DEBUG, MSG_COMMENTS, MSG_TASKS, MSG_TABS,
  encode, decode, encodeJson, decodeJson, toBytes,
} from '@collab/protocol';
import {
  Y_SYNC_STEP1, Y_SYNC_STEP2, Y_UPDATE, encodeYjs, decodeYjs,
} from '@collab/protocol/yjs-wire';
import { EditorSync } from './editor-sync.js';

/**
 * Y.RelativePosition <-> base64. The wire and the database are both JSON, and
 * Yjs hands these back as Uint8Array.
 */
function encodeRel(rel) {
  const bytes = Y.encodeRelativePosition(rel);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeRel(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return Y.decodeRelativePosition(bytes);
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const PRESENCE_THROTTLE_MS = 60;

/**
 * Origin tag on transactions this client initiates.
 *
 * Two things key off it: the update handler, which must not echo a remote
 * update back to the server, and the undo manager, which must not undo a
 * peer's edit. Using a named constant rather than `null` means both are
 * asking the same question.
 */
const LOCAL_ORIGIN = 'local';

export class YjsSync extends EditorSync {
  /**
   * @param {{url: string, docId: string, clientId: string}} opts
   */
  /**
   * @param {{ url: string, docId: string, clientId: string,
   *           socketFactory?: (url: string) => WebSocket }} opts
   *   `socketFactory` lets the lab substitute a SimulatedSocket. Nothing else
   *   in this class knows or cares which it got.
   */
  constructor({ url, docId, clientId, socketFactory, token, persist = false }) {
    super();
    this.url = url;
    this.docId = docId;
    this.clientId = clientId;
    /**
     * Session token, appended to the socket url.
     *
     * A query parameter and not a header, because the browser WebSocket API
     * cannot set headers on the upgrade request. The server documents the
     * same trade from its side.
     */
    this.token = token ?? null;
    this.socketFactory = socketFactory ?? ((u) => new WebSocket(u));

    this.doc = new Y.Doc();
    this.text = this.doc.getText('content');

    /**
     * Local durability, and it is OFF BY DEFAULT.
     *
     * `this.doc` is memory. Without this, "offline editing" means only "the
     * socket dropped and you kept typing" -- reload or close the tab during a
     * network drop and the unsent edits are gone. For a guest document, which
     * the server files under nobody, that is the entire document.
     *
     * Default false because of the lab. Every pane there is a replica of the
     * SAME docId in the same browser, so one shared IndexedDB store would be a
     * back channel between them: partition two replicas, type in both, and
     * they would converge through the disk while the network was cut. The
     * partition demo would quietly stop demonstrating anything, and it would
     * look like it still worked. Only the real editor asks for this.
     */
    this.persistence = null;
    this.localReady = persist ? this._openLocalStore() : Promise.resolve(false);

    this.socket = null;
    this.status = 'offline';
    this.synced = false;
    this.attempt = 0;
    this.wantConnection = false;
    /** Resolvers waiting on the *next* completed sync. @type {Function[]} */
    this._syncWaiters = [];

    /**
     * Comment anchors, as Y.RelativePosition. Kept as decoded objects because
     * resolving is the only thing ever done with them.
     * @type {Map<string, {from: any, to: any}>}
     */
    this.anchors = new Map();

    /** @type {Map<string, any>} remote cursors, keyed by clientId */
    this.peers = new Map();
    this.localUser = { name: 'anon', color: '#888' };
    this.localCursor = null;
    this.presenceTimer = null;

    /**
     * Byte accounting. This exists so you can *show* that a reconnect after an
     * idle period costs bytes proportional to what changed, not to document
     * size -- which is the whole point of the state-vector handshake.
     */
    this.stats = { bytesSent: 0, bytesRecv: 0, lastSyncRecv: 0, docLength: 0 };

    this.doc.on('update', (update, origin) => {
      this.stats.docLength = this.text.length;
      // Updates that arrived from the network must not be echoed back, and
      // neither must the ones replayed out of the local store on load: those
      // are not new edits, they are what this client already had. The
      // handshake offers the server whatever it is actually missing (see
      // Y_SYNC_STEP1 below, which answers with a delta against the server's
      // own state vector), so nothing typed offline is lost by staying quiet
      // here -- while re-sending the whole document on every page load would
      // throw away the reason the handshake exists.
      //
      // The persistence test is written this way on purpose. Yjs uses `null`
      // as the origin of an untagged transaction, and `this.persistence` is
      // null whenever the local store is off -- so the naive
      // `origin !== this.persistence` is true for a real edit and false for an
      // untagged one, silently swallowing keystrokes on every client that is
      // not persisting, which is all of them by default. It surfaces as edits
      // that never reach the server, with no error raised anywhere.
      const replayed = this.persistence !== null && origin === this.persistence;
      if (origin !== 'remote' && !replayed) {
        this.send(MSG_ENGINE, encodeYjs(Y_UPDATE, update));
      }
      this.emit('doc', this.stats);
      // Formatting changes move no characters, so `doc` alone would leave the
      // editor's decorations stale. The editor listens to this one.
      //
      // Deferred, and that is not a nicety. This handler runs DURING Yjs's
      // transaction cleanup, and toDelta() inside that window makes Yjs
      // reconcile format markers early -- discarding ones a concurrent format
      // still needed. Two replicas then settle on different attributes and
      // stay there. Reading one tick later sees the same document with the
      // cleanup finished.
      queueMicrotask(() => {
        this.emit('rich', this.getRichText());
        // Relative positions do not need updating, but whatever is DRAWING
        // them does: the characters under a highlight just moved.
        if (this.anchors.size) this.emit('anchors', this.resolvedAnchors());
      });
    });
  }

  /**
   * Load this document out of IndexedDB, and keep writing to it.
   *
   * Dynamically imported and feature-detected, because this module is also
   * driven headlessly from `tools/`: Node has no `indexedDB`, and a static
   * import would break the harnesses that exist precisely because this class
   * runs in both places. Same reasoning as `editorExtensions` at the bottom
   * of this file.
   *
   * Failure is not fatal and is not rethrown. Private browsing, a denied quota
   * and a blocked version upgrade all land here, and the right answer to each
   * is an editor that behaves exactly as it did before this method existed --
   * not one that refuses to open a document because it could not cache it.
   *
   * @returns {Promise<boolean>} whether anything was restored from disk
   */
  async _openLocalStore() {
    if (typeof indexedDB === 'undefined') return false;
    try {
      const { IndexeddbPersistence } = await import('y-indexeddb');
      // Namespaced. The store is keyed by document id, and ids here are bare
      // words like `demo` -- not something to claim unqualified on an origin.
      const provider = new IndexeddbPersistence(`collab-docs:${this.docId}`, this.doc);
      this.persistence = provider;
      await provider.whenSynced;
      // Destroyed while we were loading. `destroy()` is synchronous and cannot
      // await this, so it clears the field and this is where that is noticed.
      if (this.persistence !== provider) return false;
      this.stats.docLength = this.text.length;
      this.emit('doc', this.stats);
      this.emit('rich', this.getRichText());
      return this.text.length > 0;
    } catch (err) {
      console.warn('[sync] local store unavailable, continuing without it:', err?.message ?? err);
      this.persistence = null;
      return false;
    }
  }

  /**
   * Resolves once we are synced. Safe to call at any time: if automatic
   * backoff already reconnected us, this resolves immediately rather than
   * waiting for a sync that has already happened.
   */
  connect() {
    this.wantConnection = true;
    return new Promise((resolve) => {
      if (this.synced) { resolve(); return; }
      this._syncWaiters.push(resolve);
      // If a backoff timer is already pending, let it fire rather than
      // stacking a second connection attempt on top of it.
      if (!this.socket && !this.reconnectTimer) this._open();
    });
  }

  _open() {
    if (this.socket) return;
    this.setStatus('connecting');

    const url = `${this.url}?doc=${encodeURIComponent(this.docId)}`
      + `&client=${encodeURIComponent(this.clientId)}`
      + (this.token ? `&token=${encodeURIComponent(this.token)}` : '');
    const socket = this.socketFactory(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.attempt = 0;
      this.setStatus('connected');
      this.stats.lastSyncRecv = 0;
      // Step 1: tell the server what we already have. On a fresh tab this is a
      // near-empty vector; on a reconnect it is everything we know, so the
      // server's reply is a minimal delta.
      this.send(MSG_ENGINE, encodeYjs(Y_SYNC_STEP1, Y.encodeStateVector(this.doc)));
      this.publishPresence(true);
    };

    socket.onmessage = (event) => {
      const bytes = toBytes(event.data);
      this.stats.bytesRecv += bytes.length;
      if (!this.synced) this.stats.lastSyncRecv += bytes.length;
      this.handleFrame(bytes);
    };

    socket.onclose = (event) => {
      // 1008 is the server saying no, not the network failing. Retrying a
      // refusal forever would leave the status pill cycling "reconnecting",
      // which reads as a broken app rather than an answer about permissions.
      if (event?.code === 1008) {
        this.wantConnection = false;
        this.socket = null;
        this.synced = false;
        this.setStatus('refused');
        this.emit('refused', event.reason || 'you do not have access to this document');
        return;
      }
      // A stale socket closing must never clobber a newer one. Without this
      // guard, toggling offline->online fast enough leaves the new socket
      // orphaned (this.socket nulled while it is still open) and schedules a
      // reconnect on top of it, so the client ends up with two live sockets.
      if (this.socket !== socket) return;
      this.socket = null;
      this.synced = false;
      this.peers.clear();
      this.emit('peers', this.peers);
      this.setStatus('offline');
      if (this.wantConnection) this.scheduleReconnect();
    };

    socket.onerror = () => { /* onclose always follows; handled there */ };
  }

  scheduleReconnect() {
    // Exponential backoff with jitter: a server restart means every client
    // reconnects at once, and synchronised retries would hammer it.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    const jittered = delay * (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._open(); }, jittered);
  }

  /**
   * Re-run the sync handshake over the existing socket. Cheap by construction:
   * the state vector goes out, only the genuine delta comes back.
   */
  resync() {
    this.send(MSG_ENGINE, encodeYjs(Y_SYNC_STEP1, Y.encodeStateVector(this.doc)));
  }

  getText() {
    return this.text.toString();
  }

  /**
   * The document with its formatting.
   *
   * Y.Text already stores attributes natively and `toDelta()` hands them back
   * as runs, so this is a shape conversion, not a second source of truth. The
   * RichText type is shared with the OT engine deliberately: the editor above
   * the seam renders one document model and cannot tell which engine produced
   * it.
   *
   * Rebuilt on demand rather than cached. It is O(runs) per keystroke, which
   * is nothing at document sizes this project targets, and a cache here would
   * be a second place for the document to be wrong.
   */
  getRichText() {
    const doc = new RichText();
    for (const part of this.text.toDelta()) {
      if (typeof part.insert === 'string') doc.push(part.insert, part.attributes);
    }
    return doc;
  }

  /**
   * Apply a formatting change to a range.
   *
   * Where OT builds a retain-with-attributes and sends it for the server to
   * order, the CRDT writes straight into the local replica and lets the
   * update propagate. No revision, no ack, no server involvement -- and
   * concurrent conflicting formatting is resolved by Yjs's own per-attribute
   * metadata rather than by a tie-break the server arbitrates. That contrast
   * is the same one ADR-001 draws for text, now visible for formatting too.
   */
  format(from, to, attributes) {
    if (to <= from) return;
    // Tagged like any other local edit so the undo manager tracks it: undoing
    // a bold should be as ordinary as undoing a word.
    this.doc.transact(() => this.text.format(from, to - from, attributes), LOCAL_ORIGIN);
  }

  handleFrame(bytes) {
    const { type, payload } = decode(bytes);

    switch (type) {
      case MSG_HELLO: {
        const hello = decodeJson(payload);
        // Adopt the identity the server assigned us.
        //
        // Presence is keyed by whatever the client puts in its awareness
        // payload, and the server keys its own bookkeeping -- notably the
        // tombstone broadcast when a connection closes -- by the id IT chose.
        // Once accounts existed those two stopped matching, so a signed-in
        // user's cursor was never tombstoned on disconnect and lingered until
        // the 15-second reaper swept it. Taking the server's id makes the two
        // sides agree again, and is what lets the lab run several replicas
        // under one account.
        if (hello.clientId && hello.clientId !== this.clientId) {
          this.clientId = hello.clientId;
          this.publishPresence(true);
        }
        this.emit('hello', hello);
        break;
      }

      case MSG_ENGINE: {
        const { subtype, bytes: body } = decodeYjs(payload);

        if (subtype === Y_SYNC_STEP1) {
          // Server asked what we have; reply with only what it is missing.
          this.send(MSG_ENGINE, encodeYjs(Y_SYNC_STEP2, Y.encodeStateAsUpdate(this.doc, body)));
        } else {
          Y.applyUpdate(this.doc, body, 'remote');
          if (subtype === Y_SYNC_STEP2 && !this.synced) {
            this.synced = true;
            this.setStatus('synced');
            this.emit('synced', this.stats);
            for (const resolve of this._syncWaiters.splice(0)) resolve();
          }
        }
        break;
      }

      case MSG_AWARENESS: {
        const states = decodeJson(payload);
        for (const [id, state] of Object.entries(states)) {
          if (id === this.clientId) continue;
          if (state === null) this.peers.delete(id);
          else this.peers.set(id, state);
        }
        this.emit('peers', this.peers);
        break;
      }

      case MSG_DEBUG:
        this.emit('debug', decodeJson(payload));
        break;

      // Comment threads changed, or the server orphaned one. Deliberately
      // just a nudge: the payload says WHAT happened, never the thread bodies,
      // so the UI re-reads the list over HTTP and there is exactly one place
      // comment state comes from.
      case MSG_COMMENTS:
        this.emit('comments', decodeJson(payload));
        break;

      // The same nudge, for the two lists that hang off a document rather than
      // living inside it: the shared checklist (ADR-015) and the tab list
      // (ADR-014). Neither is engine state, which is why both engines handle
      // them with the identical three lines and no engine code at all.
      case MSG_TASKS:
        this.emit('tasks', decodeJson(payload));
        break;

      case MSG_TABS:
        this.emit('tabs', decodeJson(payload));
        break;
    }
  }

  send(type, payload) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    const frame = encode(type, payload);
    this.stats.bytesSent += frame.length;
    this.socket.send(frame);
    return true;
  }

  setLocalUser(user) {
    this.localUser = { ...this.localUser, ...user };
    this.publishPresence(true);
    this.announceAuthor();
  }

  /**
   * Write this replica's identity into the document's shared author map
   * (ADR-018).
   *
   * The CRDT already records WHICH client inserted every character -- that is
   * how it orders concurrent inserts, and it is why authorship costs no new
   * state. What it cannot know is that client 3847219922 is called Ada. So
   * each replica writes that one fact about itself into a Y.Map that is part
   * of the document, where it merges, persists and survives a restart exactly
   * as the text does.
   *
   * Deliberately IN the document rather than derived from presence, which is
   * the obvious alternative and is wrong: presence is ephemeral by design and
   * is never persisted, so a document reopened next week would show every
   * paragraph as written by nobody. Authorship outlives the session it was
   * created in, so the thing that decodes it has to as well.
   *
   * One small entry per replica, written only when the name actually changes:
   * this is a CRDT map, so a redundant write is a real update that is
   * broadcast, persisted and replayed on every future cold start.
   */
  announceAuthor() {
    const key = String(this.doc.clientID);
    const { name, color } = this.localUser;
    const authors = this.doc.getMap('authors');
    const existing = authors.get(key);
    if (existing && existing.name === name && existing.color === color) return;
    this.doc.transact(() => { authors.set(key, { name, color }); });
  }

  setLocalCursor(sel) {
    this.localCursor = sel;
    this.publishPresence(false);
  }

  /**
   * Cursor moves at keystroke rate; the network does not need to. Throttled,
   * and lossy on purpose -- a dropped cursor frame is corrected 60ms later.
   */
  publishPresence(immediate) {
    const flush = () => {
      this.presenceTimer = null;
      this.send(MSG_AWARENESS, new TextEncoder().encode(JSON.stringify({
        [this.clientId]: { user: this.localUser, cursor: this.localCursor, t: Date.now() },
      })));
    };
    if (immediate) { clearTimeout(this.presenceTimer); flush(); return; }
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(flush, PRESENCE_THROTTLE_MS);
  }

  requestDebug() {
    this.send(MSG_DEBUG, new Uint8Array(0));
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  /**
   * Simulates a network drop without tearing down local state -- offline mode.
   *
   * Every teardown here is SYNCHRONOUS. Relying on `onclose` to do it is a bug:
   * the close event is deferred, and a user who clicks reconnect inside that
   * window hits `connect()` while `synced` is still true, which resolves
   * immediately and never opens a socket. The tab then sits offline until it is
   * reloaded.
   */
  /**
   * The CRDT engine can undo, so the toolbar shows the buttons.
   *
   * Deliberately not `!!this.undoManager`. The manager is created inside
   * `editorExtensions`, which is dynamically imported and therefore resolves a
   * tick or two after the toolbar first renders -- keying the buttons on it
   * would make them appear late, on whatever unrelated re-render happened
   * next. The capability is a property of the engine, not of load order; the
   * calls below are the ones that have to tolerate arriving early.
   */
  // ---- comment anchors ----------------------------------------------------

  /**
   * A pair of Y.RelativePositions, base64-encoded so they survive JSON.
   *
   * `assoc` is how Yjs spells the sticky rule that ADR-012 argues for. A
   * position with assoc >= 0 binds to the character AFTER it, so text typed at
   * that index lands in front of it; assoc < 0 binds to the character before,
   * so text typed there lands behind it. Using 0 for the start and -1 for the
   * end makes both edges exclusive, which is the same behaviour
   * `RichTextOperation.transformRange` produces on the OT side -- by
   * construction here, by arithmetic there.
   */
  createAnchor(from, to) {
    return {
      kind: 'yjs',
      from: encodeRel(Y.createRelativePositionFromTypeIndex(this.text, from, 0)),
      to: encodeRel(Y.createRelativePositionFromTypeIndex(this.text, to, -1)),
      // Carried for the inspector and the lab, never read back by this engine.
      at: { from, to },
    };
  }

  trackAnchors(entries) {
    this.anchors.clear();
    for (const { id, anchor } of entries) {
      if (!anchor || anchor.kind !== 'yjs') continue;
      this.anchors.set(id, { from: decodeRel(anchor.from), to: decodeRel(anchor.to) });
    }
    this.emit('anchors', this.resolvedAnchors());
  }

  /**
   * Resolved fresh every time rather than tracked incrementally.
   *
   * There is no cheaper option and no less correct one: a relative position
   * already encodes everything needed, so this cannot drift, cannot need a
   * resync, and cost nothing to keep up to date while the tab was closed.
   */
  resolvedAnchors() {
    const out = new Map();
    for (const [id, rel] of this.anchors) {
      const from = Y.createAbsolutePositionFromRelativePosition(rel.from, this.doc);
      const to = Y.createAbsolutePositionFromRelativePosition(rel.to, this.doc);
      // A position whose character was deleted resolves to null, or resolves
      // to an empty range. Both mean the comment has lost its text.
      out.set(id, from && to && to.index > from.index
        ? { from: from.index, to: to.index }
        : null);
    }
    return out;
  }

  get canUndo() { return true; }

  undo() { this.undoManager?.undo(); }
  redo() { this.undoManager?.redo(); }

  disconnect() {
    this.wantConnection = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._syncWaiters.splice(0);

    const socket = this.socket;
    this.socket = null;   // before close(), so the onclose guard above no-ops
    this.synced = false;
    this.peers.clear();
    this.emit('peers', this.peers);
    socket?.close();
    this.setStatus('offline');
  }

  destroy() {
    this.disconnect();
    clearTimeout(this.presenceTimer);
    // Cleared BEFORE destroy(), so an `_openLocalStore` still in flight sees
    // the field has moved on and does not emit into a torn-down client.
    const provider = this.persistence;
    this.persistence = null;
    provider?.destroy();
    this.doc.destroy();
  }
}

/**
 * CodeMirror binding for the CRDT engine. Hand-written, like the OT one.
 *
 * This replaced `y-codemirror.next`, and the reason is formatting. That
 * binding syncs characters only: text typed next to a bold word arrives
 * unformatted, because CodeMirror's own document has no attributes to inherit
 * from and the binding has no reason to consult Y.Text's. The result was an
 * editor where bolding a word worked, and then continuing to type at the end
 * of it visibly did not -- while the OT engine, with its own binding, got it
 * right. A difference between the engines that is NOT about concurrency
 * control is exactly the kind of thing this project exists to avoid.
 *
 * So both engines now bind the same way, and the two files are deliberately
 * parallel: read `ot-sync.js` bottom-to-top alongside this and the only real
 * difference is what a local edit is written into.
 *
 * Loaded lazily so this module stays importable from Node -- the checklist
 * harness drives the real YjsSync headlessly, and @codemirror/view needs a DOM.
 *
 * Remote cursors are still rendered by our own engine-agnostic presence layer,
 * never by y-protocols Awareness: tying cursors to Yjs would break them under
 * OT, which is the whole reason presence lives above the seam.
 */
YjsSync.prototype.editorExtensions = async function editorExtensions() {
  const { EditorView, ViewPlugin, keymap } = await import('@codemirror/view');
  const { Annotation } = await import('@codemirror/state');
  const Y = await import('yjs');

  const remote = Annotation.define();
  const self = this;
  const view = { current: null };

  /**
   * Undo that skips other people's edits.
   *
   * CodeMirror's own `history()` is local-only in the wrong sense: it would
   * happily undo a change that arrived from a peer. Y.UndoManager tracks only
   * transactions we originated, which is what "undo" has to mean in a shared
   * document.
   */
  const undoManager = new Y.UndoManager(this.text, { trackedOrigins: new Set([LOCAL_ORIGIN]) });
  this.undoManager = undoManager;

  /** Y.Text delta -> CodeMirror changes, in original-document coordinates. */
  const toChanges = (delta) => {
    const changes = [];
    let pos = 0;
    for (const part of delta) {
      if (part.retain != null) pos += part.retain;
      else if (typeof part.insert === 'string') {
        changes.push({ from: pos, to: pos, insert: part.insert });
      } else if (part.delete != null) {
        changes.push({ from: pos, to: pos + part.delete });
        pos += part.delete;
      }
    }
    return changes;
  };

  this.text.observe((event, transaction) => {
    // Skip only edits that came FROM the editor; they are already in it, and
    // applying them again would duplicate every keystroke.
    //
    // Note this tests the origin, not `transaction.local`. Undo is local too,
    // and it is emphatically not already in the editor -- guarding on
    // `local` silently breaks Ctrl-Z, which still mutates the replica while
    // the visible document sits unchanged. The two then disagree until the
    // next remote edit repaints.
    if (transaction.origin === LOCAL_ORIGIN) return;
    const v = view.current;
    if (!v) return;
    const changes = toChanges(event.delta);
    // A format-only delta is all retains and produces no changes. The marks
    // still need repainting, and the 'rich' event handles that.
    if (changes.length) v.dispatch({ changes, annotations: remote.of(true) });
  });

  const bindView = ViewPlugin.fromClass(class {
    constructor(v) {
      view.current = v;
      // The socket usually syncs before the editor mounts, so seed from
      // whatever the replica already holds. See the note in Editor.jsx.
      if (self.getText() !== v.state.doc.toString()) {
        queueMicrotask(() => v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: self.getText() },
          annotations: remote.of(true),
        }));
      }
    }
  });

  return [
    bindView,
    keymap.of([
      { key: 'Mod-z', run: () => (undoManager.undo(), true), preventDefault: true },
      { key: 'Mod-y', mac: 'Mod-Shift-z', run: () => (undoManager.redo(), true), preventDefault: true },
    ]),
    EditorView.updateListener.of((update) => {
      view.current = update.view;
      if (!update.docChanged) return;
      if (update.transactions.some((tr) => tr.annotation(remote))) return;

      // Read formatting BEFORE mutating, so inserted text can inherit from the
      // document as the user saw it.
      const before = self.getRichText();
      const edits = [];
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        // Inline marks only -- see inlineOnly. At the start of a line the
        // character to the left is the previous line's newline, which carries
        // that line's heading or bullet.
        edits.push({
          fromA, toA, text: inserted.toString(), attrs: inlineOnly(before.attributesAt(fromA)),
        });
      });

      self.doc.transact(() => {
        // Applied back to front so earlier offsets stay valid as we mutate.
        for (const e of edits.reverse()) {
          if (e.toA > e.fromA) self.text.delete(e.fromA, e.toA - e.fromA);
          if (e.text) self.text.insert(e.fromA, e.text, e.attrs);
        }
      }, LOCAL_ORIGIN);
    }),
  ];
};
