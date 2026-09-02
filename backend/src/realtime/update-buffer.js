/**
 * Bounded write buffering for the append-only update log.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The room calls `Store.appendUpdate` once per engine update -- which in
 * practice means once per keystroke -- and that call is an INSERT over a
 * network to Neon. In the same region that is a millisecond or two;
 * cross-region it is tens of milliseconds. Either way it is not free, and it
 * sits on the path between a keystroke arriving and the room acknowledging
 * it.
 *
 * So appends are accumulated and written in batches. One multi-row INSERT for
 * twenty keystrokes costs one round trip instead of twenty.
 *
 * WHAT THIS COSTS, STATED PLAINLY
 *
 * A crash loses whatever is still in the buffer -- at most `windowMs` of
 * edits, where a write-through store would have lost nothing. This is a REAL
 * reduction in durability, and the only place in this codebase where a
 * guarantee is traded for latency.
 *
 * Three things make it an acceptable trade rather than a silent regression:
 *
 *   1. It is bounded and configurable. `persistWindowMs = 0` restores exact
 *      write-through behaviour, and the harnesses that assert on durability
 *      set precisely that.
 *   2. The clients have not lost the data. Every connected replica still
 *      holds the CRDT state; a client that reconnects after a server crash
 *      sends what the server is missing, and the log heals. The window is a
 *      window of *server-side* loss, not of user-visible loss, unless every
 *      client disconnects in the same instant.
 *   3. The alternative was worse. Without batching, a document being typed
 *      into by five people generates five round trips per keystroke.
 *
 * WHERE REDIS COMES IN
 *
 * This is the seam the brief asked for. A Redis-backed implementation would
 * push each update onto a per-document LIST or STREAM instead of an array in
 * this process, and a drainer would move batches from there into Postgres.
 * That closes point 1 above -- the buffer survives the process -- and lets a
 * document's writes be drained by whichever instance is up, rather than only
 * by the one that accepted them.
 *
 * It does NOT make Redis the source of truth. The invariant is one line: an
 * update is durable when Postgres has it, and everything before that is a
 * queue. `flush()` is what closes the gap, and every read path that could
 * observe the log calls it first -- see BufferedStore below, which is what
 * makes that impossible to forget.
 */

/**
 * Accumulates appends per document and writes them in batches.
 *
 * Not exported for direct use by rooms: use `BufferedStore`, which wires the
 * flush-before-read rule that makes this safe.
 *
 * THREE INVARIANTS, AND WHY EACH NEEDS CODE
 *
 * 1. `flush(docId)` returns only when everything queued AT THE MOMENT IT WAS
 *    CALLED is in Postgres. The obvious implementation -- "drain the queue,
 *    await the write" -- is wrong when two callers overlap: the second finds
 *    the queue already emptied by the first and returns having awaited
 *    nothing. Every row therefore carries its own `durable` promise, and
 *    flush awaits exactly the rows it found rather than "the queue".
 *
 * 2. A batch that fails is RETRIED, not stranded. The rows go back on the
 *    FRONT of the queue -- ahead of anything appended meanwhile, so the log
 *    stays ordered -- and a timer re-arms. Only when the retries are
 *    exhausted are the rows dropped and their `durable` promises rejected,
 *    and that rejection is the signal the room acts on. Nothing is ever
 *    quietly lost.
 *
 * 3. `runExclusive(docId, fn)` gives compaction a point where the queue is
 *    empty, nothing is in flight, and the highest written seq is known. New
 *    appends are held aside for the duration rather than queued, so the drain
 *    terminates even while somebody is typing -- chasing a queue that refills
 *    as fast as it empties would starve compaction forever.
 */
export class UpdateBuffer {
  /**
   * @param {object} opts
   * @param {{appendUpdates: Function}} opts.store the store to write through to
   * @param {number} opts.windowMs how long to accumulate before writing
   * @param {number} [opts.maxBatch] write immediately once this many are queued
   * @param {number} [opts.maxAttempts] tries per batch before abandoning it
   * @param {Function} [opts.onFailure] called as (docId, err) when a batch is
   *   abandoned. The room uses this to stop pretending the document is saved.
   */
  constructor({ store, windowMs, maxBatch = 256, maxAttempts = 4, onFailure = null }) {
    this.store = store;
    this.windowMs = Math.max(0, Number(windowMs) || 0);
    this.maxBatch = maxBatch;
    this.maxAttempts = maxAttempts;
    this.onFailure = onFailure;
    this.queues = new Map();
  }

  #queue(docId) {
    let q = this.queues.get(docId);
    if (!q) {
      q = {
        rows: [],        // queued, not yet handed to Postgres
        held: null,      // appended while an exclusive section held the doc
        sending: null,   // the rows currently in flight, or null
        inflight: null,  // promise for the batch in flight, or null
        timer: null,
        exclusive: null, // held while runExclusive owns this document
        lastSeq: 0,      // highest seq Postgres has confirmed for this document
        attempt: 0,
      };
      this.queues.set(docId, q);
    }
    return q;
  }

  /** Forget a document with nothing outstanding. */
  #reap(docId, q) {
    if (!q.rows.length && !q.held?.length && !q.inflight && !q.timer && !q.exclusive) {
      this.queues.delete(docId);
    }
  }

  /**
   * Queue one update. Returns a promise that settles when Postgres has it:
   * resolving with the row's `seq`, or rejecting if the batch was abandoned.
   *
   * The promise is pre-handled so a caller who does not await it cannot turn
   * a write failure into an unhandled rejection. Attaching a handler here
   * does not stop an explicit awaiter from seeing the error; it only stops
   * Node from treating the rejection as nobody's problem.
   */
  append(docId, bytes) {
    const q = this.#queue(docId);
    const row = { bytes, created: Date.now() };
    row.durable = new Promise((resolve, reject) => {
      row.resolve = resolve;
      row.reject = reject;
    });
    row.durable.catch(() => { /* see above */ });

    // While an exclusive section holds this document, new appends are HELD
    // rather than queued. Without that, `runExclusive` drains a queue that is
    // being refilled as fast as it empties and never reaches its callback --
    // a document somebody is continuously typing into would never compact.
    // The hot path is still never blocked: this is a push onto an array, and
    // the held rows are queued the moment the section ends.
    if (q.exclusive) {
      (q.held ??= []).push(row);
      return row.durable;
    }

    q.rows.push(row);
    if (this.windowMs === 0 || q.rows.length >= this.maxBatch) this.#pump(docId);
    else this.#arm(docId, this.windowMs);

    return row.durable;
  }

  /**
   * Arm the write timer.
   *
   * Deliberately NOT `unref`'d. An unwritten update is outstanding work, and
   * an unref'd timer does not hold the process open -- so a process that
   * finished everything else would exit with the window still pending and
   * those updates never written at all. The cost of refing is that the loop
   * stays alive for `windowMs`, which is 25ms; the cost of not refing is
   * silent data loss.
   */
  #arm(docId, ms) {
    const q = this.#queue(docId);
    if (q.timer) return;
    q.timer = setTimeout(() => {
      q.timer = null;
      // Forced. The only holder of an exclusive section that can ALSO have
      // rows queued is the drain inside `runExclusive`, and that drain is
      // blocked waiting for exactly these rows -- so declining here would
      // deadlock it whenever a batch failed mid-drain and re-armed. Once the
      // drain is past and `fn` is running, `q.rows` is empty (appends are
      // diverted to `q.held`), so forcing has nothing to act on.
      this.#pump(docId, { force: true });
    }, ms);
  }

  /**
   * Start a batch if one can start.
   *
   * Synchronous by contract, and never throws: failure is reported through
   * the rows' `durable` promises and through `onFailure`.
   */
  #pump(docId, { force = false } = {}) {
    const q = this.queues.get(docId);
    if (!q || q.inflight || !q.rows.length) return;
    // An exclusive section drains through `force`; nothing else may start a
    // batch while it holds the document.
    if (q.exclusive && !force) return;

    const batch = q.rows;
    q.rows = [];
    q.sending = batch;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }

    q.inflight = (async () => {
      try {
        const seqs = await this.store.appendUpdates(docId, batch.map((r) => ({
          bytes: r.bytes, created: r.created,
        })));
        q.attempt = 0;
        for (let i = 0; i < batch.length; i++) {
          const seq = Number(seqs?.[i] ?? 0);
          if (seq > q.lastSeq) q.lastSeq = seq;
          batch[i].resolve(seq);
        }
      } catch (err) {
        q.attempt++;
        if (q.attempt < this.maxAttempts) {
          q.rows.unshift(...batch);
          this.#arm(docId, Math.min(1000, 25 * 2 ** q.attempt));
        } else {
          q.attempt = 0;
          for (const r of batch) r.reject(err);
          try { this.onFailure?.(docId, err); } catch { /* never our problem */ }
        }
      } finally {
        q.sending = null;
        q.inflight = null;
      }
    })();

    // Chain the next batch if a retry, or an append that landed mid-flight,
    // left work behind. Scheduled rather than awaited: #pump is synchronous.
    void q.inflight.then(() => {
      const still = this.queues.get(docId);
      if (!still) return;
      if (still.rows.length && !still.timer) this.#pump(docId);
      else this.#reap(docId, still);
    });
  }

  /** How many appends are queued or in flight but not yet in Postgres. */
  pending(docId) {
    const outstanding = (q) => q.rows.length + (q.sending?.length ?? 0) + (q.held?.length ?? 0);
    if (docId === undefined) {
      return [...this.queues.values()].reduce((n, q) => n + outstanding(q), 0);
    }
    const q = this.queues.get(docId);
    return q ? outstanding(q) : 0;
  }

  /**
   * Wait until every append made before this call is in Postgres.
   *
   * Awaits those rows specifically, so two overlapping callers cannot each
   * mistake the other's progress for their own. Rejects if any of the rows
   * it was waiting on was ultimately abandoned.
   */
  async flush(docId) {
    const q = this.queues.get(docId);
    if (!q) return;

    // `held` too: those are appends made while an exclusive section had the
    // document, and they are written the moment it ends.
    const waitFor = [...(q.sending ?? []), ...q.rows, ...(q.held ?? [])].map((r) => r.durable);
    if (!waitFor.length) { this.#reap(docId, q); return; }

    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    this.#pump(docId);
    await Promise.all(waitFor);
  }

  async flushAll() {
    // Re-check between rounds: flushing one document can leave another with
    // work if a retry re-queued it.
    for (let round = 0; round < 8; round++) {
      const ids = [...this.queues.keys()];
      if (!ids.length) return;
      await Promise.all(ids.map((id) => this.flush(id).catch(() => {})));
      const busy = [...this.queues.values()].some(
        (q) => q.rows.length || q.inflight || q.held?.length);
      if (!busy) return;
    }
  }

  /**
   * Run `fn` at a point where this document has nothing outstanding.
   *
   * `fn` receives `{ lastSeq }` -- the highest seq Postgres holds for this
   * document -- and is called with NO `await` between the check that the
   * queue is empty and the call itself. That matters more than it looks.
   * Engine updates reach this buffer from a socket 'message' handler, which
   * is a macrotask, and Node runs every pending microtask before the next
   * macrotask. So a caller whose first statement is `engine.snapshot()` is
   * guaranteed no further update was applied to the engine between `lastSeq`
   * being read and that snapshot being taken.
   *
   * That is the whole basis of compaction being safe: the snapshot and the
   * seq describe the same instant, so the updates at or below `lastSeq` are
   * exactly the ones the snapshot already contains, and are exactly the ones
   * that may be archived away.
   *
   * Appends are never blocked -- they queue as usual and are written after.
   */
  async runExclusive(docId, fn) {
    // Re-fetched after each wait, not captured once. Releasing an exclusive
    // section reaps the queue if nothing is outstanding, so a second caller
    // that captured the object up front would wake holding an orphan --
    // guarding a record no longer in the map, while appends went to a fresh
    // one it would never drain.
    let q = this.#queue(docId);
    while (q.exclusive) { await q.exclusive; q = this.#queue(docId); }

    let release;
    q.exclusive = new Promise((resolve) => { release = resolve; });
    try {
      // Terminates because `append` diverts new rows to `q.held` while this
      // section is open, so `q.rows` only ever shrinks from here.
      for (;;) {
        if (q.inflight) { await q.inflight; continue; }
        if (q.rows.length) {
          if (q.timer) { clearTimeout(q.timer); q.timer = null; }
          const waitFor = q.rows.map((r) => r.durable);
          this.#pump(docId, { force: true });
          await Promise.all(waitFor);
          continue;
        }
        // Drained. Nothing between here and fn() may await.
        return await fn({ lastSeq: q.lastSeq });
      }
    } finally {
      q.exclusive = null;
      // Everything that arrived while the section was open, in arrival order
      // and behind anything still queued.
      if (q.held?.length) { q.rows.push(...q.held); q.held = null; }
      release();
      if (q.rows.length) this.#arm(docId, this.windowMs);
      this.#pump(docId);
      this.#reap(docId, q);
    }
  }
}

/**
 * A Store with buffered appends and the flush-before-read rule applied.
 *
 * Everything not listed here is delegated untouched, so this is a Store as far
 * as every caller is concerned. What it adds is the invariant that makes
 * buffering safe: any method that can OBSERVE the update log flushes that
 * document first. Without it, `load()` during a burst of typing would return a
 * document missing its last few keystrokes -- which would look exactly like
 * data loss, because for the purposes of that read it is.
 *
 * The list of read methods below is therefore not a convenience. Adding a new
 * method to Store that reads `updates`, `archive` or `snapshots` and not
 * adding it here is a correctness bug, which is why they are named in one
 * place with this comment over them.
 */
export class BufferedStore {
  /**
   * @param {import('../storage/store.js').Store} store
   * @param {{windowMs: number, maxBatch?: number, maxAttempts?: number,
   *          onFailure?: Function}} opts
   */
  constructor(store, { windowMs, maxBatch, maxAttempts, onFailure } = {}) {
    this.store = store;
    this.buffer = new UpdateBuffer({ store, windowMs, maxBatch, maxAttempts, onFailure });

    // Delegate every method the Store has that this class does not override.
    // Done reflectively rather than by writing sixty forwarding methods,
    // because a hand-written list would fall out of date the first time
    // somebody added a method to Store and did not think about this file.
    const own = new Set(Object.getOwnPropertyNames(BufferedStore.prototype));
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(store))) {
      if (name === 'constructor' || own.has(name)) continue;
      if (typeof store[name] !== 'function') continue;
      this[name] = (...args) => store[name](...args);
    }
    // Not a method, and `purgeDoc` and friends reach for it.
    this.db = store.db;
  }

  // `Store.tabOf` and `Store.ROLES` are statics and are called as such, on the
  // imported class rather than through an instance, so there is nothing to
  // forward here. Adding a forwarding static would only create a second name
  // for the same function and an opportunity for the two to disagree.

  // ---- the buffered write --------------------------------------------------

  /**
   * Returns a promise that resolves on durability. The room does not await it
   * on the keystroke path -- that is the entire point -- but it is awaitable,
   * so nothing is prevented from caring.
   */
  appendUpdate(docId, bytes) {
    return this.buffer.append(docId, bytes);
  }

  // ---- reads that must not miss a buffered write ---------------------------

  async load(docId) {
    await this.buffer.flush(docId);
    return this.store.load(docId);
  }

  async looseUpdateCount(docId) {
    await this.buffer.flush(docId);
    return this.store.looseUpdateCount(docId);
  }

  async currentSeq(docId) {
    await this.buffer.flush(docId);
    return this.store.currentSeq(docId);
  }

  async compact(docId, snapshotBytes, throughSeq) {
    await this.buffer.flush(docId);
    return this.store.compact(docId, snapshotBytes, throughSeq);
  }

  /**
   * Compact without ever pairing a snapshot with the wrong sequence number.
   *
   * `makeSnapshot()` is called synchronously at a point where this document
   * has nothing queued and nothing in flight, and is handed the seq that
   * Postgres has actually confirmed. Callers must not do the obvious thing:
   *
   *   store.compact(docId, engine.snapshot(), await store.currentSeq(docId))
   *
   * Arguments evaluate left to right, so that takes the snapshot BEFORE the
   * round trip that reads the seq, and any edit landing during the trip is
   * counted by `throughSeq` while being absent from the snapshot -- and
   * compaction deletes exactly the updates at or below `throughSeq`. That is
   * a lost keystroke, through a gap a full network round trip wide.
   *
   * @param {string} docId
   * @param {() => Uint8Array} makeSnapshot must be synchronous
   */
  async compactAtomically(docId, makeSnapshot) {
    return this.buffer.runExclusive(docId, async ({ lastSeq }) => {
      const snapshot = makeSnapshot();   // same instant as lastSeq: see runExclusive
      // A room restored from a previous process has written nothing itself,
      // so `lastSeq` is 0 while Postgres holds a long log. Reading the seq
      // here is safe where the naive version was not: the exclusive section
      // blocks every write, so nothing can be appended during the round trip
      // and the snapshot taken above still describes exactly this seq.
      const throughSeq = lastSeq || await this.store.currentSeq(docId);
      if (!throughSeq) return { compacted: false, throughSeq: 0 };
      await this.store.compact(docId, snapshot, throughSeq);
      return { compacted: true, throughSeq };
    });
  }

  async fullLog(docId, fromSeq, toSeq) {
    await this.buffer.flush(docId);
    return this.store.fullLog(docId, fromSeq, toSeq);
  }

  async stateAt(docId, seq) {
    await this.buffer.flush(docId);
    return this.store.stateAt(docId, seq);
  }

  async activity(docId, limit) {
    await this.buffer.flush(docId);
    return this.store.activity(docId, limit);
  }

  async listDocs(limit) {
    // Aggregates over every document's log, so a per-document flush is not
    // enough -- the listing's byte counts and timestamps would lag whichever
    // documents happen to be mid-burst.
    await this.buffer.flushAll();
    return this.store.listDocs(limit);
  }

  async purgeDoc(docId) {
    // Flush first, or a queued append lands AFTER the delete and resurrects a
    // fragment of a document that was supposed to be gone.
    await this.buffer.flush(docId);
    return this.store.purgeDoc(docId);
  }

  async purgeEmptyUnowned(isBusy, minAgeMs) {
    await this.buffer.flushAll();
    return this.store.purgeEmptyUnowned(isBusy, minAgeMs);
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Everything queued reaches Postgres before the process is allowed to end. */
  async close() {
    await this.buffer.flushAll();
    return this.store.close();
  }
}
