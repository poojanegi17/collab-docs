/**
 * Which documents are live in this process, and their in-memory state.
 *
 * This was `const rooms = new Map()` inside `startServer`. It is a class with
 * an interface in front of it for the same reason presence is: it is EPHEMERAL
 * COORDINATION STATE, which is the category of thing that has to move out of
 * process memory the moment there is more than one process.
 *
 * WHAT IS AND IS NOT IN HERE
 *
 * A Room owns a live engine instance -- a Y.Doc or an OT server -- plus the
 * sockets attached to it. None of that is serialisable and none of it belongs
 * in Redis: you cannot put a WebSocket in a hash. So this registry stays
 * process-local by nature, and a Redis implementation would NOT replace it.
 *
 * What Redis adds instead is the thing this cannot answer on its own: WHICH
 * INSTANCES have a given document open. That is a set per document
 * (`room:<docId>:instances`) with a heartbeat TTL, and it is what lets an
 * instance decide whether it is alone with a document -- which matters for two
 * things this codebase already does and currently gets right only by being
 * single-process:
 *
 *   compaction   `maybeCompact` folds the log into a snapshot. Two instances
 *                compacting the same document concurrently is not corruption
 *                -- the transaction in `Store.compact` is atomic -- but it is
 *                duplicated work and a duplicated checkpoint row.
 *   sweeping     the empty-room reaper deletes unowned empty documents. An
 *                instance must not sweep a document another instance has open.
 *
 * Hence `claim` below. It is a no-op locally, and it is where a Redis
 * `SET NX PX` lock goes. Having the call site exist now means introducing the
 * lock later is a change to one file rather than a hunt through the server.
 */

/** The contract. See the header for what Redis adds and what it does not. */
export class RoomRegistry {
  // eslint-disable-next-line no-unused-vars
  get(docId) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  set(docId, room) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  delete(docId) { throw new Error('not implemented'); }
  values() { throw new Error('not implemented'); }
  get size() { throw new Error('not implemented'); }

  /**
   * Try to take a named, expiring lock for a document.
   *
   * @param {string} docId
   * @param {string} purpose  e.g. 'compact' or 'sweep'
   * @param {number} ttlMs
   * @returns {Promise<() => Promise<void>>|Promise<null>} release, or null if
   *   another instance holds it
   */
  // eslint-disable-next-line no-unused-vars
  async claim(docId, purpose, ttlMs) { throw new Error('not implemented'); }
}

/**
 * One process. A Map, plus a `claim` that always succeeds.
 *
 * `claim` returning a release function unconditionally is CORRECT here, not a
 * stub: with one process there is no other contender, so the lock is
 * uncontended by definition. The value of having it is that callers are
 * already written to handle being refused, so the Redis implementation does
 * not change their shape.
 */
export class InProcessRoomRegistry extends RoomRegistry {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.rooms = new Map();
    /** Held locks, so a re-entrant claim in the same process is refused too. */
    this.locks = new Map();
  }

  get(docId) { return this.rooms.get(docId); }
  set(docId, room) { this.rooms.set(docId, room); return room; }
  delete(docId) { return this.rooms.delete(docId); }
  values() { return this.rooms.values(); }
  keys() { return this.rooms.keys(); }
  entries() { return this.rooms.entries(); }
  get size() { return this.rooms.size; }

  /**
   * Iterable as `[docId, room]` pairs, exactly like the Map this replaced.
   *
   * `api.js`'s `familyRooms` does `for (const [id, room] of rooms)`, which is
   * the natural thing to write against a Map and threw `rooms is not iterable`
   * the moment this class took its place. Matching Map's iteration protocol is
   * cheaper than auditing every caller for the ways it might reasonably expect
   * a Map to behave -- and a Redis-backed registry still owns a local Map of
   * live rooms (see the header), so it can honour this too.
   */
  [Symbol.iterator]() { return this.rooms[Symbol.iterator](); }

  async claim(docId, purpose, ttlMs = 30_000) {
    const key = `${docId}:${purpose}`;
    const held = this.locks.get(key);
    // Even in one process a claim can overlap itself -- a compaction triggered
    // while the previous one is still awaiting Postgres. Refusing that is the
    // same answer Redis would give, and it is the answer that keeps the two
    // implementations behaving alike.
    if (held && held > Date.now()) return null;
    this.locks.set(key, Date.now() + ttlMs);
    return async () => { this.locks.delete(key); };
  }
}
