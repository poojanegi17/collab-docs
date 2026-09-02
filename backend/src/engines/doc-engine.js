/**
 * The seam.
 *
 * A DocEngine owns concurrency control for exactly one document. The transport
 * layer knows only this interface -- it never sees a Y.Doc, a state vector, or
 * an OT revision number. Adding OT later means writing a second class here and
 * flipping a config flag, not rewriting the server.
 *
 * Why this shape:
 *   - CRDT engines are almost pass-through (broadcast + persist).
 *   - OT engines are server-authoritative: they must transform an incoming op
 *     against every revision the client had not yet seen, assign a new
 *     revision, and reply to the sender too (with an ack).
 *
 * So `handleMessage` returns a *routing decision* rather than plain bytes:
 * that is the one degree of freedom OT needs and CRDT does not, and building
 * it in now is what keeps OT from being a rewrite.
 */

/**
 * @typedef {Object} EngineReply
 * @property {Uint8Array[]} [toSender]   frames for the client that just spoke
 * @property {Uint8Array[]} [toOthers]   frames for every other client in the room
 */

export class DocEngine {
  /** @param {string} docId */
  constructor(docId) {
    this.docId = docId;
  }

  /**
   * Rehydrate from durable storage: a snapshot plus every update logged after
   * it. Both are opaque bytes that this engine itself produced.
   * @param {{ snapshot: Uint8Array|null, updates: Uint8Array[] }} _loaded
   */
  restore(_loaded) {
    throw new Error('not implemented');
  }

  /**
   * Frames to send to a client that has just joined, before it says anything.
   * @param {string} clientId
   * @returns {Uint8Array[]}
   */
  onClientJoin(clientId) {
    throw new Error('not implemented');
  }

  /**
   * @param {string} clientId
   * @param {Uint8Array} payload opaque engine payload from MSG_ENGINE
   * @param {{ canEdit?: boolean }} [context] what this client is allowed to do
   * @returns {EngineReply}
   *
   * `canEdit` is enforced HERE rather than in the room, and that placement is
   * the whole point: a viewer must still be able to run the sync handshake,
   * because reading a document is what a viewer is for. Telling a handshake
   * frame apart from a mutating one requires understanding the engine's
   * sub-protocol, and the room deliberately does not -- it routes opaque
   * payloads. A blanket check up there locked viewers out of documents
   * entirely, which looked exactly like a hung connection.
   */
  handleMessage(clientId, payload, context) {
    throw new Error('not implemented');
  }

  /** @param {string} clientId */
  onClientLeave(clientId) {}

  /**
   * The document as a RichText -- the one place the engine seam is asked to
   * expose CONTENT rather than opaque bytes.
   *
   * Version history needs it: rebuilding "the document as of last Tuesday"
   * means restoring a throwaway engine from an old checkpoint and reading what
   * came out. Bytes would not do, because the whole point is to compare and
   * display it. Both engines already have a RichText internally, so this is a
   * read, not a conversion layer.
   *
   * @returns {import('@collab/ot').RichText}
   */
  readDocument() {
    throw new Error('not implemented');
  }

  /**
   * Replace the document wholesale, as a server-initiated edit.
   *
   * This is how "restore this version" works, and it is deliberately an EDIT
   * rather than a rewrite of state: the old content stays in the log, restore
   * appears in the history like anything else, and it can itself be undone.
   * Rewinding the log instead would mean the act of restoring destroys the
   * versions after the one you restored -- which is the behaviour people are
   * most surprised by, and least able to recover from.
   *
   * Returns frames for EVERY client, since no client sent anything.
   *
   * @param {import('@collab/ot').RichText} _doc
   * @param {string} [_authorId]
   * @returns {{ toOthers: Uint8Array[] }}
   */
  replaceWith(_doc, _authorId) {
    throw new Error('not implemented');
  }

  /** Current document state as opaque bytes, for the snapshot table. */
  snapshot() {
    throw new Error('not implemented');
  }

  /**
   * Who wrote each character, as runs aligned to the document (ADR-018).
   *
   * The second place after ADR-012 where the two engines differ in KIND rather
   * than in mechanism -- and this time the asymmetry points the other way.
   *
   *   CRDT  free. A Yjs document is a list of items each carrying the id of
   *         the client that inserted it, and it carries them because that is
   *         how the CRDT ORDERS characters, not as a favour to this method.
   *         Attribution is a byproduct of the correctness mechanism, it costs
   *         no new persisted state, and it works retroactively on documents
   *         written long before anyone thought of asking.
   *   OT    explicit bookkeeping. The server transforms an operation, applies
   *         it, and what survives is the resulting text -- an op says "insert
   *         three characters at 12", and after two more transforms nothing in
   *         the document remembers which client that was. The engine therefore
   *         maintains a parallel per-character author array, persists an author
   *         with every log entry, and carries the array through snapshots.
   *
   * Returns null for an engine that cannot attribute at all, which is a
   * different answer from "nobody wrote this" and is rendered differently.
   *
   * `identities` maps the ids used in `runs` to something displayable. The
   * engines disagree about what an author id even is -- a Yjs client number
   * versus a transport client id -- so the map is part of the answer rather
   * than something the caller is expected to already have.
   *
   * @returns {{ runs: {author: string|null, length: number}[],
   *             identities: Record<string, {name: string, color: string}> } | null}
   */
  readAuthorship() {
    return null;
  }

  /**
   * Does this engine need the SERVER to maintain comment anchors?
   *
   * The two engines answer differently, which is the whole of ADR-012:
   *
   *   CRDT  false -- an anchor is a relative position that names a character
   *                  and rides along with it. Nothing is computed, so there is
   *                  nothing for the server to be authoritative about.
   *   OT    true  -- an anchor is an index into a document other people are
   *                  editing. Transforming it against concurrent operations
   *                  does not converge when deletes are involved, so exactly
   *                  one party must do it: the one that already decides the
   *                  order of operations.
   */
  get ownsAnchors() {
    return false;
  }

  /**
   * Called with every operation this engine sequences, in the order it
   * sequenced them. Only meaningful when `ownsAnchors` is true.
   *
   * The transport sets this; the engine merely fires it. Anchors are stored
   * with comments, which the engine has no business knowing about -- it knows
   * how to transform a range and nothing else.
   *
   * @type {((op: import('@collab/ot').RichTextOperation) => void)|null}
   */
  onSequenced = null;

  /**
   * Move a range through everything this engine has applied, if it can.
   * Returns null when the range no longer exists.
   *
   * @param {{from: number, to: number}} _range
   * @param {import('@collab/ot').RichTextOperation} _op
   * @returns {{from: number, to: number}|null}
   */
  transformRange(_range, _op) {
    throw new Error('not implemented');
  }

  /**
   * Bring a range from an older revision up to the current one.
   *
   * Meaningless for an engine whose anchors are relative rather than
   * positional, so the base class returns the range untouched: under the CRDT
   * a client's anchor is already expressed in terms the document itself
   * carries, and there is no "older revision" for it to be stale against.
   *
   * @param {{from: number, to: number}} range
   * @param {number} _fromRev
   */
  catchUpRange(range, _fromRev) {
    return range;
  }

  /**
   * May the transport hold outbound frames briefly, merge them, and send ONE
   * frame to everyone -- including whoever sent the edit?
   *
   * This is the engine's answer to the first limit `/scale` measures: traffic
   * in a room grows with the square of the people in it, because every
   * keystroke is relayed to everyone else individually. Merging is the fix,
   * and only the engine can say whether it is legal.
   *
   *   CRDT  true  -- updates merge by construction, and applying one you
   *                  already have is a no-op. So a window's worth of edits
   *                  from EVERYONE becomes one frame, and echoing it back to
   *                  its authors costs a few bytes and simplifies the fan-out
   *                  from N frames to one.
   *   OT    false -- server-authoritative, one operation in flight, and the
   *                  sender is waiting for an ack that is specifically theirs.
   *                  There is nothing here to merge and an echo would be a
   *                  second application of an op the client already has.
   *
   * Default false: an engine that has not thought about it must not be
   * batched by a transport that cannot tell.
   */
  get coalescible() {
    return false;
  }

  /**
   * Collapse a run of outbound frames into fewer, equivalent ones.
   *
   * Only called when `coalescible` is true. Order is significant and must be
   * preserved; returning the input unchanged is always correct, just slower.
   *
   * @param {Uint8Array[]} frames
   * @returns {Uint8Array[]}
   */
  coalesce(frames) {
    return frames;
  }

  /** Human-readable state for the debug view. Must not be needed for correctness. */
  inspect() {
    return {};
  }

  destroy() {}
}
