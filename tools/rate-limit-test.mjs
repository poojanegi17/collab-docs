/**
 * The rate limiter, the cache, and the session cache.
 *
 * Spawns its own server on port 8116 with limits set DELIBERATELY LOW rather
 * than the production numbers -- auth=2 above all, because asserting on a
 * limit of ten would mean ten scrypt hashes per assertion, a second of blocked
 * event loop to prove what a limit of two proves just as well.
 *
 * The read tier is the exception: limit 10 over a SIXTY SECOND window, because
 * each read is a round trip to Neon and a short window can expire in the
 * middle of the burst. See the note at the spawn below -- getting this wrong
 * made the assertion depend on network latency rather than on the limiter.
 *
 * Note that this harness does NOT use `scratchEnv`'s rate-limit defaults --
 * that helper switches limiting OFF for every other harness (see
 * tools/test-schema.mjs), which is exactly what this one must not inherit.
 *
 * WHAT IS WORTH READING HERE
 *
 * The negative and the boring-but-load-bearing ones:
 *
 *   - `/api/health` is NOT limited. Render's health check and the keep-alive
 *     cron both hit it, so limiting it would let the platform rate-limit
 *     itself into declaring the service unhealthy (ADR-022).
 *   - the window does not slide forward. A counter that is re-expired on
 *     every hit never resets under sustained traffic, which turns a 15-minute
 *     limit into a permanent lockout. This is the bug the `NX` in
 *     RedisCache.incr exists to prevent, and it is asserted below.
 *   - logout evicts the session cache IMMEDIATELY, rather than leaving a
 *     signed-out token working until its TTL runs out.
 *
 *   node tools/rate-limit-test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';
import { InProcessCache, RedisCache } from '../backend/src/cache/cache.js';
import { createRedis, whenReady } from '../backend/src/cache/redis.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { schema, accountsSchema } = scratchSchemas('ratelimit');
// 8116 because 8097-8115 are taken. comments-test.mjs uses 8106 AND 8107 for
// its two engines, and colliding with the second one made THAT harness fail
// several assertions in a way that named neither the port nor this file.
const PORT = 8116;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await resetSchemas(schema, accountsSchema);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name
    + (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

const timer = setTimeout(() => {
  fs.writeSync(1, '\nTIMEOUT: harness exceeded 120s\n');
  process.exit(1);
}, 120_000);
timer.unref?.();

// ---------------------------------------------------------------------------
// Part 1: the cache implementations, with no server involved.
// ---------------------------------------------------------------------------
fs.writeSync(1, '\nCaches\n\n');

/**
 * Run the same assertions against any Cache. Both implementations have to
 * agree, or the Redis one is not a drop-in for the Map one and the choice in
 * server.js is not really a choice.
 */
async function cacheContract(label, cache) {
  await cache.set('k', { a: 1 }, 5_000);
  const got = await cache.get('k');
  check(`${label}: a value round-trips`, got?.a === 1, JSON.stringify(got));

  check(`${label}: a missing key is undefined`,
    (await cache.get('nope-' + Date.now())) === undefined);

  await cache.del('k');
  check(`${label}: del removes it`, (await cache.get('k')) === undefined);

  await cache.set('short', 'v', 60);
  await sleep(140);
  check(`${label}: a value expires`, (await cache.get('short')) === undefined);

  // The counter, and the property that matters: the window is set once.
  const key = 'ctr-' + Date.now();
  const a = await cache.incr(key, 400);
  const b = await cache.incr(key, 400);
  check(`${label}: incr counts up`, a?.count === 1 && b?.count === 2,
    `${a?.count} then ${b?.count}`);
  check(`${label}: the window does not slide forward`,
    typeof b?.resetMs === 'number' && b.resetMs <= a.resetMs,
    `${a?.resetMs}ms then ${b?.resetMs}ms`);

  await sleep(500);
  const c = await cache.incr(key, 400);
  check(`${label}: the counter resets after its window`, c?.count === 1, String(c?.count));
}

const local = new InProcessCache();
await cacheContract('in-process', local);
await local.close();

// The Redis half runs only when there is a Redis, and SKIPS loudly otherwise
// rather than passing quietly -- a green run with no Redis must not read as
// "the Redis implementation works".
if (process.env.REDIS_URL) {
  const client = createRedis(process.env.REDIS_URL);
  // Wait for the handshake before asserting anything. Without this every
  // command would be issued against a connecting socket, which
  // `enableOfflineQueue: false` rejects instantly -- and RedisCache turns a
  // rejection into a miss, so the assertions would fail as though the cache
  // were broken rather than merely not up yet.
  const ready = await whenReady(client, 15_000);
  check('redis: the connection comes up', ready === true,
    ready ? '' : 'did not become ready within 15s');
  const redisCache = new RedisCache(client, { prefix: 'test-' + Date.now() });
  try {
    if (ready) await cacheContract('redis', redisCache);
  } finally {
    await redisCache.close();
  }
} else {
  fs.writeSync(1, '  SKIP  redis: REDIS_URL is not set.\n'
    + '        The in-process cache above is what the server uses without it,\n'
    + '        so this run proves the DEFAULT path and not the Redis one.\n');
}

// ---------------------------------------------------------------------------
// Part 2: the limiter, against a live server.
// ---------------------------------------------------------------------------
fs.writeSync(1, '\nRate limiting\n\n');

const child = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
  env: {
    ...process.env,
    ...scratchEnv({ schema, accountsSchema, port: PORT, engine: 'yjs' }),
    // Override scratchEnv's "off". These are the numbers under test.
    RATE_LIMIT_AUTH: '2',
    RATE_LIMIT_AUTH_WINDOW_MS: '2000',
    RATE_LIMIT_WRITE: '2',
    RATE_LIMIT_WRITE_WINDOW_MS: '2000',
    // A LONG window on purpose. The auth tier's is short because the harness
    // waits it out twice; the read tier's must be long because each /api/docs
    // is a round trip to Neon, and a 2s window can genuinely expire in the
    // middle of a five-request loop -- which made this assertion pass or fail
    // on network latency rather than on the limiter.
    RATE_LIMIT_READ: '10',
    RATE_LIMIT_READ_WINDOW_MS: '60000',
    RATE_LIMIT_SOCKET: '3',
    RATE_LIMIT_SOCKET_WINDOW_MS: '60000',
    SESSION_CACHE_MS: '30000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('    [server] ' + d));
await new Promise((resolve) => {
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
});

async function api(pathname, { method = 'GET', token, body, headers } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, headers: res.headers };
}

/**
 * Open a raw TCP socket, send an upgrade request by hand, and return the
 * status line's code. 101 means the handshake was accepted; 429 means the
 * limiter refused it before ws ever saw it.
 */
function upgradeStatus(docId) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`GET /?doc=${docId} HTTP/1.1\r\n`
        + `Host: localhost:${PORT}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + 'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    let buf = '';
    const done = (code) => { try { sock.destroy(); } catch { /* gone */ } resolve(code); };
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) done(Number(m[1]));
    });
    sock.on('error', () => done(0));
    setTimeout(() => done(0), 8_000).unref?.();
  });
}

try {
  // -- the auth tier ------------------------------------------------------
  const attempts = [];
  for (let i = 0; i < 4; i++) {
    attempts.push(await api('/api/auth/login', {
      method: 'POST', body: { email: `nobody${i}@example.com`, password: 'wrong' },
    }));
  }
  check('1. the first two login attempts are answered normally',
    attempts[0].status === 401 && attempts[1].status === 401,
    `${attempts[0].status}, ${attempts[1].status}`);
  check('1b. the third is refused with 429',
    attempts[2].status === 429, String(attempts[2].status));
  check('1c. and so is the fourth -- it is a limit, not a hiccup',
    attempts[3].status === 429, String(attempts[3].status));
  check('1d. the refusal says how long to wait',
    Number(attempts[2].headers.get('retry-after')) >= 0
    && attempts[2].body?.retryAfterMs > 0,
    `Retry-After: ${attempts[2].headers.get('retry-after')}s`);
  check('1e. the headers are on ALLOWED responses too, so a client can slow down',
    attempts[0].headers.get('ratelimit-limit') === '2'
    && attempts[0].headers.get('ratelimit-remaining') === '1',
    `limit=${attempts[0].headers.get('ratelimit-limit')} `
    + `remaining=${attempts[0].headers.get('ratelimit-remaining')}`);

  // -- health is exempt ---------------------------------------------------
  let healthOk = true;
  for (let i = 0; i < 8; i++) {
    if ((await api('/api/health')).status !== 200) healthOk = false;
  }
  check('2. /api/health is never limited -- the health check and the keep-alive '
    + 'cron both hit it', healthOk);

  // -- the window resets rather than sliding ------------------------------
  //
  // The auth tier is exhausted. If the window slid forward on every refused
  // request, the four refusals above would have pushed the reset out and this
  // would still be 429 after the original window elapsed.
  await sleep(2200);
  const afterWindow = await api('/api/auth/login', {
    method: 'POST', body: { email: 'nobody@example.com', password: 'wrong' },
  });
  check('3. the limit lifts once the window passes, even after refusals',
    afterWindow.status === 401, String(afterWindow.status));

  // -- the tiers are separate counters ------------------------------------
  //
  // The auth tier has just been exhausted and then allowed one through. If the
  // tiers shared a counter, a GET here would be refused.
  check('4. the read tier is counted separately from the auth tier',
    (await api('/api/docs')).status === 200);

  // ---------------------------------------------------------------------
  // Part 3: the session cache.
  // ---------------------------------------------------------------------
  fs.writeSync(1, '\nSession cache\n\n');

  await sleep(2200);   // let every tier reset before signing up

  const signup = await api('/api/auth/signup', {
    method: 'POST',
    body: { email: `cache${Date.now()}@example.com`, password: 'correct horse battery', name: 'Cache' },
  });
  check('5. signed up', signup.status === 201 && !!signup.body?.token, String(signup.status));
  const token = signup.body.token;

  await sleep(2200);   // the signup used the auth tier

  const me1 = await api('/api/me', { token });
  const me2 = await api('/api/me', { token });
  check('5b. a cached session still answers with the right user',
    me1.status === 200 && me2.status === 200
    && me1.body?.user?.id === me2.body?.user?.id,
    me2.body?.user?.email ?? String(me2.status));

  // The one that matters. A cache with a 30s TTL and no eviction on logout
  // would keep answering 200 here for another half minute.
  const out = await api('/api/auth/logout', { method: 'POST', token });
  check('5c. logout succeeds', out.status < 400, String(out.status));
  const meAfter = await api('/api/me', { token });
  check('5d. and the token stops working IMMEDIATELY, not after the TTL',
    meAfter.status === 401 || !meAfter.body?.user,
    `status ${meAfter.status}`);

  // ---------------------------------------------------------------------
  // Part 4: the read tier is actually enforced.
  //
  // LAST, and asserted on the SHAPE of the responses rather than on an exact
  // index. The harness has already spent an unknown number of reads by now,
  // and pinning "the 11th is refused" would be re-deriving that count in the
  // test -- which is how a harness ends up asserting its own arithmetic
  // instead of the server's behaviour.
  //
  // Two properties, and together they are the whole definition of a limit:
  // some request is refused, and once one is, none after it succeeds.
  // ---------------------------------------------------------------------
  fs.writeSync(1, '\nRead tier\n\n');

  const burst = [];
  for (let i = 0; i < 20; i++) burst.push((await api('/api/docs')).status);

  const firstRefusal = burst.indexOf(429);
  check('6. a sustained burst of reads is eventually refused',
    firstRefusal !== -1, `${burst.filter((s) => s === 429).length}/20 refused`);
  check('6b. and nothing succeeds after the first refusal -- it is a limit, not noise',
    firstRefusal === -1 || burst.slice(firstRefusal).every((s) => s === 429),
    burst.join(',').slice(0, 90));
  check('6c. the refusal is a 429 and not a 500 -- the limiter is not throwing',
    burst.every((s) => s === 200 || s === 429),
    [...new Set(burst)].join(','));

  // ---------------------------------------------------------------------
  // Part 5: WebSocket upgrades are limited too.
  //
  // This path used to bypass the limiter entirely -- `handleHttp` is bound to
  // the server's 'request' event and an upgrade is not a request. It matters
  // because opening an unknown document id CREATES that document while
  // `requireOwner` is false, which ADR-010 makes a feature and which is
  // therefore unbounded creation unless something meters it.
  //
  // Asserted with a raw socket rather than a WebSocket client, because the
  // refusal happens BEFORE the handshake: the server writes a plain HTTP 429
  // and hangs up, which a WebSocket client would report only as "connection
  // failed" with the status thrown away.
  // ---------------------------------------------------------------------
  fs.writeSync(1, '\nWebSocket upgrades\n\n');

  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push(await upgradeStatus(`ws-limit-${i}`));

  check('7. the first upgrades within the limit are accepted',
    statuses.slice(0, 3).every((s) => s === 101), statuses.join(','));
  check('7b. and past it the upgrade is refused before the handshake',
    statuses[3] === 429 && statuses[4] === 429,
    `4th=${statuses[3]} 5th=${statuses[4]}`);
} finally {
  child.kill();
}

fs.writeSync(1, `\n${pass} passed, ${fail} failed\n\n`);
process.exit(fail ? 1 : 0);
