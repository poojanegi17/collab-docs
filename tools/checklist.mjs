/**
 * Runs the definition-of-done against a live server.
 *
 * Reuses the real YjsSync client rather than a mock, so this exercises the
 * actual wire protocol, the actual handshake and the actual reconnect path.
 * Start the server first:  npm run dev:server
 */
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';

const URL_ = process.env.WS_URL ?? 'ws://localhost:8080';
const DOC = 'checklist-' + Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
}

async function client(id, docId = DOC) {
  const c = new YjsSync({ url: URL_, docId, clientId: id });
  await c.connect();
  return c;
}

/** Poll until all clients agree, or give up. */
async function converged(clients, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const texts = clients.map((c) => c.text.toString());
    if (texts.every((t) => t === texts[0])) return texts[0];
    await sleep(50);
  }
  return null;
}

/** Poll until all clients agree on TEXT AND FORMATTING, or give up. */
async function convergedRich(clients, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const docs = clients.map((c) => c.getRichText().toDebugString());
    if (docs.every((d) => d === docs[0])) return docs[0];
    await sleep(50);
  }
  return null;
}

console.log(`\nDone checklist  (doc=${DOC})\n`);

// ---- 1. concurrent edits at the same offset converge, nothing is lost -------
{
  const [a, b, c] = await Promise.all([client('alice'), client('bob'), client('carol')]);
  a.text.insert(0, 'hello world');
  await converged([a, b, c]);

  // Both type at offset 5 in the same tick -- the classic conflict.
  a.text.insert(5, 'AAA');
  b.text.insert(5, 'BBB');
  const text = await converged([a, b, c]);

  check('1. concurrent same-offset edits converge', text !== null,
    text === null ? 'clients diverged' : JSON.stringify(text));
  check('1b. no characters lost', !!text && text.includes('AAA') && text.includes('BBB'), text ?? '');
  check('1c. third client agrees', c.text.toString() === text);

  for (const cl of [a, b, c]) cl.destroy();
}

// ---- 2. offline editing, then reconnect and converge ------------------------
{
  const doc = DOC + '-offline';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.text.insert(0, 'base.');
  await converged([a, b]);

  a.disconnect();
  await sleep(100);
  for (let i = 0; i < 20; i++) a.text.insert(a.text.length, `<${i}>`);
  b.text.insert(b.text.length, ' [bob edited while alice was away]');
  await sleep(200);

  check('2. offline client kept editing', a.text.toString().includes('<19>'));
  check('2b. peers diverged while offline', a.text.toString() !== b.text.toString());

  await a.connect();
  const merged = await converged([a, b], 5000);

  check('3. reconnect converges', merged !== null);
  const allOffline = merged && Array.from({ length: 20 }, (_, i) => `<${i}>`).every((s) => merged.includes(s));
  check('3b. all 20 offline edits landed', !!allOffline);
  check('3c. peer edits survived', !!merged && merged.includes('[bob edited while alice was away]'));

  a.destroy(); b.destroy();
}

// ---- 3. late joiner gets state without replaying the log --------------------
{
  const doc = DOC + '-late';
  const a = await client('alice', doc);
  // Big enough that "we resent the whole document" would be obvious.
  for (let i = 0; i < 200; i++) a.text.insert(a.text.length, 'x'.repeat(25));
  await sleep(600);

  const late = await client('latecomer', doc);
  await converged([a, late]);
  check('4. late joiner receives full document', late.text.length === 5000, `${late.text.length} chars`);

  // Delta sync: a client that is already up to date should receive almost
  // nothing on reconnect, regardless of document size.
  const before = late.stats.bytesRecv;
  late.disconnect();
  await sleep(300);
  await late.connect();
  await sleep(200);
  const resyncBytes = late.stats.bytesRecv - before;
  const fullDocBytes = late.text.length;
  check('5. up-to-date resync is proportional to change, not doc size',
    resyncBytes * 10 < fullDocBytes,
    `${resyncBytes}B resync vs ${fullDocBytes}B document (${(fullDocBytes / resyncBytes).toFixed(0)}x smaller)`);

  a.destroy(); late.destroy();
}

// ---- 4. presence appears and is cleaned up on disconnect --------------------
{
  const doc = DOC + '-presence';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.setLocalUser({ name: 'Alice', color: '#e11' });
  b.setLocalUser({ name: 'Bob', color: '#11e' });
  a.setLocalCursor({ anchor: 0, head: 0 });
  await sleep(300);

  check('6. peer cursors visible', a.peers.has('bob') && b.peers.has('alice'),
    `alice sees [${[...a.peers.keys()]}]`);

  b.destroy();
  await sleep(400);
  check('7. cursor removed on disconnect', !a.peers.has('bob'));

  a.destroy();
}

// ---- 7b. deletions reach other clients LIVE --------------------------------
//
// A regression test for a bug that hid here for a long time. The server used
// to decide whether an update was worth broadcasting by comparing state
// vectors before and after applying it. A Yjs deletion creates no items -- it
// marks existing ones deleted, in the delete set, which the state vector does
// not describe -- so deletion-only updates looked redundant and were dropped.
// Deleting text simply did not reach the room until someone reconnected.
//
// Nothing caught it because every check above this line only ever INSERTED,
// and because a reconnect heals it: STEP2 sends a full update, delete set
// included. Hence the explicit "without reconnecting" below.
{
  const doc = DOC + '-delete';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.text.insert(0, 'the quick brown fox');
  await converged([a, b]);

  a.text.delete(4, 6);                   // remove "quick "
  const text = await converged([a, b]);
  check('7b. a deletion reaches peers without reconnecting',
    text === 'the brown fox', JSON.stringify(text));

  // Concurrent deletes of overlapping ranges, still with no reconnect.
  a.text.delete(0, 4);                   // "the "
  b.text.delete(6, 4);                   // " fox" as bob sees it
  check('7c. concurrent deletions converge',
    (await converged([a, b])) !== null, a.getText());

  a.destroy(); b.destroy();
}

// ---- 8. rich text ----------------------------------------------------------
//
// Formatting must converge the same way text does, and it is checked
// separately from text on purpose: the failure worth catching is two replicas
// agreeing on every character while disagreeing about which of them are bold.
// A harness comparing strings would call that a pass.
//
// Note what is absent here that the OT version needs: no revision, no ack, no
// server arbitration. Both replicas write locally and the updates merge.
{
  const doc = DOC + '-rich';
  const [a, b] = await Promise.all([client('alice', doc), client('bob', doc)]);
  a.text.insert(0, 'the quick brown fox');
  await converged([a, b]);

  // Concurrent, disjoint ranges. Both marks must survive.
  a.format(4, 9, { bold: true });
  b.format(10, 15, { italic: true });
  const marks = await convergedRich([a, b]);

  check('8. formatting converges', marks !== null, marks ?? 'diverged');
  check('8b. text untouched, both marks present',
    a.text.toString() === 'the quick brown fox' &&
    a.getRichText().runs.some((r) => r.attributes?.bold) &&
    a.getRichText().runs.some((r) => r.attributes?.italic));

  // The conflict plain text cannot express: one range, opposed changes. No
  // server decides this one -- Yjs resolves it from its own metadata.
  a.format(4, 9, { bold: null });
  b.format(4, 9, { bold: true, underline: true });
  check('8c. conflicting attribute changes converge',
    (await convergedRich([a, b])) !== null, a.getRichText().toDebugString());

  // Typing next to formatted text inherits its marks. This exercises the
  // helper the CodeMirror binding uses for exactly that.
  a.format(0, 3, { header: 1 });
  await convergedRich([a, b]);
  check('8d. insertion point inherits formatting from the character before it',
    a.getRichText().attributesAt(3)?.header === 1 &&
    a.getRichText().attributesAt(0) === undefined,
    JSON.stringify(a.getRichText().attributesAt(3) ?? null));

  a.destroy(); b.destroy();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
