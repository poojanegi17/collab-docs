/**
 * Regression test for the offline/online toggle -- the status pill in the UI.
 *
 * The original checklist passed while the browser needed a manual reload,
 * because the checklist slept between disconnect and connect. Real clicks have
 * no such sleep, and the close event is deferred, so `synced` was still true
 * when `connect()` ran; it resolved immediately and never opened a socket.
 *
 * Lesson worth keeping: a test that sleeps between steps is not testing the
 * sequence a user actually produces. These cases deliberately do not sleep.
 *
 *   node tools/toggle-test.mjs   (needs: npm run dev:server)
 */
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';

const URL_ = process.env.WS_URL ?? 'ws://localhost:8080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 45_000);
guard.unref?.();

async function client(id, docId) {
  const c = new YjsSync({ url: URL_, docId, clientId: id });
  await c.connect();
  return c;
}

async function converged(clients, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const texts = clients.map((c) => c.text.toString());
    if (texts.every((t) => t === texts[0])) return texts[0];
    await sleep(50);
  }
  return null;
}

console.log('\nOffline/online toggle\n');

// ---- 1. the exact bug: reconnect with NO delay after disconnect ------------
{
  const doc = 'toggle-' + Date.now();
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.text.insert(0, 'shared. ');
  await converged([a, b]);

  a.disconnect();
  // No sleep. This is what clicking the pill twice quickly actually does, and
  // it is where the old code went permanently offline.
  const reconnect = a.connect();

  check('1. disconnect() clears synced synchronously', a.synced === false);

  a.text.insert(a.text.length, '[typed offline] ');
  b.text.insert(b.text.length, '[peer edit] ');

  await reconnect;
  const text = await converged([a, b]);
  check('2. immediate reconnect actually reconnects', a.status === 'synced', `status=${a.status}`);
  check('3. converges without a reload', text !== null,
    text === null ? `alice=${JSON.stringify(a.text.toString())} bob=${JSON.stringify(b.text.toString())}` : JSON.stringify(text));
  check('3b. offline edits survived', !!text && text.includes('[typed offline]'));
  check('3c. peer edits survived', !!text && text.includes('[peer edit]'));

  a.destroy(); b.destroy();
}

// ---- 2. rapid toggling must not leave orphaned sockets ---------------------
{
  const doc = 'toggle-storm-' + Date.now();
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.text.insert(0, 'base. ');
  await converged([a, b]);

  // Ten offline/online cycles with no delay -- the stale-onclose race.
  for (let i = 0; i < 10; i++) {
    a.disconnect();
    a.connect();
    a.text.insert(a.text.length, `${i}`);
  }
  await a.connect();
  await sleep(500);

  check('4. rapid toggling settles on exactly one connection', a.status === 'synced', `status=${a.status}`);
  const text = await converged([a, b]);
  check('5. no edits lost across 10 toggles', text === 'base. 0123456789', JSON.stringify(text));

  // A second client joining now must see the same thing -- proof the server
  // got everything, not just that the two peers agree with each other.
  const c = await client('carol', doc);
  await converged([a, b, c]);
  check('6. fresh client sees the same document', c.text.toString() === text, JSON.stringify(c.text.toString()));

  a.destroy(); b.destroy(); c.destroy();
}

// ---- 3. offline edits while the peer also edits, then reconnect ------------
{
  const doc = 'toggle-merge-' + Date.now();
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.text.insert(0, 'hello world');
  await converged([a, b]);

  a.disconnect();
  for (let i = 0; i < 30; i++) a.text.insert(5, 'a');
  for (let i = 0; i < 30; i++) b.text.insert(5, 'b');
  await sleep(150);

  await a.connect();
  const text = await converged([a, b], 8000);
  check('7. 30 offline vs 30 online edits at the same offset converge', text !== null);
  check('7b. all 60 characters present', !!text && text.length === 'hello world'.length + 60,
    text ? `${text.length} chars` : '');

  a.destroy(); b.destroy();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
