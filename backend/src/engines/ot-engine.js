/**
 * Operational Transformation engine -- server-authoritative, Jupiter-style.
 * This is the shape most collaborative word processors are built on.
 *
 * Contrast with `yjs-engine.js`, which is the whole point of having both:
 *
 *                        CRDT engine              OT engine
 *   server knows edits?   no, it relays bytes     yes, it owns the document
 *   ordering              per-character ids       a single revision counter
 *   concurrent edits      merge by construction   transformed against history
 *   reply to sender       never                   always (an ack)
 *   offline for hours     fine                    only while history survives
 *   horizontal scale      route anywhere          one writer per document
 *
 * The core loop is four lines, in `handleMessage`. Everything else is
 * bookkeeping around them.
 */
import { RichTextOperation, RichText } from '@collab/ot';
import { MSG_ENGINE, encode } from '@collab/protocol';
import {
  OT_INIT, OT_OP, OT_ACK, OT_APPLY, OT_RESYNC, OT_SYNC, encodeOt, decodeOt,
} from '@collab/protocol/ot-wire';
import { DocEngine } from './doc-engine.js';

const frame = (message) => encode(MSG_ENGINE, encodeOt(message));

/**
 * Read an operation out of the durable update log.
 *
 * The log is append-only and predates rich text, so it can hold both
 * encodings: the flat `[2, "y", -3]` form and the tagged `[{r:2},{i:"y"},{d:3}]`
 * one. Detecting which is a one-line check, and doing it here means an
 * existing database replays instead of throwing on boot -- the storage layer
 * stores opaque bytes and cannot help with this, by design.
 */
function fromStoredOps(ops) {
  const legacy = ops.length > 0 && ops.every((c) => typeof c === 'number' || typeof c === 'string');
  if (!legacy) return RichTextOperation.fromJSON(ops);

  const out = new RichTextOperation();
  for (const c of ops) {
    if (typeof c === 'string') out.insert(c);
    else if (c > 0) out.retain(c);
    else out.delete(-c);
  }
  return out;
}

/**
 * Carry a per-character author array through one operation (ADR-018).
 *
 * This is the bookkeeping the CRDT does not need. An operation says "retain
 * 12, insert 3, delete 4" -- it describes a change to TEXT, and nothing in it
 * or in the resulting document remembers who. So authorship is maintained as a
 * parallel array of the same length as the document, walked in lockstep with
 * the op:
 *
 *   retain  copy that many authors across unchanged
 *   insert  write `by` once per inserted character
 *   delete  drop that many, exactly as the text drops them
 *
 * A retain with attributes is still a retain here. Bolding a word does not
 * change who wrote it, and treating formatting as authorship would hand a
 * whole paragraph to whoever last selected it and pressed Ctrl+B.
 */
function applyAuthorship(authors, op, by) {
  const out = [];
  let i = 0;
  for (const c of op.ops) {
    if (typeof c.i === 'string') {
      for (let k = 0; k < c.i.length; k++) out.push(by);
    } else if (typeof c.d === 'number') {
      i += c.d;
    } else if (typeof c.r === 'number') {
      for (let k = 0; k < c.r; k++) out.push(authors[i++] ?? null);
    }
  }
  // Anything past the op's base length is untouched tail. `transform` keeps
  // ops exactly as long as the document, but a legacy log entry predating that
  // guarantee would otherwise silently truncate attribution.
  while (i < authors.length) out.push(authors[i++]);
  return out;
}

/** Run-length encode the author array, for the wire and for snapshots. */
function encodeAuthors(authors) {
  const runs = [];
  for (const a of authors) {
    const last = runs[runs.length - 1];
    if (last && last.author === a) last.length++;
    else runs.push({ author: a ?? null, length: 1 });
  }
  return runs;
}

function decodeAuthors(runs) {
  const out = [];
  for (const r of runs ?? []) {
    for (let k = 0; k < r.length; k++) out.push(r.author ?? null);
  }
  return out;
}

export class OTEngine extends DocEngine {
  /**
   * @param {string} docId
   * @param {(bytes: Uint8Array) => void} persistUpdate
   */
  constructor(docId, persistUpdate) {
    super(docId);
    /**
     * The authoritative document. Under OT there is exactly one.
     *
     * A RichText -- runs of text plus attribute maps -- rather than a string.
     * The engine itself does not care, because it never inspects content, only
     * applies operations to it. That is why making documents rich barely
     * touched this file. See ADR-006.
     */
    this.doc = new RichText();
    /** Monotonic revision counter. `rev` == `history.length + historyBase`. */
    this.rev = 0;
    /** Ops applied since `historyBase`, in revision order. */
    this.history = [];
    /**
     * Revisions below this were folded into a snapshot and discarded. A client
     * reconnecting from further back than this cannot be transformed forward,
     * and gets a full RESYNC instead. Real systems make exactly this trade;
     * keeping unbounded history is the alternative and it is not free.
     */
    this.historyBase = 0;
    this.persistUpdate = persistUpdate;

    /**
     * Who wrote each character, one entry per character of `this.doc`.
     *
     * Kept in lockstep with the document by `applyAuthorship`. Under the CRDT
     * this array has no counterpart: the equivalent information is already
     * inside the document structure, because the CRDT needs it to order
     * characters at all (ADR-018).
     *
     * `null` means genuinely unknown -- a character replayed from a log entry
     * written before entries recorded an author. Distinct from an author whose
     * display name we cannot resolve.
     */
    this.authors = [];

    /** Ring buffer of recent transforms, for the debug view. */
    this.transformLog = [];

    /**
     * Transport client id -> name and colour, for whoever is currently
     * connected. Unlike the CRDT's, this map is NOT part of the document: OT
     * documents hold text and nothing else, so there is nowhere in the format
     * to put it, and it is repopulated from presence on each connect.
     *
     * The consequence is real and is stated in ADR-018: a name here does not
     * survive a restart, so text attributed to somebody who has since
     * disconnected shows as an unresolved author.
     */
    this.identityMap = new Map();
  }

  restore({ snapshot, updates }) {
    if (snapshot) {
      const state = JSON.parse(new TextDecoder().decode(snapshot));
      // Snapshots written before ADR-006 hold a plain string under "text".
      // Reading both shapes costs one line and means an existing database
      // still opens, so there is no reason to make the reader choose.
      this.doc = state.runs
        ? RichText.fromJSON(state.runs)
        : RichText.fromString(state.text ?? '');
      this.rev = state.rev;
      this.historyBase = state.rev;
      // Snapshots written before ADR-018 have no `authors`, so a compacted
      // document that predates it comes back unattributed rather than wrong.
      this.authors = decodeAuthors(state.authors);
      // Belt and braces: a snapshot whose author array disagrees with its text
      // length is worse than none, because every run after the divergence
      // points at the wrong characters.
      if (this.authors.length !== this.doc.length) {
        this.authors = new Array(this.doc.length).fill(null);
      }
    }
    // Log entries are already-transformed ops in revision order, so replaying
    // them is a plain sequential apply -- no transformation needed on restore.
    for (const bytes of updates) {
      const entry = JSON.parse(new TextDecoder().decode(bytes));
      const op = fromStoredOps(entry.ops);
      this.doc = op.apply(this.doc);
      // `entry.by` is absent in every log entry written before ADR-018. Those
      // characters replay as null, which renders as unattributed -- the honest
      // answer, and the one thing this could not do without a format change.
      this.authors = applyAuthorship(this.authors, op, entry.by ?? null);
      this.history.push(op);
      this.rev++;
    }
  }

  onClientJoin() {
    // OT has no delta handshake: a joining client is told the current text and
    // revision outright. This is a real cost versus the CRDT path, where a
    // reconnecting client exchanges state vectors and receives only what it
    // lacks. Here, every join is O(document size).
    return [frame({ t: OT_INIT, rev: this.rev, doc: this.doc.toJSON() })];
  }

  handleMessage(clientId, payload, { canEdit = true } = {}) {
    const msg = decodeOt(payload);

    if (msg.t === OT_SYNC) {
      // Anti-entropy. No delta is possible under OT, so this is a whole
      // document every time -- see docs/decisions/004-ot-engine.md.
      return { toSender: [frame({ t: OT_INIT, rev: this.rev, doc: this.doc.toJSON() })] };
    }
    if (msg.t !== OT_OP) throw new Error(`unexpected OT message: ${msg.t}`);

    // A viewer's edit is answered with the document rather than dropped
    // silently. Under OT, ignoring an OP would leave that client waiting on an
    // ack that is never coming, wedged in AWAITING_CONFIRM -- so the correct
    // refusal is the one the protocol already has for "your state is not
    // usable", which snaps them back to the server's version.
    if (!canEdit) {
      return { toSender: [frame({ t: OT_RESYNC, rev: this.rev, doc: this.doc.toJSON() })] };
    }

    if (msg.rev < this.historyBase) {
      // We threw away the history needed to rebase this client. Tell it to
      // start over rather than silently corrupting the document.
      return { toSender: [frame({ t: OT_RESYNC, rev: this.rev, doc: this.doc.toJSON() })] };
    }
    if (msg.rev > this.rev) {
      throw new Error(`client ${clientId} sent rev ${msg.rev}, ahead of server rev ${this.rev}`);
    }

    let op = RichTextOperation.fromJSON(msg.ops);
    const concurrent = this.history.slice(msg.rev - this.historyBase);

    // ---- the entire algorithm -------------------------------------------
    // Rebase the client's op over every revision it had not seen. The client
    // is always argument `a`, on the server and on every client, so the
    // insert tie-break resolves identically everywhere. That consistency is
    // what server authority actually buys.
    for (const other of concurrent) {
      [op] = RichTextOperation.transform(op, other);
    }
    this.doc = op.apply(this.doc);
    // ----------------------------------------------------------------------

    // The transformed op is what actually landed, so authorship is walked
    // against THAT rather than against what the client sent. Using the
    // untransformed op would attribute at the indices the sender believed in,
    // which are exactly the indices concurrency just invalidated.
    this.authors = applyAuthorship(this.authors, op, clientId);

    this.history.push(op);
    this.rev++;

    // Anchors move with the text. This fires AFTER the op is sequenced, so
    // the transformation happens exactly once, in revision order, on the one
    // machine that decides what revision order is (ADR-012).
    this.onSequenced?.(op);

    this.recordTransform(clientId, msg.rev, concurrent.length, op);
    // `by` is new as of ADR-018, and it is the reason OT authorship survives a
    // restart at all. The log recorded what changed and never who; replaying
    // it could rebuild the text perfectly and had no way to rebuild this.
    this.persistUpdate(new TextEncoder().encode(
      JSON.stringify({ rev: this.rev, ops: op.toJSON(), by: clientId })));

    return {
      // The sender already applied its own edit locally; it needs only the
      // revision number the server assigned.
      toSender: [frame({ t: OT_ACK, rev: this.rev })],
      // Everyone else gets the transformed op, ready to apply as-is.
      toOthers: [frame({ t: OT_APPLY, rev: this.rev, ops: op.toJSON(), by: clientId })],
    };
  }

  recordTransform(clientId, baseRev, transformedAgainst, result) {
    this.transformLog.push({
      rev: this.rev, by: clientId, baseRev, transformedAgainst,
      op: result.toString(), at: Date.now(),
    });
    if (this.transformLog.length > 100) this.transformLog.shift();
  }

  /** OT anchors are indices, so the server is the only safe place to move them. */
  get ownsAnchors() {
    return true;
  }

  transformRange(range, op) {
    return RichTextOperation.transformRange(op, range);
  }

  /**
   * Bring a range from the revision a client computed it at up to ours.
   *
   * A client selects some text and opens a comment on it. By the time that
   * HTTP request lands, other people's keystrokes may already have been
   * sequenced -- so the indices in the request describe a document that no
   * longer exists. Replaying them through the operations they missed is the
   * same catch-up the engine does for a late-arriving op, applied to a range.
   *
   * Returns null when the range cannot be caught up: either it was deleted on
   * the way, or the client is older than the history we still hold, in which
   * case we genuinely do not know where it belongs and must not guess.
   *
   * @param {{from: number, to: number}} range
   * @param {number} fromRev
   * @returns {{from: number, to: number}|null}
   */
  catchUpRange(range, fromRev) {
    if (!Number.isInteger(fromRev) || fromRev > this.rev) return null;
    if (fromRev < this.historyBase) return null;
    let out = range;
    for (const op of this.history.slice(fromRev - this.historyBase)) {
      out = RichTextOperation.transformRange(op, out);
      if (!out) return null;
    }
    return out;
  }

  readDocument() {
    return this.doc;
  }

  /**
   * A restore is just another revision. It goes through the same history and
   * gets the same ack-free APPLY every other server-side transform produces,
   * so a client that was mid-edit rebases over it exactly as it would over a
   * peer's typing.
   */
  replaceWith(doc, authorId) {
    const op = new RichTextOperation().delete(this.doc.length);
    for (const run of doc.runs) op.insert(run.text, run.attributes);
    if (op.isNoop() && this.doc.length === 0) return { toOthers: [] };

    this.doc = op.apply(this.doc);
    // A restore deletes the document and inserts it again, so every character
    // in the result is genuinely new and is attributed to whoever restored it.
    // That is not a rounding error in the bookkeeping -- it is what a restore
    // IS here (ADR-008): an ordinary edit that replaces the text, not a rewind
    // of the log. The CRDT reaches the same answer by the same route, because
    // its replaceWith also inserts fresh items.
    this.authors = applyAuthorship(this.authors, op, authorId ?? 'server');
    this.history.push(op);
    this.rev++;
    // A restore replaces the whole document, so every anchor in it is about
    // to be orphaned. That is the honest outcome: the text a comment was
    // written about is not there any more, even though text very like it is.
    this.onSequenced?.(op);
    this.recordTransform(authorId ?? 'server', this.rev - 1, 0, op);
    this.persistUpdate(new TextEncoder().encode(
      JSON.stringify({ rev: this.rev, ops: op.toJSON(), by: authorId ?? 'server' })));

    return {
      toOthers: [frame({
        t: OT_APPLY, rev: this.rev, ops: op.toJSON(), by: authorId ?? 'server',
      })],
    };
  }

  snapshot() {
    // Authors travel with the snapshot, run-length encoded. Compaction deletes
    // the log entries it folds in (ADR-003), so anything not carried here is
    // destroyed by the next compaction rather than merely forgotten.
    return new TextEncoder().encode(JSON.stringify({
      runs: this.doc.toJSON(), rev: this.rev, authors: encodeAuthors(this.authors),
    }));
  }

  /**
   * Who wrote each character (ADR-018).
   *
   * Note how much more there is of this than the CRDT's version, and that
   * every line of the difference is state this engine had to be taught to
   * keep. That asymmetry is the finding, not an implementation detail.
   */
  readAuthorship() {
    return { runs: encodeAuthors(this.authors), identities: Object.fromEntries(this.identityMap) };
  }

  /** Told by the transport when somebody announces themselves. */
  noteIdentity(clientId, name, color) {
    this.identityMap.set(String(clientId), { name: String(name ?? ''), color: String(color ?? '') });
  }

  inspect() {
    return {
      engine: 'ot',
      rev: this.rev,
      historyBase: this.historyBase,
      historyDepth: this.history.length,
      length: this.doc.length,
      runs: this.doc.runs.length,
      preview: this.doc.toString().slice(0, 120),
      recentTransforms: this.transformLog.slice(-10),
    };
  }
}
