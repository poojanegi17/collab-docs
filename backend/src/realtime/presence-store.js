/**
 * Ephemeral presence: who is here, where their cursor is, what they selected.
 *
 * Three deliberate design choices, each of which is a talking point:
 *
 *  1. NOT persisted. A cursor position is meaningless after you disconnect,
 *     and writing it to storage would put a keystroke-rate write load on the
 *     database for data with a lifetime of milliseconds. This was true when
 *     storage was a local file and it is emphatically truer now that it is a
 *     network round trip -- presence is the one thing in this system that
 *     must NOT go to Postgres.
 *  2. NOT engine-owned. Cursors must behave identically under CRDT and OT, so
 *     presence lives in transport, above the engine seam.
 *  3. Last-write-wins per client, no merging. Presence is a cache of the most
 *     recent truth; a lost update is corrected by the next one ~50ms later.
 *     This is the cheapest correct thing, and "correct" here is weak on
 *     purpose.
 *
 * WHY THIS IS AN INTERFACE
 *
 * Point 1 is exactly the description of something that belongs in Redis: high
 * write rate, no durability requirement, and -- the part that matters -- it
 * has to be visible to every process serving the same document. The in-memory
 * implementation below is correct on one instance and silently wrong on two:
 * each process would know only about its own clients, so a document open on
 * two instances would show each person half the cursors.
 *
 * A Redis implementation is a hash per room (`presence:<docId>`) with a field
 * per client and a TTL doing the work `reap` does here. It is a drop-in
 * replacement for this class because everything below is expressed in terms of
 * that shape and nothing else. Note that `reap` becomes largely redundant
 * under Redis -- key expiry is the same idea implemented by the server -- but
 * it stays on the interface because the caller should not have to know which
 * implementation is underneath.
 *
 * The methods are async, which the in-memory version does not need. That is
 * the point: writing them sync now would mean rewriting every caller the day
 * presence moves to Redis, which is precisely the rewrite this exists to
 * prevent.
 */

/** The contract. See the header for what a Redis implementation looks like. */
export class PresenceStore {
  // eslint-disable-next-line no-unused-vars
  async set(clientId, state) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async remove(clientId) { throw new Error('not implemented'); }
  /** @returns {Promise<string[]>} client ids that timed out */
  async reap() { throw new Error('not implemented'); }
  /** @returns {Promise<Record<string, any>>} everyone except `exceptId` */
  // eslint-disable-next-line no-unused-vars
  async snapshot(exceptId) { throw new Error('not implemented'); }
  async close() {}
}

/**
 * One process, one Map. The default, and correct for a single instance.
 */
export class PresenceRoom extends PresenceStore {
  constructor(timeoutMs) {
    super();
    this.timeoutMs = timeoutMs;
    /** @type {Map<string, { state: any, updated: number }>} */
    this.states = new Map();
  }

  async set(clientId, state) {
    this.states.set(clientId, { state, updated: Date.now() });
  }

  async remove(clientId) {
    this.states.delete(clientId);
  }

  /** Reap clients we have not heard from. Called on a timer by the room. */
  async reap() {
    const cutoff = Date.now() - this.timeoutMs;
    const dropped = [];
    for (const [id, entry] of this.states) {
      if (entry.updated < cutoff) {
        this.states.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  /** Everyone except `exceptId` -- used to seed a client that just joined. */
  async snapshot(exceptId) {
    const out = {};
    for (const [id, entry] of this.states) {
      if (id !== exceptId) out[id] = entry.state;
    }
    return out;
  }

  async close() {
    this.states.clear();
  }
}
