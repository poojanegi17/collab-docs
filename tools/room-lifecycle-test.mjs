/**
 * A connection that goes away mid-admission must not stay in the room.
 *
 *   node tools/room-lifecycle-test.mjs
 *
 * WHY THIS EXISTS
 *
 * `room.join` registers the connection synchronously and then awaits
 * `helloFor`, which reads the document row and possibly the tab row from
 * Postgres. Those are round trips, and a client that connects and immediately
 * goes away -- a refresh, a flaky mobile connection, a tab closed on a slow
 * page -- can disconnect inside that window.
 *
 * Attach the close listener AFTER the join and such a client is never
 * removed: it stays in `room.clients` for the life of the process, the room
 * never reports itself empty, and so is never evicted and never takes its
 * closing snapshot. A slow leak, and an accumulating set of rooms holding
 * engine state nobody is reading.
 *
 * Run on its own: it binds a port.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { schema, accountsSchema } = scratchSchemas('roomlifecycle');
const PORT = 8102;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

await resetSchemas(schema, accountsSchema);

const logs = [];
function boot() {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      // The production window, not 0. The point is to exercise what ships.
      ...scratchEnv({ schema, accountsSchema, port: PORT }),
      PERSIST_WINDOW_MS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => logs.push(String(d)));
  p.stderr.on('data', (d) => logs.push(String(d)));
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
  });
}

/** Ask the server how many connections it believes are attached. */
async function health() {
  const res = await fetch(`http://localhost:${PORT}/api/health`);
  return res.json();
}

/**
 * Poll `health()` until `ok(h)` holds, or give up.
 *
 * Fixed sleeps made this file flaky when it ran at the end of the full suite
 * rather than on its own -- the box is busy and admitting a connection is
 * several round trips to Neon. Polling waits for the condition instead of
 * guessing how long it takes; a genuine failure still fails, it just takes
 * the full timeout to do it.
 */
async function until(ok, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await health();
    if (ok(last)) return last;
    if (Date.now() > deadline) return last;
    await sleep(100);
  }
}

console.log('\nRoom lifecycle under a mid-admission disconnect\n');

const server = await boot();
await sleep(300);

// ---------------------------------------------------------------------------
// Open and immediately abandon a batch of sockets. Each one is closed while
// the server is still inside the awaits that admit it.
const DOC = 'lifecycle-doc';
const FLAPS = 25;
for (let i = 0; i < FLAPS; i++) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?doc=${DOC}&client=flap-${i}`);
  // Close as soon as the socket opens -- which is well before the server has
  // finished the session lookup, the document read and the permission check.
  ws.on('open', () => ws.close());
  ws.on('error', () => {});
  await sleep(12);
}
const after = await until((h) => h.clients === 0);
check('the server survived the flapping', after?.ok === true);
check(`no connection is left registered after ${FLAPS} mid-admission disconnects`,
  after.clients === 0, `${after.clients} still registered`);
// One room is expected and correct: rooms are kept warm for 30s after the
// last client leaves so a refresh does not cost a reload from storage. What
// would be wrong is that room still believing it has clients, which is the
// assertion above. With the bug, `clients` was 25 and the room could never
// reach the empty state that starts the eviction timer at all.
check('at most the one warm, empty room is left',
  after.rooms <= 1, `${after.rooms} rooms open`);

// ---------------------------------------------------------------------------
// A real client must still be able to join and be counted, so the fix cannot
// have been "never register anybody".
const live = new WebSocket(`ws://localhost:${PORT}/?doc=${DOC}&client=real`);
await new Promise((resolve, reject) => {
  live.on('open', resolve);
  live.on('error', reject);
});
const withOne = await until((h) => h.clients === 1);
check('a client that stays IS registered',
  withOne.clients === 1, `${withOne.clients} registered`);

live.close();
const back = await until((h) => h.clients === 0);
check('and is unregistered when it leaves',
  back.clients === 0, `${back.clients} registered`);

// ---------------------------------------------------------------------------
check('no unhandled promise rejections on the server',
  !logs.some((l) => /UnhandledPromiseRejection|unhandledRejection/i.test(l)),
  logs.filter((l) => /Unhandled/i.test(l)).join(' ').slice(0, 200));
check('no unhandled promise rejections in this process',
  unhandled.length === 0, unhandled.map((e) => e?.message).join('; '));

server.kill('SIGKILL');
await resetSchemas(schema, accountsSchema);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
