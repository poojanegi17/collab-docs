/**
 * Fan-out between processes, behind an interface with one implementation.
 *
 * WHY THIS EXISTS BEFORE THERE IS A SECOND PROCESS
 *
 * Today a room holds its clients' sockets in a Map and writes frames straight
 * into them. That is correct and fast for exactly as long as every client of a
 * document is connected to the SAME server process. The moment there are two
 * -- a second Render instance, a blue/green deploy overlapping, a local dev
 * server beside a deployed one -- two people editing the same document stop
 * seeing each other, and nothing errors: the document still converges through
 * storage, so the failure looks like "collaboration is slow" rather than
 * "collaboration is broken".
 *
 * The fix is a message bus, and the fix is Redis pub/sub. This interface is
 * the shape of that fix, introduced now, while there is one process and the
 * in-process implementation is provably equivalent to the direct call it
 * replaces. Adding it later would mean touching every broadcast site again.
 *
 * WHAT A REDIS IMPLEMENTATION MUST DO, AND WHAT IT MUST NOT
 *
 * Must: publish to `room:<docId>`, subscribe once per process per room, and
 * deliver to local sockets on receipt. Redis pub/sub is fire-and-forget, which
 * is the correct semantic HERE and only here -- a dropped presence frame is
 * corrected by the next one, and a dropped document update is recovered
 * because the receiving client's engine will ask for what it is missing.
 *
 * Must not: become the record of anything. Postgres is the source of truth for
 * every byte that matters (see ../storage/db.js). If a message on this bus is
 * the only place a piece of state exists, that state has been lost the moment
 * Redis restarts -- and Redis restarts.
 *
 * ORDERING. Neither implementation promises global ordering across topics. The
 * in-process one is ordered within a topic because it is a synchronous loop;
 * Redis is ordered per connection. Nothing in this codebase may depend on
 * more than per-topic ordering, because that is all the eventual
 * implementation can offer.
 */

/**
 * @typedef {(payload: any, meta: {topic: string}) => void} Handler
 */

/**
 * The contract. Documented as a class rather than a comment so an
 * implementation can `extends PubSub` and be checked against it.
 */
export class PubSub {
  /**
   * Send `payload` to every subscriber of `topic`, in this process and any
   * other. Never throws for "nobody is listening" -- an empty room is normal.
   * @param {string} topic
   * @param {any} payload
   */
  // eslint-disable-next-line no-unused-vars
  async publish(topic, payload) { throw new Error('not implemented'); }

  /**
   * @param {string} topic
   * @param {Handler} handler
   * @returns {Promise<() => void>} unsubscribe
   */
  // eslint-disable-next-line no-unused-vars
  async subscribe(topic, handler) { throw new Error('not implemented'); }

  async close() {}
}

/**
 * One process, no network. Behaviourally identical to calling the handler.
 *
 * This is the default, and on a single instance it is also the right choice:
 * routing a frame out to Redis and back to the same process to reach a socket
 * three objects away would add a network hop to every keystroke in exchange
 * for nothing. The point of the interface is that the day a second instance
 * exists, only the construction site changes.
 */
export class InProcessPubSub extends PubSub {
  constructor() {
    super();
    /** @type {Map<string, Set<Handler>>} */
    this.topics = new Map();
  }

  async publish(topic, payload) {
    const handlers = this.topics.get(topic);
    if (!handlers) return;
    // Iterate a copy: a handler is allowed to unsubscribe itself, and mutating
    // the Set mid-iteration would skip the handler after it.
    for (const handler of [...handlers]) {
      try {
        handler(payload, { topic });
      } catch (err) {
        // One bad subscriber must not stop the others from being told. This
        // is a broadcast, not a transaction.
        console.warn(`[pubsub] handler for ${topic} threw: ${err.message}`);
      }
    }
  }

  async subscribe(topic, handler) {
    if (!this.topics.has(topic)) this.topics.set(topic, new Set());
    this.topics.get(topic).add(handler);
    return () => {
      const handlers = this.topics.get(topic);
      if (!handlers) return;
      handlers.delete(handler);
      if (!handlers.size) this.topics.delete(topic);
    };
  }

  async close() {
    this.topics.clear();
  }
}

/** Topic names, in one place so the two ends cannot disagree about them. */
export const topics = {
  /** Engine frames and everything else broadcast to a document's clients. */
  room: (docId) => `room:${docId}`,
  /** Presence deltas, kept separate so a subscriber can take one and not the other. */
  presence: (docId) => `presence:${docId}`,
};
