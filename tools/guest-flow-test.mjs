/**
 * The product's access rule, end to end:
 *
 *   ANYONE MAY WRITE.  ONLY AN ACCOUNT MAY SHARE.
 *
 * Which means a guest can create a document and type in it with no sign-up at
 * all, and the account is asked for at exactly one moment -- sharing -- because
 * that is the first operation that needs a person on both ends. The bridge
 * between the two halves is CLAIM: sign in, take ownership of what you already
 * wrote, then share it.
 *
 * The assertions worth reading are the ones about what claiming COSTS, because
 * they are the ones a UI walkthrough would never catch:
 *
 *   - the guest's text survives the claim (it is the same document, not a copy)
 *   - a second guest editing the same unowned document is DISCONNECTED by it,
 *     with a reason that tells them what happened
 *   - a second claim loses, with 409 rather than silently stealing ownership
 *
 * Spawns its own server on port 8105 with its own databases, so it runs
 * alongside the dev servers and never touches real data.
 *
 *   node tools/guest-flow-test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { schema, accountsSchema } = scratchSchemas('guest');
const PORT = 8105;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);

function boot() {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: PORT, engine: 'yjs' }),
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
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

async function api(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

/**
 * A connected client, plus whatever the server said in HELLO.
 *
 * `connect()` resolves on SYNC, and a refused connection never syncs -- it is
 * closed with 1008 before any document frame arrives. Awaiting it alone would
 * therefore hang forever on exactly the case this file exists to check, so the
 * refusal is raced against it.
 */
async function connect(docId, { token, clientId } = {}) {
  const c = new YjsSync({ url: WS, docId, clientId: clientId ?? 'guest', token });
  const seen = { hello: null, refused: null };
  c.on('hello', (h) => { seen.hello = h; });
  const refused = new Promise((resolve) => c.on('refused', (r) => { seen.refused = r; resolve(); }));
  await Promise.race([c.connect(), refused]);
  await sleep(120);
  return { c, seen };
}

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 90_000);
guard.unref?.();

console.log('\nGuest documents, and the sign-in wall at sharing\n');
const server = await boot();

// ---- 1. a guest creates a document and writes in it -------------------------

const made = await api('/api/docs', { method: 'POST', body: { title: 'Shopping list' } });
const docId = made.body.doc?.docId;
check('1. a signed-out visitor can create a document', made.status === 201, docId);
check('1b. it is unowned, which is what makes it open to anyone',
  made.body.doc?.ownerId == null && made.body.doc?.unowned === true);

const guest = await connect(docId, { clientId: 'guest-a' });
check('1c. the guest may open it over the socket', guest.seen.hello?.role === 'editor');
check('1d. HELLO says the document is unowned, so the UI can offer to claim it',
  guest.seen.hello?.unowned === true);

guest.c.text.insert(0, 'milk, eggs, ');
await sleep(200);
check('1e. the guest can type in it', guest.c.getText() === 'milk, eggs, ');

// A second guest, on the same link. This is what "unowned" means in practice,
// and it is also the person the claim below is about to inconvenience.
const other = await connect(docId, { clientId: 'guest-b' });
other.c.text.insert(other.c.getText().length, 'bread');
await sleep(200);
check('1f. a second anonymous visitor edits the same document',
  guest.c.getText() === 'milk, eggs, bread', guest.c.getText());

// ---- 2. sharing is where the account becomes unavoidable --------------------

const shareAnon = await api(`/api/docs/${docId}/share`, {
  method: 'POST', body: { email: 'nobody@example.com', role: 'editor' },
});
check('2. a signed-out visitor cannot share it', shareAnon.status === 401);
check('2b. and is told to sign in rather than "only the owner can share"',
  /sign in/i.test(shareAnon.body?.error ?? ''), shareAnon.body?.error);
check('2c. the refusal marks the document as claimable, which is the way out',
  shareAnon.body?.claimable === true);

const claimAnon = await api(`/api/docs/${docId}/claim`, { method: 'POST' });
check('2d. claiming without an account is refused too', claimAnon.status === 401);

// ---- 3. sign in, claim, share -----------------------------------------------

const ada = await api('/api/auth/signup', {
  method: 'POST', body: { email: 'ada@example.com', name: 'Ada', password: 'lovelace1' },
});
const adaToken = ada.body.token;

const stillNotOwner = await api(`/api/docs/${docId}/share`, {
  method: 'POST', token: adaToken, body: { email: 'ada@example.com', role: 'editor' },
});
check('3. signed in but not yet the owner, sharing still refuses',
  stillNotOwner.status === 409 && /claim/i.test(stillNotOwner.body?.error ?? ''),
  stillNotOwner.body?.error);

const claimed = await api(`/api/docs/${docId}/claim`, { method: 'POST', token: adaToken });
check('3b. claiming works and returns ownership',
  claimed.status === 200 && claimed.body.doc?.role === 'owner');

const after = await api(`/api/docs/${docId}`, { token: adaToken });
check('3c. the document is the SAME one -- title and id survive the claim',
  after.body.doc?.docId === docId && after.body.doc?.title === 'Shopping list');

// The text is the real question. A claim that quietly started a new document
// would pass every check above and lose the user's work.
const owner = await connect(docId, { token: adaToken, clientId: 'ada' });
check('3d. and the guest\'s text survives it',
  owner.c.getText() === 'milk, eggs, bread', owner.c.getText());
check('3e. the claimer connects as owner', owner.seen.hello?.role === 'owner');
check('3f. HELLO no longer offers to claim it', owner.seen.hello?.unowned === false);

const bob = await api('/api/auth/signup', {
  method: 'POST', body: { email: 'bob@example.com', name: 'Bob', password: 'password1' },
});
const shared = await api(`/api/docs/${docId}/share`, {
  method: 'POST', token: adaToken, body: { email: 'bob@example.com', role: 'editor' },
});
check('3g. now it can be shared', shared.status === 200 && shared.body.collaborator?.role === 'editor');

const bobsView = await connect(docId, { token: bob.body.token, clientId: 'bob' });
check('3h. and the person it was shared with can open it',
  bobsView.seen.hello?.role === 'editor' && bobsView.seen.refused === null);
check('3i. receiving a share requires an account -- there is no anonymous grant',
  (await api(`/api/docs/${docId}/share`, {
    method: 'POST', token: adaToken, body: { email: 'stranger@example.com', role: 'editor' },
  })).status === 404);

// ---- 4. what the claim cost the other guest ---------------------------------

await sleep(300);
check('4. the anonymous editor still connected was disconnected by the claim',
  other.seen.refused !== null, other.seen.refused ?? 'still connected');
check('4b. and told what actually happened, not "access removed"',
  /owner/i.test(other.seen.refused ?? '') && /sign in/i.test(other.seen.refused ?? ''),
  other.seen.refused);

const anonAgain = await connect(docId, { clientId: 'guest-c' });
check('4c. a new anonymous visitor is now refused outright',
  anonAgain.seen.refused !== null && anonAgain.seen.hello === null);

// ---- 5. two people claiming the same document -------------------------------

const race = await api('/api/docs', { method: 'POST', body: { title: 'Contested' } });
const raceId = race.body.doc.docId;
const first = await api(`/api/docs/${raceId}/claim`, { method: 'POST', token: adaToken });
const second = await api(`/api/docs/${raceId}/claim`, { method: 'POST', token: bob.body.token });
check('5. the first claim wins', first.status === 200);
check('5b. the second gets 409, not a silent transfer of ownership',
  second.status === 409, `${second.status} ${second.body?.error ?? ''}`);
// `role` is a sibling of `doc` on this endpoint, not a field inside it.
const raceOwner = await api(`/api/docs/${raceId}`, { token: adaToken });
const raceLoser = await api(`/api/docs/${raceId}`, { token: bob.body.token });
check('5c. and the owner is unchanged',
  raceOwner.role === 'owner' || raceOwner.body?.role === 'owner', raceOwner.body?.role);
check('5c-ii. the loser of the race has no access at all',
  raceLoser.status === 403, String(raceLoser.status));
check('5d. claiming your own document twice is a no-op, not an error',
  (await api(`/api/docs/${raceId}/claim`, { method: 'POST', token: adaToken })).status === 200);

for (const { c } of [guest, other, owner, bobsView, anonAgain]) c.destroy();
server.kill();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
