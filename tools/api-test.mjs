/**
 * End-to-end checks for accounts, sharing and version history.
 *
 * Spawns its own server on port 8104 with its own databases, so it can run
 * alongside the dev servers and never touches real data.
 *
 * The checks worth reading are the negative ones. It is easy to build sharing
 * that looks right in the UI and enforces nothing: the interesting assertions
 * here are that a viewer's edit is REJECTED BY THE SERVER, and that revoking
 * access disconnects someone who is already connected rather than waiting for
 * them to reload.
 *
 *   node tools/api-test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { schema, accountsSchema } = scratchSchemas('api');
const PORT = 8104;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A clean slate: the scratch schema is dropped and recreated.
// See tools/test-schema.mjs.
await resetSchemas(schema, accountsSchema);

function boot() {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: { ...process.env, ...scratchEnv({ schema, accountsSchema, port: PORT, engine: 'yjs' }) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('    [server] ' + d));
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
  });
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  // Written synchronously. The timeout guard exits the process, and buffered
  // stdout is discarded on exit -- losing precisely the lines that say how far
  // the run got before it hung.
  fs.writeSync(1, "  " + (ok ? "PASS" : "FAIL") + "  " + name +
    (detail ? "  -- " + detail : "") + String.fromCharCode(10));
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
 * A wall-clock budget for the whole harness.
 *
 * Every one of the several hundred operations below costs a round trip to a
 * Postgres that may be in another region (ADR-019), so this budget is set by
 * the network rather than by the work. `ot-checklist.mjs` carries the same
 * note for the same reason.
 *
 * 180s to match most of this directory. Kept rather than removed because this
 * harness spawns a server and talks to a socket, and both can hang rather than
 * fail; a bound that trips only when something is genuinely stuck is worth
 * having. `guest-flow-test.mjs` is still at 90s and `toggle-test.mjs` at 45s,
 * so they are the next two to go the same way.
 */
const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

console.log('\nAccounts, sharing and history\n');
const server = await boot();

// ---- 1. accounts ------------------------------------------------------------
const ada = await api('/api/auth/signup', {
  method: 'POST', body: { email: 'ada@example.com', name: 'Ada', password: 'lovelace1' },
});
const bob = await api('/api/auth/signup', {
  method: 'POST', body: { email: 'bob@example.com', name: 'Bob', password: 'password1' },
});
check('1. signup returns a token and a user', ada.status === 201 && !!ada.body.token, ada.body.user?.name);
check('1b. the password never comes back', !JSON.stringify(ada.body).includes('lovelace1')
  && !('password_hash' in (ada.body.user ?? {})));

const dup = await api('/api/auth/signup', {
  method: 'POST', body: { email: 'ADA@example.com', password: 'something1' },
});
check('1c. emails are unique case-insensitively', dup.status === 400, dup.body?.error);

const weak = await api('/api/auth/signup', {
  method: 'POST', body: { email: 'x@example.com', password: 'short' },
});
check('1d. short passwords are rejected', weak.status === 400, weak.body?.error);

const badLogin = await api('/api/auth/login', {
  method: 'POST', body: { email: 'ada@example.com', password: 'wrong' },
});
const noUser = await api('/api/auth/login', {
  method: 'POST', body: { email: 'nobody@example.com', password: 'wrong' },
});
check('1e. wrong password and unknown account are indistinguishable',
  badLogin.status === 401 && noUser.status === 401
  && badLogin.body.error === noUser.body.error, badLogin.body.error);

const adaToken = ada.body.token;
const bobToken = bob.body.token;

const me = await api('/api/me', { token: adaToken });
check('1f. a token identifies its user', me.body.user?.email === 'ada@example.com');
check('1g. a garbage token does not', (await api('/api/me', { token: 'nope' })).status === 401);

// ---- 2. document lifecycle --------------------------------------------------
const created = await api('/api/docs', {
  method: 'POST', token: adaToken, body: { title: 'Design Notes' },
});
const docId = created.body.doc?.docId;
check('2. create returns an owned document', created.status === 201 && !!docId, docId);
check('2b. the id is readable and unique', /^design-notes-[0-9a-f]{8}$/.test(docId ?? ''), docId);

const second = await api('/api/docs', {
  method: 'POST', token: adaToken, body: { title: 'Design Notes' },
});
check('2c. the same title twice does not collide into one document',
  second.body.doc.docId !== docId, `${docId} vs ${second.body.doc.docId}`);

// Creating requires no account: the rule is "anyone may write, only an
// account may share". So what this asserts is that the anonymous document is
// REAL (its own slug id, its own title) and UNOWNED -- which is what makes it
// world-editable and claimable later. The sharing half of the rule is checked
// in guest-flow-test.
{
  const guest = await api('/api/docs', { method: 'POST', body: { title: 'Guest note' } });
  check('2d. creating does NOT require an account',
    guest.status === 201 && guest.body.doc.unowned === true, guest.body.doc?.docId);
  check('2d-ii. the anonymous document has a slug id and a title, not a raw string',
    /^guest-note-[0-9a-f]{8}$/.test(guest.body.doc?.docId ?? '')
    && guest.body.doc?.title === 'Guest note',
    guest.body.doc?.docId);
  check('2d-iii. it has no owner, so anyone may open it',
    guest.body.doc?.ownerId == null && guest.body.doc?.role === 'editor');
}

const adaList = await api('/api/docs', { token: adaToken });
const bobList = await api('/api/docs', { token: bobToken });
check('2e. the owner sees their document',
  adaList.body.docs.some((d) => d.docId === docId && d.role === 'owner'));
check('2f. a stranger does not', !bobList.body.docs.some((d) => d.docId === docId));

await api(`/api/docs/${docId}`, { method: 'PATCH', token: adaToken, body: { title: 'Renamed' } });
check('2g. rename', (await api(`/api/docs/${docId}`, { token: adaToken })).body.doc.title === 'Renamed');

check('2h. a stranger cannot rename',
  (await api(`/api/docs/${docId}`, {
    method: 'PATCH', token: bobToken, body: { title: 'hijacked' },
  })).status === 403);

// ---- 3. sharing, and enforcement on the socket ------------------------------
const wsUrl = `ws://localhost:${PORT}`;
const connect = async (token, id) => {
  const c = new YjsSync({ url: `${wsUrl}?token=${token ?? ''}`, docId: docId, clientId: id });
  // The url already carries a query string, so YjsSync's own `?doc=...` would
  // produce a second `?`. Build the socket url ourselves instead.
  c.socketFactory = (u) => new WebSocket(
    `${wsUrl}?doc=${encodeURIComponent(docId)}&client=${encodeURIComponent(id)}` +
    (token ? `&token=${encodeURIComponent(token)}` : ''));
  return c;
};

{
  const owner = await connect(adaToken, 'ada');
  await owner.connect();
  owner.text.insert(0, 'the owner can write');
  await sleep(400);
  check('3. the owner can open and edit', owner.getText() === 'the owner can write');

  // Bob has no grant yet: the socket must be refused, not merely quiet.
  const stranger = await connect(bobToken, 'bob');
  let refused = false;
  stranger.socketFactory = ((orig) => (u) => {
    const s = orig(u);
    s.addEventListener('close', (e) => { if (e.code === 1008) refused = true; });
    return s;
  })(stranger.socketFactory);
  stranger.connect();
  // 3000, not 700. Admitting or refusing a socket is four Postgres round
  // trips -- the session lookup, the tab check, the document read and the
  // permission read. From a development machine to a Neon region that
  // measures ~1.1s; deployed in the same region it is a couple of
  // milliseconds. This waits long enough for the slow case, so the test
  // asserts the BEHAVIOUR rather than the latency.
  await sleep(3000);
  check('3b. an unshared document refuses the connection', refused, `refused=${refused}`);
  stranger.destroy();

  // Share as VIEWER.
  const shared = await api(`/api/docs/${docId}/share`, {
    method: 'POST', token: adaToken, body: { email: 'bob@example.com', role: 'viewer' },
  });
  check('3c. share by email', shared.status === 200 && shared.body.collaborator.role === 'viewer');

  const viewer = await connect(bobToken, 'bob');
  await viewer.connect();
  await sleep(400);
  check('3d. a viewer can open the document', viewer.getText() === 'the owner can write');

  // The check that matters: the server must reject the edit, not the UI.
  viewer.text.insert(0, 'VIEWER WROTE THIS ');
  await sleep(700);
  check('3e. a viewer edit is rejected by the SERVER',
    owner.getText() === 'the owner can write', JSON.stringify(owner.getText()));

  // Upgrade to editor and try again.
  await api(`/api/docs/${docId}/share`, {
    method: 'POST', token: adaToken, body: { email: 'bob@example.com', role: 'editor' },
  });
  await sleep(300);
  const editor = await connect(bobToken, 'bob2');
  await editor.connect();
  editor.text.insert(0, 'editor wrote. ');
  await sleep(700);
  check('3f. an editor edit is accepted',
    owner.getText().startsWith('editor wrote. '), JSON.stringify(owner.getText()));

  // Revoking must disconnect someone already connected.
  let evicted = false;
  editor.socket?.addEventListener?.('close', (e) => { if (e.code === 1008) evicted = true; });
  await api(`/api/docs/${docId}/share/${bob.body.user.id}`, { method: 'DELETE', token: adaToken });
  await sleep(600);
  check('3g. revoking access disconnects a live collaborator', evicted, `evicted=${evicted}`);

  owner.destroy(); viewer.destroy(); editor.destroy();
}

// ---- 4. version history -----------------------------------------------------
{
  const c = await connect(adaToken, 'ada');
  await c.connect();
  await sleep(200);

  // Wipe whatever the sharing checks left, then write three known states.
  c.text.delete(0, c.text.length);
  c.text.insert(0, 'version one');
  await sleep(300);
  const named = await api(`/api/docs/${docId}/checkpoints`, {
    method: 'POST', token: adaToken, body: { label: 'first draft' },
  });
  check('4. a named checkpoint can be taken', named.status === 201);

  const afterFirst = (await api(`/api/docs/${docId}/history`, { token: adaToken })).body.currentSeq;

  c.text.delete(0, c.text.length);
  c.text.insert(0, 'version two');
  await sleep(400);

  const history = await api(`/api/docs/${docId}/history`, { token: adaToken });
  check('4b. history lists the named checkpoint',
    history.body.checkpoints.some((cp) => cp.label === 'first draft'),
    history.body.checkpoints.map((cp) => cp.label ?? 'auto').join(', '));
  check('4c. the checkpoint records who took it',
    history.body.checkpoints.find((cp) => cp.label === 'first draft')?.author?.email
      === 'ada@example.com');

  const past = await api(`/api/docs/${docId}/versions?seq=${afterFirst}`, { token: adaToken });
  check('4d. an old version can be read back', past.body.text === 'version one',
    JSON.stringify(past.body.text));
  check('4e. reading history does not change the live document',
    c.getText() === 'version two', JSON.stringify(c.getText()));

  // Restore, with a client connected: it must arrive as a normal edit.
  const restored = await api(`/api/docs/${docId}/restore`, {
    method: 'POST', token: adaToken, body: { seq: afterFirst },
  });
  await sleep(700);
  check('4f. restore reports the recovered text', restored.body.text === 'version one');
  check('4g. a CONNECTED client sees the restore live, without reloading',
    c.getText() === 'version one', JSON.stringify(c.getText()));

  const after = await api(`/api/docs/${docId}/history`, { token: adaToken });
  check('4h. restore preserves what it replaced, as a checkpoint',
    after.body.checkpoints.some((cp) => (cp.label ?? '').startsWith('before restoring')),
    after.body.checkpoints.map((cp) => cp.label ?? 'auto').join(', '));

  // The state that was overwritten must itself be recoverable -- restore is an
  // edit, not a rewrite, so going "forward" again is just another restore.
  const undoTarget = after.body.checkpoints.find((cp) => (cp.label ?? '').startsWith('before restoring'));
  const backAgain = await api(`/api/docs/${docId}/restore`, {
    method: 'POST', token: adaToken, body: { seq: undoTarget.seq },
  });
  await sleep(600);
  check('4i. a restore can itself be undone', backAgain.body.text === 'version two',
    JSON.stringify(backAgain.body.text));

  check('4j. history is refused to strangers',
    (await api(`/api/docs/${docId}/history`, { token: bobToken })).status === 403);

  c.destroy();
}

// ---- 5. deletion ------------------------------------------------------------
{
  const del = await api(`/api/docs/${docId}`, { method: 'DELETE', token: bobToken });
  check('5. only the owner may delete', del.status === 403);

  const ok = await api(`/api/docs/${docId}`, { method: 'DELETE', token: adaToken });
  check('5b. the owner may delete', ok.status === 200);
  check('5c. a deleted document leaves the listing',
    !(await api('/api/docs', { token: adaToken })).body.docs.some((d) => d.docId === docId));
  check('5d. a deleted document is no longer readable',
    (await api(`/api/docs/${docId}/history`, { token: adaToken })).status === 403);
}

// ---- 6. the trash -----------------------------------------------------------
//
// Deletion has been soft since ADR-007 -- `deleteDoc` sets a flag and the
// update log survives untouched -- but nothing reached that state, so it was
// recoverable on disk and permanent to the person who clicked Delete. These
// are the assertions that make the storage layer's promise true from outside.
//
// The one worth reading is 6h: an ACL is not touched by a soft delete, so a
// restored document comes back shared with exactly the people it was shared
// with. Restoring is an undo, not a re-creation.
{
  const shared = await api('/api/docs', {
    method: 'POST', token: adaToken, body: { title: 'Quarterly Plan' },
  });
  const sharedId = shared.body.doc.docId;
  await api(`/api/docs/${sharedId}/share`, {
    method: 'POST', token: adaToken, body: { email: 'bob@example.com', role: 'editor' },
  });
  check('6. bob can see the document he was shared on',
    (await api('/api/docs', { token: bobToken })).body.docs.some((d) => d.docId === sharedId));

  await api(`/api/docs/${sharedId}`, { method: 'DELETE', token: adaToken });

  const adaTrash = await api('/api/docs/trash', { token: adaToken });
  check('6b. the owner finds it in the trash',
    adaTrash.status === 200 && adaTrash.body.docs.some((d) => d.docId === sharedId));
  check('6c. and it carries when it was deleted',
    typeof adaTrash.body.docs.find((d) => d.docId === sharedId)?.deletedAt === 'number');

  // Bob was an EDITOR on this document, which is exactly the case that would
  // slip through a check written as "can you see this document" rather than
  // "do you own it". He never had the right to delete it, so it is not his
  // decision to undo and not his trash to appear in.
  const bobTrash = await api('/api/docs/trash', { token: bobToken });
  check('6d. an editor it was shared with does NOT see it in theirs',
    bobTrash.status === 200 && !bobTrash.body.docs.some((d) => d.docId === sharedId));

  check('6e. the trash needs a session at all',
    (await api('/api/docs/trash')).status === 401);

  check('6f. an editor may not restore it',
    (await api(`/api/docs/${sharedId}/undelete`, { method: 'POST', token: bobToken })).status === 403);

  const back = await api(`/api/docs/${sharedId}/undelete`, { method: 'POST', token: adaToken });
  check('6g. the owner may', back.status === 200 && back.body.doc?.deletedAt === null);

  check('6h. and it comes back still shared with bob, at the role he had',
    (await api('/api/docs', { token: bobToken }))
      .body.docs.some((d) => d.docId === sharedId && d.role === 'editor'));

  check('6i. its history is readable again',
    (await api(`/api/docs/${sharedId}/history`, { token: adaToken })).status === 200);

  check('6j. it has left the trash',
    !(await api('/api/docs/trash', { token: adaToken }))
      .body.docs.some((d) => d.docId === sharedId));

  // Two tabs open on the trash, both clicking Restore. The second is a race,
  // not a mistake, and it gets the same answer as the first.
  check('6k. restoring an undeleted document is a no-op, not an error',
    (await api(`/api/docs/${sharedId}/undelete`, { method: 'POST', token: adaToken })).status === 200);

  check('6l. restoring something that never existed is a 404',
    (await api('/api/docs/no-such-doc-0000/undelete', { method: 'POST', token: adaToken })).status === 404);

  // `/api/docs/trash` sits above the `/api/docs/:id` pattern on purpose. If it
  // ever slips below it, this route starts resolving as a document called
  // "trash" and every assertion above fails in a way that looks like storage.
  check('6m. "trash" is a route, not a document id',
    (await api('/api/docs/trash', { token: adaToken })).body.docs !== undefined);
}

server.kill();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
