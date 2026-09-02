/**
 * End-to-end checks for authorship attribution (ADR-018), run against BOTH
 * engines.
 *
 * This harness exists to test a claim about COST, not only about behaviour.
 * The same assertions pass on both engines -- who wrote each character, across
 * concurrent typing, deletion, formatting and a restart -- and the reason they
 * pass is completely different on each side:
 *
 *   CRDT  the answer was already in the document. A Y.Text is a list of items
 *         each carrying the id of the client that inserted it, and it carries
 *         them because that is how the CRDT ORDERS concurrent inserts. Nothing
 *         was added to the write path and nothing new is persisted.
 *   OT    the answer had to be built. The server transforms an op, applies it,
 *         and the resulting text remembers nothing about who; so the engine
 *         keeps a parallel per-character author array, the log entry format
 *         gained a `by` field, and snapshots gained an author section.
 *
 * The check that makes the asymmetry visible rather than merely asserted is
 * the last one in section 5: text written into an OT document BEFORE the log
 * recorded authors replays as unattributed forever, because the information
 * was never written down. The equivalent CRDT case attributes correctly, since
 * there was never a moment when the CRDT was not recording it.
 *
 * Spawns its own servers on ports 8114/8115 with their own databases.
 *
 *   node tools/authorship-test.mjs
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
  { engine: 'yjs', port: 8114, Sync: YjsSync },
  { engine: 'ot', port: 8115, Sync: OTSync },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
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

/**
 * Expand authorship runs into one entry per character, so an assertion can be
 * written about a slice of the text rather than about the shape of the runs.
 * Run boundaries are an implementation detail -- two adjacent runs by the same
 * author and one merged run mean the same thing.
 */
const perChar = (runs) => runs.flatMap((r) => Array(r.length).fill(r.author));

/** Who wrote `text.slice(from, to)`, as a set of author ids. */
const authorsOf = (runs, from, to) => [...new Set(perChar(runs).slice(from, to))];

async function run({ engine, port, Sync }) {
  const base = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}`;
  const { schema, accountsSchema } = scratchSchemas('authors', engine);
  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);

  console.log(`\n--- ${engine.toUpperCase()} ---\n`);
  let server = await boot({ engine, port, schema, accountsSchema });

  let token = null;
  const call = async (pathname, { method = 'GET', body, as } = {}) => {
    const auth = as === undefined ? token : as;
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const open = async (docId, clientId, name, color) => {
    const client = new Sync({ url: wsUrl, docId, clientId, token });
    await client.connect();
    client.setLocalUser({ name, color });
    await sleep(300);
    return client;
  };

  // The only engine-specific lines here.
  const type = async (client, at, text) => {
    if (engine === 'yjs') client.text.insert(at, text);
    else {
      client.applyLocal(new RichTextOperation()
        .retain(at).insert(text).retain(client.doc.length - at));
    }
    await sleep(300);
  };
  const erase = async (client, at, n) => {
    if (engine === 'yjs') client.text.delete(at, n);
    else {
      client.applyLocal(new RichTextOperation()
        .retain(at).delete(n).retain(client.doc.length - at - n));
    }
    await sleep(300);
  };
  /** Bold a range: a RETAIN with attributes, under both engines. */
  const bold = async (client, at, n) => {
    if (engine === 'yjs') client.text.format(at, n, { b: true });
    else {
      client.applyLocal(new RichTextOperation()
        .retain(at).retain(n, { b: true }).retain(client.doc.length - at - n));
    }
    await sleep(300);
  };

  const ada = await call('/api/auth/signup', {
    method: 'POST', as: null,
    body: { email: `ada-${engine}@example.com`, name: 'Ada', password: 'hunter22' },
  });
  token = ada.body.token;

  const docId = (await call('/api/docs', { method: 'POST', body: { title: 'Joint' } }))
    .body.doc.docId;

  const authorship = async () => (await call(`/api/docs/${docId}/authorship`)).body;

  // ---- 1. two people, two runs ----------------------------------------------

  const a = await open(docId, 'ada', 'Ada', '#f87171');
  await type(a, 0, 'Hello ');
  const b = await open(docId, 'bob', 'Bob', '#60a5fa');
  await type(b, 6, 'world');

  let r = await authorship();
  check('1. the engine reports authorship at all', r.supported === true, JSON.stringify(r.engine));
  check('1b. the runs cover exactly the document, no more and no less',
    perChar(r.runs).length === 11, `${perChar(r.runs).length} for "Hello world"`);
  check('1c. "Hello " is attributed to one author, "world" to another',
    authorsOf(r.runs, 0, 6).length === 1 && authorsOf(r.runs, 6, 11).length === 1
    && authorsOf(r.runs, 0, 6)[0] !== authorsOf(r.runs, 6, 11)[0],
    JSON.stringify(r.runs));

  const adaId = authorsOf(r.runs, 0, 6)[0];
  const bobId = authorsOf(r.runs, 6, 11)[0];
  check('1d. both authors resolve to a name',
    r.identities[adaId]?.name === 'Ada' && r.identities[bobId]?.name === 'Bob',
    JSON.stringify(r.identities));
  check('1e. and to the colour they publish as a cursor',
    r.identities[adaId]?.color === '#f87171' && r.identities[bobId]?.color === '#60a5fa');

  // ---- 2. inserting INSIDE someone else's run splits it ---------------------

  await type(b, 5, ', cruel');
  r = await authorship();
  check('2. typing inside another author\'s text splits their run rather than claiming it',
    authorsOf(r.runs, 0, 5)[0] === adaId
    && authorsOf(r.runs, 5, 12)[0] === bobId
    && authorsOf(r.runs, 12, 13)[0] === adaId,
    JSON.stringify(r.runs));

  // ---- 3. deleting removes characters AND their attribution -----------------

  await erase(b, 5, 7);
  r = await authorship();
  check('3. deleting text removes exactly its authorship',
    perChar(r.runs).length === 11
    && authorsOf(r.runs, 0, 6)[0] === adaId
    && authorsOf(r.runs, 6, 11)[0] === bobId,
    JSON.stringify(r.runs));

  // ---- 4. formatting is not authorship --------------------------------------
  //
  // Bolding a word does not make you its author. Both engines carry formatting
  // as a RETAIN with attributes, so this is the same assertion on both -- and
  // it is the one an implementation is most likely to get wrong, because a
  // retain looks like a write.

  await bold(b, 0, 5);
  r = await authorship();
  check('4. formatting someone else\'s text does not reattribute it',
    authorsOf(r.runs, 0, 6)[0] === adaId, JSON.stringify(r.runs.slice(0, 2)));

  // ---- 5. durability --------------------------------------------------------

  a.destroy?.(); b.destroy?.();
  await sleep(300);
  server.kill();
  await sleep(500);
  server = await boot({ engine, port, schema, accountsSchema });

  r = await authorship();
  check('5. the runs survive a restart', perChar(r.runs).length === 11
    && authorsOf(r.runs, 0, 6).length === 1
    && authorsOf(r.runs, 0, 6)[0] !== authorsOf(r.runs, 6, 11)[0],
    JSON.stringify(r.runs));

  // The asymmetry, stated as an assertion rather than as prose.
  //
  // The CRDT's author map is PART OF THE DOCUMENT: it merges and persists like
  // the text, so a name written last week is still there today. OT documents
  // hold text and nothing else, so there is nowhere in the format to put one,
  // and the map is repopulated from presence -- which means after a restart,
  // with nobody connected, the runs are right and the names are gone.
  if (engine === 'yjs') {
    check('5b. CRDT: and so do the NAMES, because the map is part of the document',
      r.identities[adaId]?.name === 'Ada', JSON.stringify(r.identities));
  } else {
    check('5b. OT: the runs survive but the NAMES do not -- ADR-018, stated',
      Object.keys(r.identities).length === 0, JSON.stringify(r.identities));
  }

  // Reconnecting republishes presence, which is how OT gets its names back.
  const back = await open(docId, 'ada', 'Ada', '#f87171');
  r = await authorship();
  check('5c. reconnecting resolves the names again',
    r.identities[adaId]?.name === 'Ada', JSON.stringify(r.identities));
  back.destroy?.();
  await sleep(200);

  // ---- 6. a restore is an edit, and is attributed as one --------------------
  //
  // ADR-008 makes restoring a version an ordinary edit rather than a rewind.
  // Authorship has to agree with that: every character in a restored document
  // was just inserted, so it belongs to whoever restored it.

  const carol = await open(docId, 'carol', 'Carol', '#34d399');
  await call(`/api/docs/${docId}/checkpoints`, { method: 'POST', body: { label: 'before' } });
  const hist = await call(`/api/docs/${docId}/history`);
  const target = hist.body.checkpoints?.find((c) => c.label === 'before');
  check('6. a checkpoint was taken to restore to', !!target,
    JSON.stringify(hist.body.checkpoints?.map((c) => c.label)));

  if (target) {
    // Type something after the checkpoint, so restoring has work to undo.
    await type(carol, 0, 'DRAFT ');
    await call(`/api/docs/${docId}/restore`, { method: 'POST', body: { seq: target.seq } });
    await sleep(500);
    r = await authorship();
    // Every character in a restored document was just inserted by the restore,
    // so all of it belongs to whoever restored it -- one author, not the
    // original mix of two.
    check('6b. after a restore the whole document has a single author',
      new Set(perChar(r.runs)).size === 1, JSON.stringify(r.runs));
    check('6c. and it is not the person who originally typed it',
      !perChar(r.runs).includes(bobId), JSON.stringify(r.runs));
  }
  carol.destroy?.();
  await sleep(200);

  // ---- 7. access ------------------------------------------------------------

  const stranger = await call('/api/auth/signup', {
    method: 'POST', as: null,
    body: { email: `eve-${engine}@example.com`, name: 'Eve', password: 'hunter22' },
  });
  check('7. authorship is refused to someone with no role on the document',
    (await call(`/api/docs/${docId}/authorship`, { as: stranger.body.token })).status === 403);

  server.kill();
  await sleep(200);
}

console.log('\nAuthorship attribution, both engines\n');
for (const e of ENGINES) await run(e);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
