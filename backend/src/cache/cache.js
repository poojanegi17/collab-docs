/**
 * A keyed cache with expiry, behind an interface with two implementations.
 *
 * WHY AN INTERFACE, WHEN THERE IS ONLY ONE INSTANCE
 *
 * The same reason as ../realtime/pubsub.js: the in-process implementation is
 * correct on one node and the Redis one is correct on any number, and the
 * decision between them should be a construction site rather than a rewrite.
 *
 * But there is a second reason here that pub/sub does not have. On ONE node an
 * in-process Map is genuinely FASTER than Redis -- no network hop at all --
 * so this is not a stepping stone to be replaced. Both implementations are
 * ones you might legitimately want to keep, and which is right depends on a
 * fact about the deployment (how many processes) rather than on which is
 * better. ADR-022 has the argument.
 *
 * WHAT THIS IS NOT
 *
 * Not storage. Every value here is derivable from Postgres, and every caller
 * must work when a `get` returns undefined -- which it will, for reasons that
 * have nothing to do with expiry: eviction under memory pressure, a restart, a
 * network blip, or a free plan's command budget running out mid-day. "Cache
 * miss" is the normal case, not the exceptional one.
 *
 * FAILURES ARE MISSES
 *
 * Every method catches. A `get` that cannot reach Redis returns undefined, and
 * the caller does what it would have done anyway; a `set` that fails is
 * dropped silently. This is the property that makes a cache safe to add to a
 * working system: the worst a broken Redis can do is make the site as fast as
 * it was before this file existed.
 */

/** The contract. */
export class Cache {
  // eslint-disable-next-line no-unused-vars
  async get(key) { throw new Error('not implemented'); }
  /** @param {number} ttlMs how long the value may be served for */
  // eslint-disable-next-line no-unused-vars
  async set(key, value, ttlMs) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async del(key) { throw new Error('not implemented'); }
  /**
   * Increment a counter and return its new value, setting the expiry on the
   * FIRST increment only, so a window starts when it is first used and is not
   * pushed forward by later hits inside it. This is the whole primitive the
   * rate limiter needs, and it is on the interface rather than built from
   * `get`+`set` because read-modify-write across a network is a race: two
   * requests both read 4, both write 5, and a limit of 5 admits six.
   * @returns {Promise<{count: number, resetMs: number} | null>} null if the
   *   cache is unavailable -- which the caller must treat as "allow", not
   *   "deny". See rate-limit.js.
   */
  // eslint-disable-next-line no-unused-vars
  async incr(key, windowMs) { throw new Error('not implemented'); }
  async close() {}
}

/**
 * One process, one Map. The default, and the FASTER choice on one instance.
 *
 * Expiry is checked on read rather than swept on a timer: a cache with no
 * reader for a key does not care that the key is stale, and a timer over
 * thousands of keys is work done on behalf of nobody. The sweep that does
 * exist is bounded and only runs when the map has grown past `maxKeys`, which
 * is what stops an unbounded key space (a session token is unbounded) from
 * being a memory leak with a slow fuse.
 */
export class InProcessCache extends Cache {
  constructor({ maxKeys = 10_000 } = {}) {
    super();
    /** @type {Map<string, { value: any, expires: number }>} */
    this.entries = new Map();
    this.maxKeys = maxKeys;
  }

  async get(key) {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async set(key, value, ttlMs) {
    if (this.entries.size >= this.maxKeys) this.evict();
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }

  async del(key) {
    this.entries.delete(key);
  }

  async incr(key, windowMs) {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (!hit || hit.expires <= now) {
      // First hit in a new window: the expiry is set here and never moved.
      const entry = { value: 1, expires: now + windowMs };
      if (this.entries.size >= this.maxKeys) this.evict();
      this.entries.set(key, entry);
      return { count: 1, resetMs: windowMs };
    }
    hit.value += 1;
    return { count: hit.value, resetMs: hit.expires - now };
  }

  /**
   * Drop what has already expired; if that frees nothing, drop the oldest
   * half. Insertion order is Map's iteration order, so "oldest half" is the
   * first half, and no separate LRU structure is needed for what is a
   * backstop rather than an eviction policy anybody should be relying on.
   */
  evict() {
    const now = Date.now();
    let freed = 0;
    for (const [k, v] of this.entries) {
      if (v.expires <= now) { this.entries.delete(k); freed++; }
    }
    if (freed) return;
    const drop = Math.floor(this.entries.size / 2);
    let i = 0;
    for (const k of this.entries.keys()) {
      if (i++ >= drop) break;
      this.entries.delete(k);
    }
  }

  async close() {
    this.entries.clear();
  }
}

/**
 * Redis. Correct on any number of processes, and the one that makes a rate
 * limit mean what it says once there is more than one.
 *
 * Values are JSON, because everything cached here is a plain object and the
 * alternative -- a hash per key -- buys nothing when every read wants the
 * whole value anyway.
 */
export class RedisCache extends Cache {
  /**
   * @param {import('ioredis').Redis} client
   * @param {{prefix?: string}} [opts] namespaces keys, so the two engines'
   *   servers and a local dev machine can share one free-tier instance
   *   without colliding. Postgres gets this from schemas; Redis has no such
   *   thing, so it is a string.
   */
  constructor(client, { prefix = 'collab' } = {}) {
    super();
    this.client = client;
    this.prefix = prefix;
  }

  key(k) { return `${this.prefix}:${k}`; }

  async get(key) {
    try {
      const raw = await this.client.get(this.key(key));
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      // A miss, not an error. See the header.
      return undefined;
    }
  }

  async set(key, value, ttlMs) {
    try {
      // PX rather than EX: the windows here are sub-second in the tests, and
      // a TTL rounded down to zero seconds is a key that never expires.
      await this.client.set(this.key(key), JSON.stringify(value), 'PX', Math.max(1, ttlMs));
    } catch { /* dropped on purpose */ }
  }

  async del(key) {
    try {
      await this.client.del(this.key(key));
    } catch { /* dropped on purpose */ }
  }

  async incr(key, windowMs) {
    try {
      // INCR then PEXPIRE, pipelined so it is one round trip rather than two.
      //
      // The expiry is set on EVERY increment, which looks wrong and is not:
      // `PEXPIRE key ms NX` sets it only when the key has none, so the window
      // starts at the first request and later ones inside it do not extend it.
      // Getting this wrong gives a limiter that a steady stream of traffic can
      // keep alive forever, so the window never resets and the caller is
      // locked out permanently.
      const k = this.key(key);
      const res = await this.client.multi()
        .incr(k)
        .pexpire(k, Math.max(1, windowMs), 'NX')
        .pttl(k)
        .exec();
      if (!res) return null;
      const count = res[0]?.[1];
      const ttl = res[2]?.[1];
      if (typeof count !== 'number') return null;
      // A -1 pttl means the key exists with no expiry, which the NX above
      // should make impossible; treat it as a full window rather than as a
      // key that will never reset.
      return { count, resetMs: typeof ttl === 'number' && ttl >= 0 ? ttl : windowMs };
    } catch {
      // Null means "cannot tell". The caller allows the request -- see the
      // note on the interface, and rate-limit.js for why fail-open is the
      // right choice for this particular limiter.
      return null;
    }
  }

  async close() {
    try { await this.client.quit(); } catch { /* already gone */ }
  }
}
