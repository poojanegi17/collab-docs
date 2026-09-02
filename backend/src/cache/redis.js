/**
 * The Redis connection, and the one place that knows we are on Redis.
 *
 * Deliberately shaped like ../storage/db.js, because it is the same kind of
 * file for the opposite kind of data. That one holds the record; this one
 * holds things the record can be rebuilt from.
 *
 * WHAT MAY LIVE HERE, STATED ONCE SO EVERY CALLER INHERITS IT
 *
 * ADR-019 is the rule and it has not moved: Postgres is the source of truth,
 * and anything in front of it is a cache, a transport or a buffer, never the
 * record. Concretely, before putting anything in Redis, answer this: if the
 * key vanished right now -- and it can, because eviction, restarts and free
 * plans are all real -- does the system still work, just more slowly? If the
 * answer is no, it does not belong here.
 *
 * Two current callers, both of which pass that test:
 *
 *   session cache   a token -> user mapping that Postgres can always re-derive
 *   rate limiting   a counter whose loss lets somebody make a few more
 *                   requests than they should have, which is a smaller
 *                   failure than refusing everyone because Redis is down
 *
 * WHY MISSING IS NOT AN ERROR
 *
 * `REDIS_URL` unset returns null, and every caller has an in-process fallback
 * for that case. This is not politeness -- it is what keeps `npm test` running
 * with no infrastructure, keeps a fresh clone working, and keeps a Redis
 * outage from being an outage. The fallbacks are the same objects the code
 * used before Redis existed, so the un-cached path stays the tested path
 * rather than becoming a branch nobody exercises.
 *
 * WHY FAILURES ARE SWALLOWED RATHER THAN THROWN
 *
 * A cache that can take the site down is worse than no cache. Every operation
 * in cache.js catches, and the connection below is configured never to queue
 * or retry forever: an unreachable Redis has to fail in milliseconds and let
 * the caller fall through to Postgres, not hold a request open until it times
 * out. That is the single most important line in this file, so it is
 * `enableOfflineQueue: false` and it is not an accident.
 */
import Redis from 'ioredis';

/**
 * Connect, or return null if this deployment has no Redis.
 *
 * @param {string|undefined} url
 * @param {{onError?: (err: Error) => void}} [opts]
 * @returns {import('ioredis').Redis | null}
 */
export function createRedis(url, { onError } = {}) {
  if (!url) return null;

  const client = new Redis(url, {
    // The whole point. With the offline queue on, a command issued while the
    // connection is down is HELD until it comes back -- so a Redis outage
    // becomes a pile of hanging requests instead of a fast miss. Off, a
    // command against a down connection rejects immediately and the caller
    // goes to Postgres, which is exactly the behaviour a cache should have.
    enableOfflineQueue: false,
    // One retry, then fail. A cache lookup that takes three round trips to
    // discover it cannot work has already cost more than the query it was
    // meant to save.
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    // Reconnect with a ceiling, so a long outage settles into a slow retry
    // rather than hammering. Returning a number means "retry in this many ms".
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    // Upstash and every other hosted provider require TLS. `rediss://` sets
    // this on its own; being explicit means a plain `redis://` in a local
    // .env file still works without special-casing.
    ...(url.startsWith('rediss://') ? { tls: {} } : {}),
    lazyConnect: false,
  });

  // ioredis emits `error` on every failed reconnect. Without a listener that
  // is an unhandled 'error' event, which in Node takes the process down -- so
  // this listener is load-bearing, not diagnostic. It is throttled because a
  // sustained outage would otherwise write a line every retry forever.
  let lastLogged = 0;
  client.on('error', (err) => {
    if (onError) return onError(err);
    const now = Date.now();
    if (now - lastLogged < 30_000) return;
    lastLogged = now;
    console.warn(`[redis] ${err.message} -- falling back to Postgres`);
  });

  return client;
}

/**
 * Resolve once the connection is usable, or false if it is not within
 * `timeoutMs`.
 *
 * WHY THIS IS NOT CALLED AT BOOT, AND IS CALLED BY THE HARNESS
 *
 * The server does not wait. `enableOfflineQueue: false` means a command issued
 * before the socket is up rejects immediately, which every caller already
 * treats as a cache miss -- so the first requests after a restart go to
 * Postgres and everything is correct, just briefly uncached. Blocking boot on
 * a cache would be the wrong trade in the one file whose entire argument is
 * that the cache must never be able to take the site down.
 *
 * A test asserting on cache BEHAVIOUR has the opposite need: it has to know
 * the difference between "Redis said no" and "Redis was not connected yet",
 * and without this every assertion would race the handshake and pass or fail
 * on timing. See tools/rate-limit-test.mjs.
 */
export function whenReady(client, timeoutMs = 10_000) {
  if (!client) return Promise.resolve(false);
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      resolve(value);
    };
    const onReady = () => finish(true);
    // Deliberately NOT resolving on 'error': ioredis emits one per failed
    // reconnect attempt, and the retry after it may well succeed. Only the
    // timeout is allowed to give up.
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    client.once('ready', onReady);
  });
}
