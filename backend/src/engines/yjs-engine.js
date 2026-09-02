/**
 * CRDT engine. Mostly a relay -- and that is the honest point of choosing a
 * CRDT: the server does not need to understand or order the edits, so it can
 * be dumb, stateless-ish and horizontally scalable. (The price is paid in the
 * client-side data structure: tombstones, larger metadata, no central truth.)
 *
 * The server DOES keep a Y.Doc even though it does not have to merge anything,
 * for three reasons:
 *   1. to answer SYNC_STEP1 with a minimal delta instead of the whole doc,
 *   2. to produce compacted snapshots,
 *   3. so a late joiner does not have to replay the entire update log.
 */
import * as Y from 'yjs';
import { RichText } from '@collab/ot';
import { MSG_ENGINE, encode, decode } from '@collab/protocol';
import {
  Y_SYNC_STEP1, Y_SYNC_STEP2, Y_UPDATE, encodeYjs, decodeYjs,
} from '@collab/protocol/yjs-wire';
import { DocEngine } from './doc-engine.js';

const frame = (subtype, bytes) => encode(MSG_ENGINE, encodeYjs(subtype, bytes));

export class YjsEngine extends DocEngine {
  /**
   * @param {string} docId
   * @param {(bytes: Uint8Array) => void} persistUpdate called for every update
   *   that changed our state; the transport decides where it goes.
   */
  constructor(docId, persistUpdate) {
    super(docId);
    this.doc = new Y.Doc();
    this.persistUpdate = persistUpdate;
    /** Set while applying persisted history, so we do not re-persist it. */
    this.replaying = false;

    this.doc.on('update', (update, origin) => {
      if (this.replaying) return;
      this.persistUpdate(update);
    });
  }

  /** Rehydrate from a snapshot + the loose update log. */
  restore({ snapshot, updates }) {
    this.replaying = true;
    try {
      Y.transact(this.doc, () => {
        if (snapshot) Y.applyUpdate(this.doc, snapshot, 'restore');
        for (const u of updates) Y.applyUpdate(this.doc, u, 'restore');
      });
    } finally {
      this.replaying = false;
    }
  }

  onClientJoin() {
    // Nothing to push. The client opens with a STEP1, and the handler for that
    // performs the whole two-way exchange -- so connect and resync go through
    // exactly one code path instead of two that can drift apart.
    //
    // We never dump the document here in any case: we ask what the client
    // already has and send only the difference.
    return [];
  }

  handleMessage(clientId, payload, { canEdit = true } = {}) {
    const { subtype, bytes } = decodeYjs(payload);

    switch (subtype) {
      case Y_SYNC_STEP1: {
        // A STEP1 always begets a full TWO-WAY exchange:
        //   STEP2  what the client is missing (computed from its state vector)
        //   STEP1  our own state vector, so the client replies with what WE
        //          are missing
        //
        // The second frame is not redundant, and leaving it out was a real bug.
        // Reconnecting clients were covered by chance, because the server
        // pushed its own STEP1 on join -- but a client healing from a
        // black-hole partition never rejoins, so nothing ever asked it for the
        // edits it made while cut off. They were stranded on that replica
        // forever, and the divergence was silent.
        //
        // Making the exchange symmetric here means one code path serves both
        // connect and anti-entropy.
        const diff = Y.encodeStateAsUpdate(this.doc, bytes);
        return {
          toSender: [
            frame(Y_SYNC_STEP2, diff),
            frame(Y_SYNC_STEP1, Y.encodeStateVector(this.doc)),
          ],
        };
      }

      case Y_SYNC_STEP2:
      case Y_UPDATE: {
        // A viewer may ask what the document says (STEP1, above) but may not
        // contribute to it. Dropping the frame leaves their own replica ahead
        // of ours until they reload, which is the honest limit of a CRDT here:
        // there is no "reject" to send back, only a refusal to integrate.
        if (!canEdit) return {};

        // Capture whatever our own document integrates, and fan exactly that
        // out. Nothing is forwarded that we did not apply ourselves, so the
        // payload is still normalised and a misbehaving client still cannot
        // inject bytes we never saw.
        //
        // Every applied update is fanned out. Comparing state vectors before
        // and after, and skipping the broadcast when they match, is the
        // tempting optimisation here and it is wrong -- silently, and only
        // for deletion.
        //
        // A Yjs deletion does not create an item. It marks existing items
        // deleted and records that in the DELETE SET, which the state vector
        // does not describe at all -- the vector counts how many items each
        // client has produced, and deleting produces none. So an update
        // consisting only of deletions left the vector unchanged, looked
        // "entirely redundant", and was dropped. Deleting text never reached
        // the other clients in the room. It healed on the next reconnect,
        // because the STEP1/STEP2 exchange sends a full update which does
        // carry the delete set, which is exactly why this survived: the
        // checklist reconnects, and nothing in it ever deleted anything while
        // two clients were watching.
        //
        // Formatting is what surfaced it. Yjs cleans up redundant format
        // markers by deleting them, so concurrent bold/un-bold produces
        // deletion-only updates constantly, and two replicas settled on the
        // same text with different marks -- see ADR-006 on why that is the
        // worst shape of divergence.
        const produced = [];
        const capture = (update) => produced.push(update);
        this.doc.on('update', capture);
        try {
          Y.applyUpdate(this.doc, bytes, clientId);
        } finally {
          this.doc.off('update', capture);
        }

        // Genuinely redundant -- a reconnect echoing back what we already
        // have. Yjs emits nothing, so neither do we.
        if (produced.length === 0) return {};

        const delta = produced.length === 1 ? produced[0] : Y.mergeUpdates(produced);
        return { toOthers: [frame(Y_UPDATE, delta)] };
      }

      default:
        throw new Error(`unknown yjs subtype ${subtype}`);
    }
  }

  readDocument() {
    const doc = new RichText();
    for (const part of this.doc.getText('content').toDelta()) {
      if (typeof part.insert === 'string') doc.push(part.insert, part.attributes);
    }
    return doc;
  }

  /**
   * Who wrote each character (ADR-018) -- read straight out of the CRDT.
   *
   * A Y.Text is a doubly-linked list of items, and every item carries the id
   * of the client that inserted it. Nothing here is bookkeeping added for this
   * feature: those ids are the CRDT's ORDERING mechanism. Two concurrent
   * inserts at the same index are placed deterministically by comparing client
   * ids, which is exactly why a CRDT needs no server to converge. Attribution
   * is the same fact read for a different purpose.
   *
   * Which is why this works on documents written before the feature existed.
   * There was never a moment when the CRDT was not recording this.
   *
   * Two kinds of item are skipped, and both were bugs before they were
   * comments:
   *
   *   deleted     a tombstone occupies no position in the text a reader sees.
   *               Counting them slides every later run off by the length of
   *               everything anyone ever erased.
   *   !countable  formatting. Bolding a range inserts ContentFormat items into
   *               this same list, and they have a length that does not count
   *               toward the text. Counting them attributes the bolded range
   *               to whoever bolded it and shifts everything after it -- which
   *               is exactly the "formatting is not authorship" rule, enforced
   *               here rather than stated.
   *
   * Items are walked rather than using `toDelta()`, which merges adjacent runs
   * and drops the ids in the process -- it answers "what does this say", and
   * the question here is "who said it".
   */
  readAuthorship() {
    const runs = [];
    for (let item = this.doc.getText('content')._start; item; item = item.right) {
      if (item.deleted || !item.countable || !item.length) continue;
      const author = String(item.id.client);
      const last = runs[runs.length - 1];
      // Coalesce: one person typing a sentence is many items and one run.
      if (last && last.author === author) last.length += item.length;
      else runs.push({ author, length: item.length });
    }
    return { runs, identities: this.identities() };
  }

  /**
   * Yjs client number -> a name and a colour.
   *
   * The one piece of this that is NOT free. A Yjs client id is a random
   * integer minted per Y.Doc; it orders characters perfectly and means nothing
   * to a reader. So clients write themselves into a shared Y.Map as they
   * connect, and that map is part of the document -- it merges, persists and
   * survives a restart exactly like the text does, which is the cheapest
   * possible place to put it.
   *
   * A client id with no entry is not an error. It is someone who edited before
   * this map existed, or a harness that never announced itself, and the reader
   * is shown an unattributed run rather than a fabricated name.
   */
  identities() {
    const out = {};
    for (const [client, who] of this.doc.getMap('authors').entries()) {
      if (!who || typeof who !== 'object') continue;
      out[String(client)] = { name: String(who.name ?? ''), color: String(who.color ?? '') };
    }
    return out;
  }

  /**
   * Replace the text in one transaction and fan out whatever Yjs produced.
   *
   * Note this leaves the old characters in the replica as tombstones rather
   * than erasing them, which is what makes the restore itself mergeable with
   * a peer's concurrent typing instead of clobbering it.
   */
  replaceWith(doc, authorId) {
    const ytext = this.doc.getText('content');
    const produced = [];
    const capture = (update) => produced.push(update);
    this.doc.on('update', capture);
    try {
      this.doc.transact(() => {
        ytext.delete(0, ytext.length);
        let at = 0;
        for (const run of doc.runs) {
          ytext.insert(at, run.text, run.attributes);
          at += run.text.length;
        }
      }, authorId ?? 'restore');
    } finally {
      this.doc.off('update', capture);
    }
    if (produced.length === 0) return { toOthers: [] };
    const delta = produced.length === 1 ? produced[0] : Y.mergeUpdates(produced);
    return { toOthers: [frame(Y_UPDATE, delta)] };
  }

  snapshot() {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /**
   * Yes: Yjs updates merge, and applying one twice is a no-op.
   *
   * Both halves matter. Merging is what turns a window of edits into one
   * frame; idempotence is what makes it safe to send that frame to EVERYONE
   * rather than computing a different one per recipient to exclude each
   * sender's own bytes. The fan-out goes from one frame per client to one
   * frame, full stop.
   */
  get coalescible() {
    return true;
  }

  /**
   * Merge adjacent runs of Y_UPDATE into a single update.
   *
   * Runs, not the whole array: a STEP1 or STEP2 in the middle is part of a
   * handshake with a specific client and reordering it across updates would
   * change what that client is told. In practice a batch is almost always
   * updates end to end, and the loop costs nothing when it is.
   */
  coalesce(frames) {
    if (frames.length < 2) return frames;

    const out = [];
    let run = [];

    const flushRun = () => {
      if (!run.length) return;
      // One update needs no merging, and Y.mergeUpdates on a single element
      // still re-encodes it.
      out.push(run.length === 1 ? run[0] : frame(Y_UPDATE, Y.mergeUpdates(run)));
      run = [];
    };

    for (const f of frames) {
      let update = null;
      try {
        // A frame we cannot read is not one we may merge. Falling through to
        // "pass it along untouched" is the only safe failure here.
        const { type, payload } = decode(f);
        if (type === MSG_ENGINE) {
          const { subtype, bytes } = decodeYjs(payload);
          if (subtype === Y_UPDATE) update = bytes;
        }
      } catch { update = null; }

      if (update) run.push(update);
      else { flushRun(); out.push(f); }
    }
    flushRun();

    return out;
  }

  inspect() {
    const text = this.doc.getText('content');
    return {
      engine: 'yjs',
      length: text.length,
      preview: text.toString().slice(0, 120),
      stateVectorBytes: Y.encodeStateVector(this.doc).length,
      snapshotBytes: Y.encodeStateAsUpdate(this.doc).length,
      clients: this.doc.store.clients.size,
    };
  }

  destroy() {
    this.doc.destroy();
  }
}
