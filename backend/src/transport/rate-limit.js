/**
 * Request rate limiting.
 *
 * THE VULNERABILITY THIS CLOSES, WHICH IS NOT THE OBVIOUS ONE
 *
 * The obvious reason to rate limit a login route is credential stuffing, and
 * that reason applies. It is not the urgent one here.
 *
 * `Accounts.verifyPassword` is scrypt at N=2^15, which is ~100ms of CPU per
 * attempt -- chosen deliberately in ../storage/accounts.js, and correct. Node
 * is single-threaded. So `POST /api/auth/login` is an UNAUTHENTICATED route
 * that converts one cheap HTTP request into 100ms of blocked event loop, and a
 * few hundred requests a second of complete garbage -- no valid account, no
 * password anywhere near right -- stops the server answering anything at all,
 * including the WebSocket upgrades that carry every open document.
 *
 * That is a denial of service reachable by anyone who can reach the site, and
 * on one free instance there is nothing else to absorb it. Everything below is
 * in service of that, and the credential-stuffing benefit is a bonus.
 *
 * WHY THE LIMITS ARE TIERED RATHER THAN ONE NUMBER
 *
 * A single global limit has to be loose enough for the most frequent legitimate
 * caller, which makes it far too loose for the most expensive route. The
 * expensive routes here are a tiny, enumerable set -- the ones that hash a
 * password -- so they get a strict limit and everything else gets one that a
 * real user cannot hit. A limit nobody legitimate ever reaches is a limit
 * nobody complains about, which is what keeps it switched on.
 *
 * WHY IT FAILS OPEN, AND WHY THAT IS NOT AS BAD AS IT SOUNDS
 *
 * If the shared counter cannot be reached, the request is ALLOWED rather than
 * refused. Refusing would mean a Redis outage takes the site down completely,
 * which is a strictly worse failure than the one being defended against.
 *
 * But "fail open" here does not mean "no limit". The limiter always holds a
 * local in-process counter as well, and falls back to it when the shared one
 * is unavailable. On one instance that is exactly as good as Redis; on several
 * it is a limit that is N times looser than it says, which is still enormously
 * better than none. So the real failure mode is a degraded limit, not an
 * absent one.
 */
import { InProcessCache } from '../cache/cache.js';

/**
 * Where the client's address comes from, and why it is not `remoteAddress`.
 *
 * In production every request arrives from Render's proxy, so the socket's
 * address is the proxy's and identical for everybody -- limiting on it would
 * put the entire internet in one bucket. The real address is in
 * `x-forwarded-for`.
 *
 * That header is APPEND-ONLY and client-controllable: a caller can send
 * `x-forwarded-for: 1.2.3.4` and the proxy appends what it actually saw,
 * giving `1.2.3.4, <real>`. So the LAST entry is the one the trusted proxy
 * wrote and every earlier entry is attacker-supplied. Taking the first --
 * which is the usual advice, and is right when you want the originating client
 * through a chain of proxies you trust -- would let anyone evade this limiter
 * completely by sending a different fake first entry each time.
 *
 * With no proxy in front (local development, the harnesses), there is no
 * header and the socket address is the truth.
 */
export function clientAddress(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * A limiter over some cache.
 *
 * `tiers` maps a name to `{ limit, windowMs }`. Callers name a tier rather
 * than passing numbers, so every limit in the system is visible in one place
 * (../config.js) instead of scattered across the routes that happen to use it.
 */
export class RateLimiter {
  /**
   * @param {import('../cache/cache.js').Cache} cache
   * @param {Record<string, {limit: number, windowMs: number}>} tiers
   */
  constructor(cache, tiers) {
    this.cache = cache;
    this.tiers = tiers;
    // The backstop described in the header. Always present, even when the
    // primary IS an InProcessCache -- in that case it simply never gets used,
    // because the primary never returns null.
    this.local = new InProcessCache({ maxKeys: 20_000 });
  }

  /**
   * @param {string} tierName
   * @param {string} identity what is being limited -- an address, an email,
   *   a user id. Callers pass the narrowest thing they know.
   * @returns {Promise<{ok: boolean, limit: number, remaining: number, resetMs: number}>}
   */
  async check(tierName, identity) {
    const tier = this.tiers[tierName];
    // An unknown tier is a programming error, and the safe reading of one is
    // "no limit" rather than "no requests": a typo in a tier name must not
    // silently lock a route.
    if (!tier) {
      console.warn(`[rate-limit] unknown tier "${tierName}" -- allowing`);
      return { ok: true, limit: Infinity, remaining: Infinity, resetMs: 0 };
    }

    // A limit of zero or less switches the tier off entirely. This is how the
    // harnesses run hundreds of requests a second against a real server
    // without every one of them having to know a limiter exists -- see
    // tools/test-schema.mjs. Checking it BEFORE touching the cache also means
    // a disabled tier costs no round trip.
    if (!(tier.limit > 0)) {
      return { ok: true, limit: Infinity, remaining: Infinity, resetMs: 0 };
    }

    const key = `rl:${tierName}:${identity}`;
    let hit = await this.cache.incr(key, tier.windowMs);
    // null means the shared counter could not be reached. Degrade to the local
    // one rather than to nothing.
    if (!hit) hit = await this.local.incr(key, tier.windowMs);
    if (!hit) return { ok: true, limit: tier.limit, remaining: tier.limit, resetMs: 0 };

    return {
      ok: hit.count <= tier.limit,
      limit: tier.limit,
      remaining: Math.max(0, tier.limit - hit.count),
      resetMs: hit.resetMs,
    };
  }
}

/**
 * Write the standard headers, on every answer rather than only on refusals.
 *
 * A client that can see it has three requests left can slow down; one that
 * only finds out by being refused cannot. `RateLimit-*` are the IETF draft
 * names, which is what the current generation of HTTP clients look for.
 */
export function setRateLimitHeaders(res, result) {
  if (!Number.isFinite(result.limit)) return;
  const resetSec = Math.ceil(result.resetMs / 1000);
  res.setHeader('RateLimit-Limit', String(result.limit));
  res.setHeader('RateLimit-Remaining', String(result.remaining));
  res.setHeader('RateLimit-Reset', String(resetSec));
  // `Retry-After` is the one that predates the drafts and the one a browser or
  // a proxy is most likely to honour, so a refusal carries both.
  if (!result.ok) res.setHeader('Retry-After', String(resetSec));
}
