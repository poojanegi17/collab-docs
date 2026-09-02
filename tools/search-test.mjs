/**
 * End-to-end checks for full-text document search (ADR-017), run against
 * BOTH engines.
 *
 * Running it twice is the entire argument. A document's text lives in
 * engine-specific bytes -- a Y.Doc update log under the CRDT, a sequence of
 * transformed operations under OT -- and neither is something a query can be
 * run against. Search therefore reads a PROJECTION: plaintext pushed out
 * through `DocEngine.readDocument()`, the one seam method that speaks content,
 * and indexed by the storage layer, which never learns which engine produced
 * it.
 *
 * So the claim under test is that identical assertions pass on both engines
 * with no engine-specific code in this file beyond the two lines that know how
 * to type a character. If that holds, the projection really is engine-agnostic
 * rather than a CRDT feature OT happens to tolerate.
 *
 * The checks worth reading are the ones about what search must NOT find:
 *
 *   - a word in someone else's document, which is the whole risk of building
 *     an index that crosses documents
 *   - a document that has been deleted, and again after it is restored
 *   - text in a tab that was deleted on its own, whose content log survives
 *     precisely so it can be recovered (ADR-014) and would otherwise stay
 *     findable after it stopped being anywhere you could open
 *   - anything at all, for a query that is search-engine syntax rather than
 *     words
 *
 * Runs with SEARCH_INDEX_WINDOW_MS=0 so the debounce collapses and the
 * assertions need no sleeps of their own beyond the ones typing already has.
 * That the window is configurable at all is why this harness is not flaky.
 *
 * Spawns its own servers on ports 8112/8113 with their own databases, so it
 * runs alongside the dev servers and never touches real data.
 *
 *   node tools/search-test.mjs
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
  { engine: 'yjs', port: 8112, Sync: YjsSync },
  { engine: 'ot', port: 8113, Sync: OTSync },
];

/** The delimiters the server wraps a match in. Markup would be a renderer's problem. */
const M0 = String.fromCharCode(2);
const M1 = String.fromCharCode(3);

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
      // Collapse the debounce. See the header.
      SEARCH_INDEX_WINDOW_MS: '0',
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
  const { schema, accountsSchema } = scratchSchemas('search', engine);
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

  const search = async (q, as) =>
    (await call(`/api/docs/search?q=${encodeURIComponent(q)}`, { as })).body.results ?? [];
  const ids = (results) => results.map((r) => r.docId);

  /*
   * Search until the projection catches up, or give up after `ms`.
   *
   * Indexing is debounced (ADR-017) and the write path behind it is now four
   * or five Postgres round trips: append, touch, the compaction check, then
   * the index write itself. Against a database in another region those do not
   * fit inside the 300ms `type()` already sleeps, and a fixed wait fails on
   * the tab checks about half the time.
   *
   * A longer fixed sleep would paper over it at the cost of making every run
   * slower and leaving the flake in place on a slower link. Waiting for the
   * CONDITION is both faster in the normal case and actually correct: the
   * assertion is that the text becomes findable, not that it becomes findable
   * within one arbitrary sleep.
   *
   * Only for assertions that expect a hit. A check that something is NOT
   * findable cannot poll -- there is nothing to wait for -- so those keep
   * using `search` directly and rely on the ordering around them.
   */
  const searchUntil = async (q, want, { ms = 15000, as } = {}) => {
    const deadline = Date.now() + ms;
    let results = await search(q, as);
    while (!want(results) && Date.now() < deadline) {
      await sleep(250);
      results = await search(q, as);
    }
    return results;
  };

  const open = async (docId, clientId, useToken = token) => {
    const client = new Sync({ url: wsUrl, docId, clientId, token: useToken });
    await client.connect();
    await sleep(250);
    return client;
  };

  // The only engine-specific lines in this file. Both engines expose the same
  // two write paths; only the CRDT has a Y.Text.
  const type = async (client, at, text) => {
    if (engine === 'yjs') client.text.insert(at, text);
    else {
      client.applyLocal(new RichTextOperation()
        .retain(at).insert(text).retain(client.doc.length - at));
    }
    await sleep(300);
  };

  // ---- two people, three documents ------------------------------------------

  const ada = await call('/api/auth/signup', {
    method: 'POST', as: null,
    body: { email: `ada-${engine}@example.com`, name: 'Ada', password: 'hunter22' },
  });
  token = ada.body.token;
  const bob = await call('/api/auth/signup', {
    method: 'POST', as: null,
    body: { email: `bob-${engine}@example.com`, name: 'Bob', password: 'hunter22' },
  });
  const bobToken = bob.body.token;

  const mine = (await call('/api/docs', { method: 'POST', body: { title: 'Roman Engineering' } }))
    .body.doc.docId;
  const other = (await call('/api/docs', { method: 'POST', body: { title: 'Grocery List' } }))
    .body.doc.docId;
  const theirs = (await call('/api/docs', {
    method: 'POST', as: bobToken, body: { title: 'Private Notes' },
  })).body.doc.docId;

  const c1 = await open(mine, 'ada');
  await type(c1, 0, 'The aqueduct at Segovia carried water for nineteen centuries.');
  const c2 = await open(other, 'ada2');
  await type(c2, 0, 'milk, eggs, bread');
  const c3 = await open(theirs, 'bob', bobToken);
  await type(c3, 0, 'a private aqueduct of my very own');

  // ---- 1. the thing that could not be done before ---------------------------

  const hit = await search('Segovia');
  check('1. a document is found by a word that appears only in its TEXT',
    ids(hit).includes(mine), JSON.stringify(ids(hit)));
  check('1b. and the result says the match was in the body, not the title',
    hit[0]?.matchedIn.includes('body') && !hit[0]?.matchedIn.includes('title'),
    JSON.stringify(hit[0]?.matchedIn));
  check('1c. it comes back with a snippet, with the match delimited',
    typeof hit[0]?.snippet === 'string'
    && hit[0].snippet.includes(M0 + 'Segovia' + M1),
    JSON.stringify(hit[0]?.snippet));
  check('1d. the snippet is an EXCERPT, not the whole document',
    (hit[0]?.snippet ?? '').length < 200);

  // ---- 2. the risk of an index that crosses documents -----------------------

  const shared = await search('aqueduct');
  check('2. searching finds MY document containing the word', ids(shared).includes(mine));
  check("2b. and NOT another account's, which contains it too",
    !ids(shared).includes(theirs), JSON.stringify(ids(shared)));

  const bobSees = ids(await search('aqueduct', bobToken));
  check("2c. from bob's side: his document, never Ada's",
    bobSees.includes(theirs) && !bobSees.includes(mine), JSON.stringify(bobSees));

  check('2d. search needs a session at all',
    (await call('/api/docs/search?q=aqueduct', { as: null })).status === 401);

  // ---- 3. titles and bodies are different sources ---------------------------

  const byTitle = await search('Grocery');
  check('3. a title still matches, from the docs table rather than the index',
    ids(byTitle).includes(other) && byTitle[0].matchedIn.includes('title'));

  const both = await search('Roman');
  check('3b. a word in the title alone matches once, not twice',
    both.filter((r) => r.docId === mine).length === 1);

  // A rename does not go through the write path that refreshes the index. If
  // titles were indexed rather than read live, this would fail.
  await call(`/api/docs/${other}`, { method: 'PATCH', body: { title: 'Shopping' } });
  check('3c. a renamed document is findable by its NEW title immediately',
    ids(await search('Shopping')).includes(other));
  check('3d. and not by the old one',
    !ids(await search('Grocery')).includes(other));

  // ---- 4. the index tracks edits --------------------------------------------

  await type(c1, 0, 'Vitruvius wrote about it. ');
  check('4. a word typed after the first index is findable',
    ids(await searchUntil('Vitruvius', (r) => ids(r).includes(mine))).includes(mine));

  // ---- 5. tabs (ADR-014) ----------------------------------------------------

  const madeTab = await call(`/api/docs/${mine}/tabs`, {
    method: 'POST', body: { title: 'Sources' },
  });
  const tab2 = madeTab.body.tab.tabId;
  const c4 = await open(tab2, 'ada3');
  await type(c4, 0, 'Frontinus, De aquaeductu, 97 AD');

  const inTab = await searchUntil('Frontinus', (r) => ids(r).includes(mine));
  check('5. text inside a TAB is findable', ids(inTab).includes(mine),
    JSON.stringify(ids(inTab)));
  check('5b. the result points at the document and names the tab to open',
    inTab[0]?.docId === mine && inTab[0]?.tabId === tab2,
    JSON.stringify({ docId: inTab[0]?.docId, tabId: inTab[0]?.tabId }));

  c4.destroy?.();
  await sleep(200);
  await call(`/api/docs/${mine}/tabs/${encodeURIComponent(tab2)}`, { method: 'DELETE' });
  check("5c. a deleted tab's text stops being findable, though its log survives",
    !ids(await search('Frontinus')).includes(mine));

  // ---- 6. deletion and restore ----------------------------------------------

  await call(`/api/docs/${mine}`, { method: 'DELETE' });
  check('6. a deleted document leaves the results',
    !ids(await search('Segovia')).includes(mine));

  await call(`/api/docs/${mine}/undelete`, { method: 'POST' });
  check('6b. restoring it makes it findable again, with no reindexing',
    ids(await search('Segovia')).includes(mine));

  // ---- 7. the query is not a language ---------------------------------------
  //
  // Every one of these is valid `to_tsquery` syntax, a `to_tsquery` syntax
  // ERROR, or a LIKE wildcard. Reaching the query parser unescaped they
  // variously 500, return the whole account, or silently mean something the
  // person did not type.

  for (const [label, q] of [
    ['C++ (draft)', 'C++ (draft)'],
    ['an unbalanced quote', 'say "hi'],
    ['a bare operator', 'AND'],
    ['a column filter', 'body:secret'],
    ['a NEAR expression', 'NEAR(a b, 2)'],
    ['a LIKE wildcard', '%'],
    ['an FTS prefix star', '*'],
    ['nothing but punctuation', '!!!'],
  ]) {
    const r = await call(`/api/docs/search?q=${encodeURIComponent(q)}`);
    check(`7. ${label} is answered, not crashed on`, r.status === 200,
      `${r.status} ${JSON.stringify(q)}`);
  }

  check('7b. a LIKE wildcard matches literally rather than everything',
    (await search('%')).length === 0);
  check('7c. an empty query returns nothing rather than the whole account',
    (await search('   ')).length === 0);

  // ---- 8. the index is durable ----------------------------------------------

  c1.destroy?.(); c2.destroy?.(); c3.destroy?.();
  await sleep(200);
  server.kill();
  await sleep(500);
  server = await boot({ engine, port, schema, accountsSchema });

  check('8. the index survives a restart -- it is a table, not a cache',
    ids(await search('Segovia')).includes(mine));
  check('8b. including text typed after the first index',
    ids(await search('Vitruvius')).includes(mine));

  server.kill();
  await sleep(200);
}

console.log('\nFull-text search, both engines\n');
for (const e of ENGINES) await run(e);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
