/**
 * End-to-end checks for comments, run against BOTH engines.
 *
 * The point of running it twice is ADR-012. Comments are the first feature
 * where the two engines do not merely differ in mechanism but in kind: under
 * the CRDT an anchor is a relative position that rides along with a character,
 * under OT it is a pair of indices the server has to keep honest. Everything
 * below is asserted identically for both, because the seam is supposed to make
 * that difference invisible from here.
 *
 * The interesting checks are the ones about text MOVING:
 *
 *   - typing before a comment shifts it, and the quoted text is unchanged
 *   - typing strictly inside it grows it
 *   - typing against either edge does not (ADR-012 decision 4)
 *   - deleting the commented text orphans the thread instead of re-anchoring
 *     it somewhere it was never about (ADR-012 decision 3)
 *
 * Spawns its own servers on ports 8106/8107 with their own databases, so it
 * runs alongside the dev servers and never touches real data.
 *
 *   node tools/comments-test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';
import { OTSync } from '../frontend/src/sync/ot-sync.js';
import { RichTextOperation } from '../shared/ot/src/index.js';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENGINES = [
  { engine: 'yjs', port: 8106, Sync: YjsSync },
  { engine: 'ot', port: 8107, Sync: OTSync },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  // Written synchronously: the timeout guard exits the process, and buffered
  // stdout is discarded on exit -- losing exactly the lines that say how far
  // the run got before it hung.
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 120_000);
guard.unref?.();

function boot({ engine, port, schema, accountsSchema }) {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: port, engine: engine }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('    [server] ' + d));
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
  });
}

async function run({ engine, port, Sync }) {
  const base = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}`;
  const { schema, accountsSchema } = scratchSchemas('comments', engine);
  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);

  console.log(`\n--- ${engine.toUpperCase()} ---\n`);
  const server = await boot({ engine, port, schema, accountsSchema });

  const api = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  };

  const docId = `comments-${engine}-${Date.now()}`;
  const connect = async (id) => {
    const c = new Sync({ url: wsUrl, docId, clientId: id });
    c.socketFactory = () => new WebSocket(
      `${wsUrl}?doc=${encodeURIComponent(docId)}&client=${encodeURIComponent(id)}`);
    await c.connect();
    return c;
  };

  // Both engines expose the same two write paths; only the CRDT has a Y.Text.
  const typeAt = (client, at, text) => {
    if (engine === 'yjs') client.text.insert(at, text);
    else client.applyLocal(otInsert(client, at, text));
  };
  const deleteAt = (client, at, length) => {
    if (engine === 'yjs') client.text.delete(at, length);
    else client.applyLocal(otDelete(client, at, length));
  };

  const alice = await connect('alice');
  typeAt(alice, 0, 'The quick brown fox jumps over the lazy dog');
  await sleep(400);
  check('0. document seeded', alice.getText().startsWith('The quick brown fox'),
    `${alice.getText().length} chars`);

  // "brown" is at 10..15.
  const QUOTE = alice.getText().slice(10, 15);
  const made = await api(`/api/docs/${docId}/comments`, {
    method: 'POST',
    body: {
      anchor: alice.createAnchor(10, 15), quote: QUOTE,
      body: 'is it though?', authorName: 'Alice',
    },
  });
  check('1. a thread can be opened on a range', made.status === 201, `quote="${QUOTE}"`);
  const threadId = made.body?.thread?.id;
  check('1b. the first comment comes back with it',
    made.body?.thread?.comments?.length === 1,
    made.body?.thread?.comments?.[0]?.body);
  check('1c. the author is recorded', made.body?.thread?.author?.name === 'Alice');

  // The client mirrors what the server stored, exactly as the editor does.
  const track = async () => {
    const { body } = await api(`/api/docs/${docId}/comments`);
    alice.trackAnchors((body.threads ?? []).map((t) => ({ id: t.id, anchor: t.anchor })));
    return body.threads ?? [];
  };
  await track();
  const at = () => alice.resolvedAnchors().get(threadId);
  check('2. the anchor resolves to the range it was made on',
    at()?.from === 10 && at()?.to === 15, JSON.stringify(at()));

  // ---- text moving under the anchor ---------------------------------------

  typeAt(alice, 0, '>> ');            // 3 chars before it
  await sleep(250);
  check('3. typing BEFORE shifts the anchor',
    at()?.from === 13 && at()?.to === 18, JSON.stringify(at()));
  check('3b. and it still covers the same word',
    alice.getText().slice(at().from, at().to) === QUOTE,
    JSON.stringify(alice.getText().slice(at().from, at().to)));

  typeAt(alice, 15, 'XX');            // strictly inside "brown"
  await sleep(250);
  check('4. typing INSIDE grows the anchor',
    at()?.from === 13 && at()?.to === 20, JSON.stringify(at()));

  typeAt(alice, 13, 'YY');            // exactly on the start edge
  await sleep(250);
  check('5. typing at the START edge does not grow it (ADR-012 #4)',
    at()?.from === 15 && at()?.to === 22, JSON.stringify(at()));

  const beforeEnd = { ...at() };
  typeAt(alice, beforeEnd.to, 'ZZ');  // exactly on the end edge
  await sleep(250);
  check('6. typing at the END edge does not grow it (ADR-012 #4)',
    at()?.from === beforeEnd.from && at()?.to === beforeEnd.to, JSON.stringify(at()));

  // ---- replies and resolution ---------------------------------------------

  const replied = await api(`/api/docs/${docId}/comments/${threadId}`, {
    method: 'POST', body: { body: 'yes, it is brown', authorName: 'Bob' },
  });
  check('7. a thread accepts replies', replied.body?.thread?.comments?.length === 2);

  const resolved = await api(`/api/docs/${docId}/comments/${threadId}/resolve`, {
    method: 'POST', body: { resolved: true },
  });
  check('8. a thread can be resolved', resolved.body?.thread?.resolved === true);

  const reopened = await api(`/api/docs/${docId}/comments/${threadId}`, {
    method: 'POST', body: { body: 'actually, hold on', authorName: 'Alice' },
  });
  check('8b. replying re-opens it', reopened.body?.thread?.resolved === false);

  // ---- orphaning ----------------------------------------------------------

  const doomed = at();
  deleteAt(alice, doomed.from, doomed.to - doomed.from);
  await sleep(500);

  check('9. deleting the text un-resolves the anchor locally',
    alice.resolvedAnchors().get(threadId) === null,
    JSON.stringify(alice.resolvedAnchors().get(threadId)));

  /*
   * Under OT the server transforms the anchor itself, and that work is two
   * Postgres round trips behind an engine hook that cannot await it: read the
   * threads, then write the orphan flag. Against a database in another region
   * those do not reliably land inside the 500ms slept above, so a fixed wait
   * fails intermittently on latency rather than on behaviour.
   *
   * So the OT branch waits for the flag it expects instead of assuming one
   * sleep covers it. The CRDT branch asserts the OPPOSITE -- that the server
   * never learns -- and a negative has nothing to wait for, so it reads once
   * and is only made stronger by the extra time that has passed.
   */
  const readThread = async () => {
    const res = await api(`/api/docs/${docId}/comments`);
    return res.body.threads.find((t) => t.id === threadId);
  };
  let stored = await readThread();
  if (engine === 'ot') {
    const deadline = Date.now() + 10_000;
    while (stored?.orphaned !== true && Date.now() < deadline) {
      await sleep(250);
      stored = await readThread();
    }
  }

  if (engine === 'ot') {
    // The OT server transforms anchors itself, so it KNOWS the range is gone
    // and records it. This is the server-authority half of ADR-012.
    check('9b. the OT server records the thread as orphaned',
      stored?.orphaned === true, `orphaned=${stored?.orphaned}`);
  } else {
    // The CRDT server relays bytes and never inspects them, so it cannot know.
    // Orphaning is a client-side observation there, which is the honest
    // consequence of the CRDT server not understanding its own documents.
    check('9b. the CRDT server relays bytes and cannot know it was orphaned',
      stored?.orphaned === false, `orphaned=${stored?.orphaned}`);
  }
  check('9c. the quote survives so the thread can still say what it was about',
    stored?.quote === QUOTE, JSON.stringify(stored?.quote));

  // ---- deletion -----------------------------------------------------------

  const comments = stored.comments;
  await api(`/api/docs/${docId}/comments/${threadId}/${comments[0].id}`, { method: 'DELETE' });
  const partial = await api(`/api/docs/${docId}/comments`);
  check('10. deleting one comment leaves the thread',
    partial.body.threads.find((t) => t.id === threadId)?.comments.length === comments.length - 1);

  await api(`/api/docs/${docId}/comments/${threadId}`, { method: 'DELETE' });
  const gone = await api(`/api/docs/${docId}/comments`);
  check('11. deleting the thread removes it',
    !gone.body.threads.some((t) => t.id === threadId));

  // ---- a second client sees them ------------------------------------------

  const fresh = await api(`/api/docs/${docId}/comments`, {
    method: 'POST',
    body: {
      anchor: alice.createAnchor(0, 2), quote: alice.getText().slice(0, 2),
      body: 'second thread', authorName: 'Alice',
    },
  });
  check('12. a new thread can be opened after all that', fresh.status === 201);

  const bob = await connect('bob');
  await sleep(300);
  const bobSees = await api(`/api/docs/${docId}/comments`);
  bob.trackAnchors(bobSees.body.threads.map((t) => ({ id: t.id, anchor: t.anchor })));
  const bobAt = bob.resolvedAnchors().get(fresh.body.thread.id);
  const aliceTracked = await track();
  const aliceAt = alice.resolvedAnchors().get(fresh.body.thread.id);
  check('13. a second client resolves the same anchor to the same place',
    !!bobAt && !!aliceAt && bobAt.from === aliceAt.from && bobAt.to === aliceAt.to,
    `bob=${JSON.stringify(bobAt)} alice=${JSON.stringify(aliceAt)}`);
  check('13b. and to the same text',
    bob.getText().slice(bobAt.from, bobAt.to) === alice.getText().slice(aliceAt.from, aliceAt.to),
    JSON.stringify(bob.getText().slice(bobAt.from, bobAt.to)));
  check('13c. both clients agree the thread list is the same length',
    aliceTracked.length === bobSees.body.threads.length);

  alice.destroy();
  bob.destroy();
  server.kill();
  await sleep(300);
  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);
}

// OT clients build operations by hand -- there is no Y.Text to poke. Both are
// whole-document operations because this implementation has no implicit
// trailing retain.
function otInsert(client, at, text) {
  return new RichTextOperation()
    .retain(at).insert(text).retain(client.doc.length - at);
}

function otDelete(client, at, length) {
  return new RichTextOperation()
    .retain(at).delete(length).retain(client.doc.length - at - length);
}

console.log('\nComments, both engines\n');
for (const spec of ENGINES) await run(spec);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
