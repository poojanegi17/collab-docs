/**
 * End-to-end checks for the OT engine, over the real wire protocol.
 *
 * `ot-properties.mjs` proves the transform function obeys TP1 in isolation.
 * This proves the *system* built on it converges: the server's history rebase,
 * the client's three-state machine, acks, and the interleaving of the two.
 *
 * Spawns its own server on port 8100 with ENGINE=ot, so it can run alongside
 * the CRDT dev server.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { RichTextOperation } from '../shared/ot/src/index.js';
import { OTSync } from '../frontend/src/sync/ot-sync.js';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { schema, accountsSchema } = scratchSchemas('otcheck');
const PORT = 8100;
const URL_ = `ws://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);

function boot() {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: PORT, engine: 'ot' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('    [server] ' + d));
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
  });
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** An operation that inserts `str` at `pos` in a document of length `len`. */
const insertAt = (len, pos, str) =>
  new RichTextOperation().retain(pos).insert(str).retain(len - pos);

/** An operation that deletes `n` characters at `pos`. */
const deleteAt = (len, pos, n) =>
  new RichTextOperation().retain(pos).delete(n).retain(len - pos - n);

async function client(id, docId) {
  const c = new OTSync({ url: URL_, docId, clientId: id });
  await c.connect();
  return c;
}

async function converged(clients, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const texts = clients.map((c) => c.getText());
    const settled = clients.every((c) => c.otState === 'synchronized');
    if (settled && texts.every((t) => t === texts[0])) return texts[0];
    await sleep(50);
  }
  return null;
}

/**
 * A wall-clock budget for the WHOLE harness, not for any one step -- which is
 * easy to misread, because it is written next to the helpers rather than next
 * to the sixteen assertions it actually covers.
 *
 * It was 60s, and 60s stopped being a limit and became a coin toss. Run on its
 * own this harness takes about forty seconds; run where `npm test` runs it,
 * after a dozen other harnesses have warmed the connection pools and loaded
 * the database, it has been measured at 62s wall -- passing with a couple of
 * seconds to spare against its own timer. Two seconds of margin against a
 * remote Postgres is not margin, and it fails as `TIMED OUT` with no clue as
 * to which step was slow, which is the least useful way a test can fail.
 *
 * Raised rather than removed: this harness boots servers, SIGKILLs one and
 * waits for convergence, and every one of those can hang rather than fail. A
 * bound that only trips when something is genuinely stuck is worth keeping.
 *
 * 180s because that is what most of the harnesses in this directory already
 * use. The 60s here was the outlier rather than the considered figure.
 */
const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

console.log('\nOT engine end-to-end\n');
let server = await boot();

// ---- 1. the classic conflict: two inserts at the same offset ---------------
{
  const doc = 'ot-conflict';
  const [a, b, c] = await Promise.all([client('alice', doc), client('bob', doc), client('carol', doc)]);

  a.applyLocal(insertAt(0, 0, 'hello world'));
  await converged([a, b, c]);

  // Both clients edit offset 5 with no knowledge of each other.
  a.applyLocal(insertAt(a.getText().length, 5, 'AAA'));
  b.applyLocal(insertAt(b.getText().length, 5, 'BBB'));

  const text = await converged([a, b, c]);
  check('1. concurrent same-offset inserts converge', text !== null,
    text === null ? `alice=${JSON.stringify(a.getText())} bob=${JSON.stringify(b.getText())}` : JSON.stringify(text));
  check('1b. no characters lost', !!text && text.includes('AAA') && text.includes('BBB'));
  check('1c. passive third client agrees', c.getText() === a.getText());

  for (const cl of [a, b, c]) cl.destroy();
}

// ---- 2. overlapping deletes -- the case people get wrong by hand -----------
{
  const doc = 'ot-deletes';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.applyLocal(insertAt(0, 0, 'the quick brown fox'));
  await converged([a, b]);

  // Both delete "quick " concurrently. It must be removed once, not twice.
  a.applyLocal(deleteAt(a.getText().length, 4, 6));
  b.applyLocal(deleteAt(b.getText().length, 4, 6));

  const text = await converged([a, b]);
  check('2. concurrent identical deletes remove text once', text === 'the brown fox', JSON.stringify(text));

  a.destroy(); b.destroy();
}

// ---- 3. delete overlapping an insert ---------------------------------------
{
  const doc = 'ot-overlap';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.applyLocal(insertAt(0, 0, '0123456789'));
  await converged([a, b]);

  a.applyLocal(deleteAt(a.getText().length, 2, 5));          // remove "23456"
  b.applyLocal(insertAt(b.getText().length, 4, 'XYZ'));      // insert inside that range

  const text = await converged([a, b]);
  check('3. insert inside a concurrently-deleted range survives',
    !!text && text.includes('XYZ'), JSON.stringify(text));

  a.destroy(); b.destroy();
}

// ---- 4. the buffer: many local edits while one op is in flight -------------
{
  const doc = 'ot-buffer';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);

  // Fire 50 edits in one tick. Only the first can be in flight; the other 49
  // must collapse into a single composed buffer.
  for (let i = 0; i < 50; i++) a.applyLocal(insertAt(a.getText().length, a.getText().length, `${i},`));

  const pendingStates = a.otState;
  check('4. extra local edits are buffered, not queued as N ops',
    pendingStates === 'awaitingWithBuffer', `state=${pendingStates}`);

  const text = await converged([a, b], 8000);
  check('4b. all 50 buffered edits land', !!text && text.startsWith('0,1,2,') && text.endsWith('49,'),
    text ? `${text.length} chars` : 'diverged');
  check('4c. peer agrees', b.getText() === a.getText());

  a.destroy(); b.destroy();
}

// ---- 5. sustained concurrent load ------------------------------------------
{
  const doc = 'ot-stress';
  const clients = await Promise.all(['alice', 'bob', 'carol'].map((id) => client(id, doc)));
  clients[0].applyLocal(insertAt(0, 0, 'x'.repeat(60)));
  await converged(clients);

  // 150 interleaved edits at random positions, no coordination.
  for (let i = 0; i < 150; i++) {
    const c = clients[i % clients.length];
    const pos = Math.floor(Math.random() * c.getText().length);
    if (i % 4 === 3 && c.getText().length > 10) c.applyLocal(deleteAt(c.getText().length, pos, 1));
    else c.applyLocal(insertAt(c.getText().length, pos, String(i % 10)));
    if (i % 10 === 0) await sleep(15); // let some acks through
  }

  const text = await converged(clients, 15000);
  check('5. 150 interleaved concurrent edits converge', text !== null,
    text === null ? clients.map((c) => c.getText().length).join(' vs ') : `${text.length} chars, all 3 agree`);

  for (const c of clients) c.destroy();
}

// ---- 6. late joiner and durability -----------------------------------------
{
  const doc = 'ot-durable';
  const a = await client('alice', doc);
  a.applyLocal(insertAt(0, 0, 'persisted under OT. '));
  await sleep(400);

  const late = await client('late', doc);
  await converged([a, late]);
  check('6. late joiner receives the document', late.getText() === a.getText(), JSON.stringify(late.getText()));

  const before = a.getText();
  server.kill('SIGKILL');
  await sleep(500);
  server = await boot();
  await Promise.all([a.connect(), late.connect()]);
  await sleep(800);

  check('7. document survives SIGKILL and restart', a.getText() === before, JSON.stringify(a.getText()));
  check('7b. both clients converged after restart', a.getText() === late.getText());

  a.destroy(); late.destroy();
}

// ---- 8. rich text over the real wire ---------------------------------------
//
// The property tests prove the transform obeys TP1 in isolation. This proves
// the SYSTEM carries attributes: through the wire encoding, the server's
// history rebase, the ack, and back out to a second client.
//
// Text convergence is checked separately from formatting convergence on
// purpose. The failure mode that matters here is the two agreeing on every
// character while disagreeing about which of them are bold -- if this file
// compared only strings, that bug would pass.
{
  const doc = 'ot-rich';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);

  a.applyLocal(insertAt(0, 0, 'the quick brown fox'));
  await converged([a, b]);

  // Concurrent, against the same base revision: alice bolds "quick", bob
  // italicises "brown". Disjoint ranges, so both must survive.
  a.format(4, 9, { bold: true });
  b.format(10, 15, { italic: true });
  await converged([a, b]);

  check('8. formatting survives the round trip',
    JSON.stringify(a.getRichText().toJSON()) === JSON.stringify(b.getRichText().toJSON()),
    a.getRichText().toDebugString());
  check('8b. both marks applied, text untouched',
    a.getText() === 'the quick brown fox' &&
    a.getRichText().runs.some((r) => r.attributes?.bold) &&
    a.getRichText().runs.some((r) => r.attributes?.italic));

  // Now the conflict plain text cannot express: same range, opposed changes.
  a.format(4, 9, { bold: null });
  b.format(4, 9, { bold: true, underline: true });
  await converged([a, b]);

  check('8c. conflicting attribute changes converge',
    a.getRichText().toDebugString() === b.getRichText().toDebugString(),
    a.getRichText().toDebugString());

  // Formatting concurrent with typing: the mark must land on the right
  // characters even though the offsets moved underneath it.
  a.applyLocal(insertAt(a.getText().length, 0, '>> '));
  b.format(0, 3, { header: 1 });
  await converged([a, b]);

  check('8d. formatting rebases over a concurrent insert',
    a.getRichText().toDebugString() === b.getRichText().toDebugString(),
    a.getRichText().toDebugString());

  a.destroy(); b.destroy();
}

server.kill();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
