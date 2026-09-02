/**
 * Client-side mirror of the server's DocEngine seam.
 *
 * An EditorSync owns: the socket, the concurrency-control data structure, and
 * the binding into CodeMirror. The React UI knows only this interface, so
 * `?engine=ot` can later mount a different implementation without the UI
 * caring.
 *
 * Not hot-swappable by design: switching engines mid-document is a trap with
 * no learning payoff. The toggle reloads the page.
 */
export class EditorSync {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /** @returns {Promise<void>} resolves once the initial sync completes */
  connect() { throw new Error('not implemented'); }

  /**
   * Force an anti-entropy exchange on an ALREADY-OPEN socket.
   *
   * Normally resync happens when a socket opens. A black-hole partition never
   * closes the socket, so nothing triggers it -- healing the partition would
   * otherwise leave the replicas silently diverged forever. The lab calls this
   * on heal; a production system would run it on a timer.
   */
  resync() { throw new Error('not implemented'); }

  /** @param {import('@codemirror/state').Extension[]} _ CodeMirror extensions to mount */
  editorExtensions() { throw new Error('not implemented'); }

  /**
   * The document as a plain string, right now.
   *
   * The editor MUST seed its initial state from this. Both engines' CodeMirror
   * bindings only apply *changes*, so a document that finished syncing before
   * the editor mounted would otherwise render blank forever -- which is
   * exactly what happens when you open an existing document rather than
   * watching one being typed.
   * @returns {string}
   */
  getText() { throw new Error('not implemented'); }

  /**
   * The document WITH formatting, as a RichText.
   *
   * The editor renders marks from this. It is separate from `getText` rather
   * than replacing it because plenty of callers -- the inspector, the byte
   * counters, the test harnesses -- want the characters and nothing else, and
   * making all of them unwrap runs would be noise.
   *
   * @returns {import('@collab/ot').RichText}
   */
  getRichText() { throw new Error('not implemented'); }

  /**
   * Apply a formatting change to a range. `null` as a value removes an
   * attribute, which is how un-bolding is expressed -- see attributes.js.
   *
   * Both engines implement this, and neither exposes how: OT builds a retain
   * with attributes, the CRDT calls into Y.Text. That difference stops here,
   * which is the seam doing its job.
   *
   * @param {number} _from
   * @param {number} _to
   * @param {Record<string, unknown>} _attributes
   */
  format(_from, _to, _attributes) { throw new Error('not implemented'); }

  /**
   * Change the session token and reconnect so the server re-reads who we are.
   *
   * The token is a QUERY PARAMETER on the socket url (the browser cannot set
   * headers on an upgrade), so it is fixed for the life of a connection: a
   * guest who signs in mid-document is still anonymous to the room until the
   * socket is replaced. Hence the reconnect -- it is not a heavy-handed
   * refresh, it is the only way to restate identity on this transport.
   *
   * Cheap by construction, and this is where delta sync pays for itself: the
   * new socket sends the state vector we already have and gets back only what
   * it is missing, which after a two-second round trip is nothing.
   *
   * Implemented once here because both engines' clients hold the same three
   * fields -- `token`, `wantConnection`, and a `connect`/`disconnect` pair.
   *
   * @param {string|null} token
   */
  setToken(token) {
    const next = token ?? null;
    if (this.token === next) return;
    this.token = next;
    // Only reconnect if a connection is actually wanted. Signing in while
    // deliberately offline must not drag the tab back online behind the user.
    if (this.wantConnection) {
      this.disconnect();
      this.connect();
    }
  }

  /**
   * Whether this engine can undo. Not a capability flag for its own sake: the
   * toolbar hides the buttons when it is false, because a visible Undo that
   * does nothing is a worse answer than no Undo.
   *
   * The CRDT client overrides it. The OT client does not have an undo model
   * yet -- undo under server-authoritative OT means transforming an inverse
   * operation against everything that has landed since, which is a real piece
   * of work and not a wrapper around a history array.
   */
  get canUndo() { return false; }

  /**
   * Undo the LOCAL client's last change.
   *
   * Emphatically not CodeMirror's `history()`, which would happily undo an
   * edit that arrived from a peer -- in a shared document that is not undo,
   * it is editing someone else's work by pressing Ctrl+Z.
   */
  undo() {}
  redo() {}

  // ---- comment anchors ----------------------------------------------------
  //
  // Three methods, and the two engines mean completely different things by
  // them. That is the point -- ADR-012 exists because this is the first
  // feature where the seam had to hide a difference in KIND rather than a
  // difference in mechanism.
  //
  //   CRDT  an anchor is a relative position naming a character. Resolving it
  //         is a lookup, always current, and works offline.
  //   OT    an anchor is a pair of indices. The server owns the authoritative
  //         values; this client mirrors them by transforming through the same
  //         operations in the same order, and re-reads the truth on resync.

  /**
   * Mint an anchor for a range, in whatever form this engine can resolve
   * later. The result is opaque JSON, stored verbatim by the server.
   *
   * @param {number} _from
   * @param {number} _to
   * @returns {object}
   */
  createAnchor(_from, _to) { throw new Error('not implemented'); }

  /**
   * Hand the engine the full set of anchors it should keep current.
   *
   * Replaces the previous set rather than merging: the caller has just read
   * the authoritative list, and a merge would silently keep an anchor the
   * server has deleted.
   *
   * @param {{id: string, anchor: object}[]} _entries
   */
  trackAnchors(_entries) {}

  /**
   * Where every tracked anchor is right now, in current document coordinates.
   * A null value means the anchor no longer resolves -- its text is gone.
   *
   * @returns {Map<string, {from: number, to: number}|null>}
   */
  resolvedAnchors() { return new Map(); }

  /** @param {{name: string, color: string}} _user */
  setLocalUser(_user) {}

  /** @param {{anchor: number, head: number}|null} _sel */
  setLocalCursor(_sel) {}

  disconnect() {}
  destroy() {}

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    for (const fn of this._listeners.get(event) ?? []) fn(payload);
  }
}
