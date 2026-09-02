/**
 * End-to-end checks for document tabs (ADR-014) and the shared task list
 * (ADR-015), run against BOTH engines.
 *
 * Running it twice is the point, as with comments -- but the expected result
 * is the opposite one. Comments needed a different mechanism per engine and
 * the test proves the seam hides it. These two need NO engine mechanism at
 * all, and the test proves that claim by asserting the same behaviour on both
 * without a single engine-specific line:
 *
 *   tabs    a tab is a document, so it gets its own room, its own log and its
 *           own text. Typing in tab two must not appear in tab one, and both
 *           must survive a server restart.
 *   tasks   metadata with a boolean. Two clients on two different TABS of the
 *           same document see one list, and either may tick anything on it.
 *
 * The checks worth reading are the ones about the boundary between them:
 *
 *   - a tab's content is invisible from its sibling
 *   - a tab inherits the document's sharing, with no ACL of its own
 *   - a tab does not appear on the documents page as a document
 *   - the task list is identical from every tab
 *   - a socket for a tab that was never minted is refused
 *
 * Spawns its own servers on ports 8110/8111 with their own databases, so it
 * runs alongside the dev servers and never touches real data.
 *
 *   node tools/tabs-tasks-test.mjs
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
  { engine: 'yjs', port: 8110, Sync: YjsSync },
  { engine: 'ot', port: 8111, Sync: OTSync },
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

/*
 * 180s -> 300s, and it is the storage that moved rather than this file.
 *
 * Measured at 174s standalone against a Neon in another region -- six seconds
 * of headroom, which any contention spends. In the full suite it tripped, and
 * it tripped AFTER the last assertion had already passed, so the run reported
 * a timeout with 74 green checks above it.
 *
 * Same reason api-test.mjs went from 90s to 180s and ot-checklist.mjs with
 * it: every one of the several hundred operations below is now a round trip
 * to a Postgres somewhere else (ADR-019). The bound is kept rather than
 * removed because this harness spawns a server and talks to a socket, and
 * both can hang rather than fail -- a guard that trips only when something is
 * genuinely stuck is worth having.
 */
const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 300_000);
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
  const { schema, accountsSchema } = scratchSchemas('tabs', engine);
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

  const open = async (docId, clientId, useToken = token) => {
    const client = new Sync({ url: wsUrl, docId, clientId, token: useToken });
    await client.connect();
    await sleep(250);
    return client;
  };

  // Both engines expose the same two write paths; only the CRDT has a Y.Text.
  // Same helper as tools/comments-test.mjs, for the same reason.
  const type = async (client, at, text) => {
    if (engine === 'yjs') client.text.insert(at, text);
    else {
      client.applyLocal(new RichTextOperation()
        .retain(at).insert(text).retain(client.doc.length - at));
    }
    await sleep(300);
  };

  // ---- a document starts as one implicit tab -------------------------------

  const ada = await call('/api/auth/signup', {
    method: 'POST',
    body: { email: `ada-${engine}@example.com`, name: 'Ada', password: 'hunter22' },
  });
  token = ada.body.token;

  const made = await call('/api/docs', { method: 'POST', body: { title: 'Plan' } });
  const docId = made.body.doc.docId;

  let r = await call(`/api/docs/${docId}/tabs`);
  check('a new document is one tab',
    r.body.tabs.length === 1 && r.body.tabs[0].tabId === docId,
    JSON.stringify(r.body.tabs));
  check('that tab is implicit until something is written down',
    r.body.tabs[0].implicit === true);
  // Not the document's title: the index sits under a header that already shows
  // that, and the two must not read as the same control twice.
  check('the implicit tab is named for what it is, not for the document',
    r.body.tabs[0].title === 'Tab 1', JSON.stringify(r.body.tabs[0].title));

  const first = await open(docId, 'ada');
  await type(first, 0, 'the first tab');

  // ---- adding a tab does not move what is already there --------------------

  r = await call(`/api/docs/${docId}/tabs`, { method: 'POST', body: { title: 'Research' } });
  const tab2 = r.body.tab.tabId;
  check('added a second tab', r.status === 201 && r.body.tabs.length === 2);
  check('the first tab is materialised in place',
    r.body.tabs[0].tabId === docId && r.body.tabs[0].implicit === false,
    JSON.stringify(r.body.tabs[0]));
  // Writing it down must not rename it under somebody who is looking at it.
  check('and keeps the name it already had',
    r.body.tabs[0].title === 'Tab 1', JSON.stringify(r.body.tabs[0].title));

  const rereader = await open(docId, 'reader');
  check('adding a tab did not touch the first tab text',
    rereader.getText() === 'the first tab', JSON.stringify(rereader.getText()));

  // ---- a tab is a document of its own --------------------------------------

  const second = await open(tab2, 'ada2');
  check('a new tab starts empty', second.getText() === '', JSON.stringify(second.getText()));

  await type(second, 0, 'notes in tab two');
  check('tab two has its own text', second.getText() === 'notes in tab two');
  check('tab one cannot see it',
    first.getText() === 'the first tab', JSON.stringify(first.getText()));

  // Presence is per room, which follows from tabs being documents rather than
  // being arranged for separately.
  check('people in different tabs are not peers of each other',
    ![...first.peers.keys()].some((k) => String(k).includes('ada2')),
    JSON.stringify([...first.peers.keys()]));

  // ---- the tab list is a fact about the document ---------------------------

  r = await call(`/api/docs/${tab2}/tabs`);
  check('asking with a tab id gives the document list', r.body.tabs.length === 2);

  r = await call(`/api/docs/${docId}/tabs/${encodeURIComponent(tab2)}`,
    { method: 'PATCH', body: { title: 'Sources', index: 0 } });
  check('rename and reorder in one call',
    r.body.tabs[0].tabId === tab2 && r.body.tabs[0].title === 'Sources',
    JSON.stringify(r.body.tabs.map((t) => t.title)));

  r = await call('/api/docs');
  const rows = r.body.docs.filter((d) => d.docId === docId);
  check('the document is listed once', rows.length === 1);
  check('a tab is not listed as a document of its own',
    !r.body.docs.some((d) => d.docId.includes('~')),
    JSON.stringify(r.body.docs.map((d) => d.docId)));
  check('the listing counts the tabs', rows[0]?.tabs === 2, JSON.stringify(rows[0]));

  // ---- sharing is inherited, never duplicated ------------------------------

  const grace = await call('/api/auth/signup', {
    method: 'POST',
    body: { email: `grace-${engine}@example.com`, name: 'Grace', password: 'hunter22' },
  });
  const graceToken = grace.body.token;

  r = await call(`/api/docs/${docId}/tabs`, { as: graceToken });
  check('a stranger cannot read the tab list', r.status === 403, JSON.stringify(r.body));

  const refused = new Sync({ url: wsUrl, docId: tab2, clientId: 'grace', token: graceToken });
  const refusal = new Promise((resolve) => refused.on('refused', () => resolve(true)));
  refused.connect();
  check('a stranger cannot open a tab', await Promise.race([refusal, sleep(2500)]) === true);
  refused.destroy();

  await call(`/api/docs/${docId}/share`, {
    method: 'POST', body: { email: `grace-${engine}@example.com`, role: 'editor' },
  });
  r = await call(`/api/docs/${docId}/tabs`, { as: graceToken });
  check('sharing the document shares every tab, with no per-tab grant',
    r.status === 200 && r.body.tabs.length === 2, JSON.stringify(r.body));

  const graceClient = await open(tab2, 'grace', graceToken);
  check('and the shared tab really opens',
    graceClient.getText() === 'notes in tab two', JSON.stringify(graceClient.getText()));

  // ---- an invented tab is refused ------------------------------------------

  const bogus = new Sync({ url: wsUrl, docId: `${docId}~nosuch`, clientId: 'ada3', token });
  const bogusRefused = new Promise((resolve) => bogus.on('refused', () => resolve(true)));
  bogus.connect();
  check('a tab id that was never minted is refused',
    await Promise.race([bogusRefused, sleep(2500)]) === true);
  bogus.destroy();

  // ---- tasks ---------------------------------------------------------------

  r = await call(`/api/docs/${docId}/tasks`, { method: 'POST', body: { body: 'Draft the intro' } });
  const taskId = r.body.task.id;
  check('added a task', r.status === 201 && r.body.task.done === false);
  check('the task records who added it', r.body.task.author.name === 'Ada',
    JSON.stringify(r.body.task.author));

  r = await call(`/api/docs/${tab2}/tasks`);
  check('the same list from another tab', r.body.tasks.length === 1,
    JSON.stringify(r.body.tasks));

  // The nudge reaches every room in the document, not only the one the change
  // was made from -- the only reason somebody reading tab two ever learns that
  // a task was ticked from tab one.
  const nudged = new Promise((resolve) => graceClient.on('tasks', () => resolve(true)));
  r = await call(`/api/docs/${docId}/tasks/${taskId}`,
    { method: 'PATCH', body: { done: true }, as: graceToken });
  check('anyone with edit access can tick it, not only the author',
    r.status === 200 && r.body.task.done === true, JSON.stringify(r.body));
  check('and it records who did', r.body.task.doneBy?.name === 'Grace',
    JSON.stringify(r.body.task.doneBy));
  check('every tab in the document is told the list changed',
    await Promise.race([nudged, sleep(2500)]) === true);

  r = await call(`/api/docs/${docId}/tasks/${taskId}`, { method: 'PATCH', body: { done: false } });
  check('unticking clears who did it',
    r.body.task.done === false && r.body.task.doneBy === null, JSON.stringify(r.body.task));

  // A viewer may read the list and not change it.
  await call(`/api/docs/${docId}/share`, {
    method: 'POST', body: { email: `grace-${engine}@example.com`, role: 'viewer' },
  });
  r = await call(`/api/docs/${docId}/tasks`, { as: graceToken });
  check('a viewer can read the list', r.status === 200 && r.body.tasks.length === 1);
  r = await call(`/api/docs/${docId}/tasks/${taskId}`,
    { method: 'PATCH', body: { done: true }, as: graceToken });
  check('a viewer cannot tick anything', r.status === 403, JSON.stringify(r.body));
  r = await call(`/api/docs/${docId}/tabs`,
    { method: 'POST', body: { title: 'Nope' }, as: graceToken });
  check('a viewer cannot add a tab', r.status === 403, JSON.stringify(r.body));

  // ---- durability ----------------------------------------------------------

  for (const c of [first, second, rereader, graceClient]) c.destroy();
  await sleep(300);

  server.kill('SIGKILL');
  await sleep(700);
  server = await boot({ engine, port, schema, accountsSchema });

  const afterOne = await open(docId, 'ada');
  const afterTwo = await open(tab2, 'ada2');
  check('tab one survived the restart',
    afterOne.getText() === 'the first tab', JSON.stringify(afterOne.getText()));
  check('tab two survived it too, in its own log',
    afterTwo.getText() === 'notes in tab two', JSON.stringify(afterTwo.getText()));

  r = await call(`/api/docs/${docId}/tabs`);
  check('the tab list survived, in order',
    r.body.tabs.length === 2 && r.body.tabs[0].title === 'Sources',
    JSON.stringify(r.body.tabs.map((t) => t.title)));
  r = await call(`/api/docs/${docId}/tasks`);
  check('so did the task list', r.body.tasks.length === 1);

  // ---- deleting ------------------------------------------------------------

  for (const c of [afterOne, afterTwo]) c.destroy();
  await sleep(300);

  r = await call(`/api/docs/${docId}/tabs/${encodeURIComponent(tab2)}`, { method: 'DELETE' });
  check('deleted a tab', r.status === 200 && r.body.tabs.length === 1, JSON.stringify(r.body));
  r = await call(`/api/docs/${docId}/tabs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
  check('the last tab cannot be deleted', r.status === 409, JSON.stringify(r.body));

  server.kill();
  await sleep(400);
}

for (const cfg of ENGINES) await run(cfg);

console.log(`\n${pass} passed, ${fail} failed\n`);
clearTimeout(guard);
process.exitCode = fail ? 1 : 0;
