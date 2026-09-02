/**
 * OT client -- the Jupiter three-state machine.
 *
 * The client may have edits the server has not seen, and the server may send
 * edits the client has not seen, at the same time. Reconciling that is the
 * client's entire job, and it has exactly three states:
 *
 *   SYNCHRONIZED         no edit in flight. A local edit is sent immediately.
 *   AWAITING_CONFIRM     one op in flight, waiting for an ack.
 *   AWAITING_WITH_BUFFER one op in flight, plus local edits composed into a
 *                        single pending buffer behind it.
 *
 * There is never more than ONE op in flight. That is not an optimisation, it
 * is what makes the server's job tractable: the server transforms an incoming
 * op against history it can bound. And the buffer stays a single operation no
 * matter how long the ack takes, because `compose` collapses it -- which is
 * why the op model is a changeset rather than {insert, pos}.
 *
 * The transform argument order is load-bearing. The client's own op is ALWAYS
 * argument `a`, here and on the server. Same tie-break everywhere, so an
 * insert at a contested position resolves identically on every replica.
 *
 * Like `yjs-sync.js`, this class is DOM-free so the test harness can drive it
 * headlessly. The CodeMirror binding is attached at the bottom of the file.
 */
import { RichTextOperation, RichText, inlineOnly } from '@collab/ot';
import {
  MSG_ENGINE, MSG_AWARENESS, MSG_HELLO, MSG_DEBUG, MSG_COMMENTS, MSG_TASKS, MSG_TABS,
  encode, decode, decodeJson, toBytes,
} from '@collab/protocol';
import {
  OT_INIT, OT_OP, OT_ACK, OT_APPLY, OT_RESYNC, OT_SYNC, encodeOt, decodeOt,
} from '@collab/protocol/ot-wire';
import { EditorSync } from './editor-sync.js';

const SYNCHRONIZED = 'synchronized';
const AWAITING_CONFIRM = 'awaitingConfirm';
const AWAITING_WITH_BUFFER = 'awaitingWithBuffer';

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const PRESENCE_THROTTLE_MS = 60;

export class OTSync extends EditorSync {
  /**
   * @param {{ url: string, docId: string, clientId: string,
   *           socketFactory?: (url: string) => WebSocket }} opts
   */
  constructor({ url, docId, clientId, socketFactory, token }) {
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

    /**
     * The local document. Under OT this is an ordinary value, not a CRDT --
     * the server owns the truth. It is a RichText rather than a string since
     * ADR-006; the state machine below never looks inside it.
     */
    this.doc = new RichText();
    /**
     * Comment anchors as plain index pairs, mirrored from the server.
     *
     * "Mirrored" is exact: the server owns these (ADR-012). This client keeps
     * its copy current by transforming through the same operations in the same
     * order the server sequenced them, which produces the same answer -- the
     * divergence ADR-012 measures comes from transforming CONCURRENT ops in
     * different orders, and an OT client never does that. On resync the
     * server's values replace these outright.
     * @type {Map<string, {from: number, to: number}|null>}
     */
    this.anchors = new Map();

    /** Last server revision we have incorporated. */
    this.rev = 0;

    this.otState = SYNCHRONIZED;
    /** @type {RichTextOperation|null} in flight, awaiting ack */
    this.outstanding = null;
    /** @type {RichTextOperation|null} composed local edits behind the outstanding op */
    this.buffer = null;

    this.socket = null;
    this.status = 'offline';
    this.synced = false;
    this.attempt = 0;
    this.wantConnection = false;
    this._syncWaiters = [];

    this.peers = new Map();
    this.localUser = { name: 'anon', color: '#888' };
    this.localCursor = null;
    this.presenceTimer = null;

    this.stats = { bytesSent: 0, bytesRecv: 0, lastSyncRecv: 0, docLength: 0 };
    /** Populated by the CodeMirror binding so remote ops can be applied. */
    this._applyToEditor = null;
  }

  // ---- connection ----------------------------------------------------------

  connect() {
    this.wantConnection = true;
    return new Promise((resolve) => {
      if (this.synced) { resolve(); return; }
      this._syncWaiters.push(resolve);
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
      // No handshake to send: the server pushes INIT. Under OT the client has
      // nothing useful to tell the server about what it already has, because
      // there is no state vector -- only a revision number the server would
      // have to trust.
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
      // See yjs-sync.js: a stale socket closing must not clobber a newer one.
      if (this.socket !== socket) return;
      this.socket = null;
      this.synced = false;
      this.peers.clear();
      this.emit('peers', this.peers);
      this.setStatus('offline');
      if (this.wantConnection) this.scheduleReconnect();
    };

    socket.onerror = () => { /* onclose always follows */ };
  }

  scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    const jittered = delay * (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._open(); }, jittered);
  }

  // ---- protocol ------------------------------------------------------------

  getText() {
    return this.doc.toString();
  }

  /**
   * The document WITH its formatting. The editor needs this to build
   * decorations; `getText` alone would render every mark invisible.
   */
  getRichText() {
    return this.doc;
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

      case MSG_ENGINE:
        this.handleOt(decodeOt(payload));
        break;

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

  /**
   * Ask the server to re-send the document. Under OT there is no delta to
   * request -- no state vector exists to describe what we have -- so this costs
   * a full document every time. That asymmetry with the CRDT path is the point,
   * and the lab timeline makes the byte counts visible side by side.
   */
  resync() {
    this.send(MSG_ENGINE, encodeOt({ t: OT_SYNC }));
  }

  handleOt(msg) {
    switch (msg.t) {
      case OT_INIT:
      case OT_RESYNC: {
        // Whole-document reset. Any in-flight work is discarded: we cannot
        // rebase it, because the revisions it was based on are gone.
        const replacement = RichText.fromJSON(msg.doc);
        this.rev = msg.rev;
        this.outstanding = null;
        this.buffer = null;
        this.otState = SYNCHRONIZED;
        this.replaceLocalDoc(replacement, msg.t === OT_RESYNC);
        if (!this.synced) {
          this.synced = true;
          this.setStatus('synced');
          this.emit('synced', this.stats);
          for (const resolve of this._syncWaiters.splice(0)) resolve();
        }
        break;
      }

      case OT_ACK: {
        this.rev = msg.rev;
        if (this.otState === AWAITING_CONFIRM) {
          this.outstanding = null;
          this.otState = SYNCHRONIZED;
        } else if (this.otState === AWAITING_WITH_BUFFER) {
          // The buffer becomes the next op in flight. Exactly one at a time.
          this.outstanding = this.buffer;
          this.buffer = null;
          this.otState = AWAITING_CONFIRM;
          this.sendOp(this.outstanding);
        } else {
          throw new Error('ack received while synchronized -- protocol desync');
        }
        this.emit('ot', this.inspect());
        break;
      }

      case OT_APPLY: {
        let incoming = RichTextOperation.fromJSON(msg.ops);
        this.rev = msg.rev;

        // Rebase our pending work over the incoming op, and rebase the
        // incoming op over our pending work, so it can be applied to a
        // document that already contains our local edits.
        if (this.otState === AWAITING_CONFIRM) {
          [this.outstanding, incoming] = RichTextOperation.transform(this.outstanding, incoming);
        } else if (this.otState === AWAITING_WITH_BUFFER) {
          [this.outstanding, incoming] = RichTextOperation.transform(this.outstanding, incoming);
          [this.buffer, incoming] = RichTextOperation.transform(this.buffer, incoming);
        }

        this.applyRemote(incoming);
        this.emit('ot', this.inspect());
        break;
      }

      default:
        console.warn('unknown OT message', msg.t);
    }
  }

  /**
   * A local edit, already applied to the editor. Feed it into the state
   * machine.
   * @param {RichTextOperation} op
   */
  applyLocal(op) {
    this.doc = op.apply(this.doc);
    this.stats.docLength = this.doc.length;
    this.moveAnchors(op);

    switch (this.otState) {
      case SYNCHRONIZED:
        this.outstanding = op;
        this.otState = AWAITING_CONFIRM;
        this.sendOp(op);
        break;
      case AWAITING_CONFIRM:
        this.buffer = op;
        this.otState = AWAITING_WITH_BUFFER;
        break;
      case AWAITING_WITH_BUFFER:
        // Collapse into the existing buffer. However long we stay offline, the
        // buffer remains ONE operation.
        this.buffer = this.buffer.compose(op);
        break;
    }
    this.emit('doc', this.stats);
    this.emit('rich', this.doc);
    this.emit('ot', this.inspect());
  }

  /**
   * Apply a formatting change to a range.
   *
   * This goes through exactly the same path as typing -- it builds an
   * operation and hands it to `applyLocal`. Formatting is not a special case
   * anywhere in this client, which is the payoff for carrying attributes on
   * `retain` instead of inventing a format message. See ADR-006.
   *
   * @param {number} from
   * @param {number} to
   * @param {Record<string, unknown>} attributes  null values remove an attribute
   */
  format(from, to, attributes) {
    if (to <= from) return;
    const op = new RichTextOperation()
      .retain(from)
      .retain(to - from, attributes)
      .retain(this.doc.length - to);
    this.applyLocal(op);
  }

  /** A remote op, already rebased onto our local state. */
  applyRemote(op) {
    this.doc = op.apply(this.doc);
    this.stats.docLength = this.doc.length;
    this._applyToEditor?.(op);
    this.moveAnchors(op);
    this.emit('doc', this.stats);
    this.emit('rich', this.doc);
  }

  // ---- comment anchors ----------------------------------------------------

  /**
   * A pair of indices plus the revision they were measured against.
   *
   * The revision is the load-bearing part. Between selecting text and the
   * POST landing, the server may have sequenced other people's operations, so
   * these indices describe a document that no longer exists -- the server
   * catches them up through exactly those revisions before storing them
   * (Room.mintAnchor). Sending indices without a revision would be sending a
   * measurement without saying what it was measured against.
   */
  createAnchor(from, to) {
    return { kind: 'ot', from, to, rev: this.rev };
  }

  trackAnchors(entries) {
    this.anchors.clear();
    for (const { id, anchor } of entries) {
      if (!anchor || anchor.kind !== 'ot') continue;
      this.anchors.set(id, { from: anchor.from, to: anchor.to });
    }
    this.emit('anchors', this.resolvedAnchors());
  }

  resolvedAnchors() {
    return new Map(this.anchors);
  }

  /**
   * Carry every tracked anchor through one operation.
   *
   * Called for local and remote operations alike, because both change the
   * indices -- there is nothing special about your own typing from an
   * anchor's point of view.
   *
   * @param {RichTextOperation} op
   */
  moveAnchors(op) {
    if (this.anchors.size === 0) return;
    let changed = false;
    for (const [id, range] of this.anchors) {
      if (!range) continue;
      const moved = RichTextOperation.transformRange(op, range);
      if (!moved || moved.from !== range.from || moved.to !== range.to) {
        // null is stored rather than deleted: the thread still exists, it has
        // just lost its text, and the sidebar needs to say so.
        this.anchors.set(id, moved);
        changed = true;
      }
    }
    if (changed) this.emit('anchors', this.resolvedAnchors());
  }

  replaceLocalDoc(doc, hadPendingWork) {
    if (hadPendingWork) console.warn('[ot] resync: local pending edits were discarded');
    // Rebuilt as one delete-then-insert so the editor binding has a single
    // change to apply. The inserted runs carry their formatting with them.
    const op = new RichTextOperation().delete(this.doc.length);
    for (const run of doc.runs) op.insert(run.text, run.attributes);
    this.doc = doc;
    this.stats.docLength = doc.length;
    this._applyToEditor?.(op);
    this.emit('doc', this.stats);
    this.emit('rich', this.doc);
  }

  sendOp(op) {
    // `rev` is the revision this op is based on. If we are offline the send
    // fails silently and the op stays in `outstanding` -- but note it will NOT
    // be retried on reconnect: the server pushes INIT and we reset. That is an
    // honest OT limitation, not an oversight. See the note in the class docs
    // for offline behaviour.
    this.send(MSG_ENGINE, encodeOt({ t: OT_OP, rev: this.rev, ops: op.toJSON() }));
  }

  send(type, payload) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    const frame = encode(type, payload);
    this.stats.bytesSent += frame.length;
    this.socket.send(frame);
    return true;
  }

  inspect() {
    return {
      engine: 'ot',
      rev: this.rev,
      state: this.otState,
      outstanding: this.outstanding?.toString() ?? null,
      buffered: this.buffer?.toString() ?? null,
      length: this.doc.length,
      runs: this.doc.runs.length,
    };
  }

  // ---- presence (identical to the CRDT client -- it is engine-agnostic) -----

  setLocalUser(user) {
    this.localUser = { ...this.localUser, ...user };
    this.publishPresence(true);
  }

  setLocalCursor(sel) {
    this.localCursor = sel;
    this.publishPresence(false);
  }

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

  /** See the note in yjs-sync.js: every teardown here must be synchronous. */
  disconnect() {
    this.wantConnection = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._syncWaiters.splice(0);

    const socket = this.socket;
    this.socket = null;
    this.synced = false;
    this.peers.clear();
    this.emit('peers', this.peers);
    socket?.close();
    this.setStatus('offline');
  }

  destroy() {
    this.disconnect();
    clearTimeout(this.presenceTimer);
  }
}

/**
 * CodeMirror binding, lazily loaded so this module stays Node-importable.
 *
 * Two conversions, and an echo guard. The guard matters more than it looks:
 * without the `remote` annotation, applying a remote op would fire the update
 * listener, which would send that same op straight back to the server.
 */
OTSync.prototype.editorExtensions = async function editorExtensions() {
  const { EditorView, ViewPlugin } = await import('@codemirror/view');
  const { Annotation } = await import('@codemirror/state');

  const remote = Annotation.define();

  /** CodeMirror ChangeSet -> RichTextOperation */
  const toOperation = (changes, docLength, doc) => {
    const op = new RichTextOperation();
    let pos = 0;
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      op.retain(fromA - pos);
      if (toA > fromA) op.delete(toA - fromA);
      // Newly typed text inherits the formatting to its left, read from the
      // pre-change document. CodeMirror knows nothing about attributes, so if
      // we did not do this every keystroke would come out unformatted and
      // bolding a word then continuing to type would visibly stop working.
      // Inline marks only: typing at the start of a line must not inherit the
      // previous line's heading or bullet from the newline that carries it.
      if (inserted.length) op.insert(inserted.toString(), inlineOnly(doc.attributesAt(fromA)));
      pos = toA;
    });
    op.retain(docLength - pos);
    return op;
  };

  /**
   * RichTextOperation -> CodeMirror changes.
   *
   * Attributes are dropped here, deliberately: CodeMirror's document is plain
   * text and formatting is rendered as decorations built from the RichText.
   * A format-only operation therefore produces an EMPTY change list, and the
   * marks refresh off the `rich` event instead.
   */
  const toChanges = (op) => {
    const changes = [];
    let pos = 0;
    for (const c of op.ops) {
      if (typeof c.i === 'string') changes.push({ from: pos, to: pos, insert: c.i });
      else if (typeof c.r === 'number') pos += c.r;
      else { changes.push({ from: pos, to: pos + c.d }); pos += c.d; }
    }
    return changes;
  };

  const view = { current: null };

  this._applyToEditor = (op) => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ changes: toChanges(op), annotations: remote.of(true) });
  };

  const self = this;

  // Grab the view as soon as the editor exists, and seed it with whatever INIT
  // already delivered -- the socket usually syncs before the editor mounts.
  const bindView = ViewPlugin.fromClass(class {
    constructor(v) {
      view.current = v;
      if (self.getText() !== v.state.doc.toString()) {
        // Cannot dispatch during a view update, so defer by a microtask.
        queueMicrotask(() => v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: self.getText() },
          annotations: remote.of(true),
        }));
      }
    }
  });

  return [
    bindView,
    EditorView.updateListener.of((update) => {
      view.current = update.view;
      if (!update.docChanged) return;
      // Ignore our own remote applications, or we echo forever.
      if (update.transactions.some((tr) => tr.annotation(remote))) return;
      self.applyLocal(toOperation(update.changes, update.startState.doc.length, self.doc));
    }),
  ];
};
