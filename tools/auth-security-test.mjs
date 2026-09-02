/**
 * Session lifetime and privilege escalation, which api-test does not cover.
 *
 *   node tools/auth-security-test.mjs
 *
 * api-test already asserts the shape of authentication -- passwords never
 * come back, strangers are refused, a viewer's edit is dropped by the server,
 * only the owner may delete. What it does not assert is what happens to a
 * session over TIME, and what a legitimate collaborator can do with the
 * access they were given. Both are places where a small change looks
 * harmless: a session lookup that stops checking `expires`, or a share
 * endpoint that starts trusting `body.role`.
 *
 * Owns its own server and port.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8105;
const B = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { scratchSchemas, scratchEnv, resetSchemas } = await import('./test-schema.mjs');
const { config } = await import('../backend/src/config.js');
const { Db } = await import('../backend/src/storage/db.js');
const { schema, accountsSchema } = scratchSchemas('authsec');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const api = async (p, { method = 'GET', body, token } = {}) => {
  const res = await fetch(B + p, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log('\nSession lifetime and privilege escalation\n');
await resetSchemas(schema, accountsSchema);

const server = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
  env: { ...process.env, ...scratchEnv({ schema, accountsSchema, port: PORT }) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => {
  server.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
});

const mk = async (name) => {
  const email = `${name}-${Date.now()}@example.com`;
  const r = await api('/api/auth/signup', {
    method: 'POST', body: { email, name, password: 'hunter2hunter2' },
  });
  return { email, token: r.body.token, id: r.body.user.id };
};

const alice = await mk('alice');
const bob = await mk('bob');
const mallory = await mk('mallory');

// ---------------------------------------------------------------------------
console.log('1. sessions expire, and expiry is enforced on every request');
{
  const admin = new Db({
    connectionString: config.databaseUrlAdmin ?? config.databaseUrl,
    schema: accountsSchema,
  });

  const before = await api('/api/me', { token: alice.token });
  check('the session works to begin with', before.status === 200);

  // Age it past its expiry in the database rather than waiting 30 days.
  await admin.query('UPDATE {sessions} SET expires = $1 WHERE user_id = $2',
    [Date.now() - 1000, alice.id]);

  const after = await api('/api/me', { token: alice.token });
  check('an expired session is refused', after.status === 401, `status ${after.status}`);

  // And is not merely refused: the row is removed, so an expired token cannot
  // sit in the table indefinitely waiting for a clock change.
  const left = await admin.one('SELECT count(*)::int AS n FROM {sessions} WHERE user_id = $1',
    [alice.id]);
  check('the expired row is deleted rather than left behind', left.n === 0, `${left.n} rows`);

  // Creating still SUCCEEDS, and that is correct rather than a hole: anyone
  // may create a document without an account (ADR-010), so an unauthenticated
  // request is a guest request. What must not happen is the expired session
  // still being treated as Alice. The document has to come back unowned, with
  // no ACL row tying it to her, or an expired token would keep conferring
  // ownership indefinitely.
  const doc = await api('/api/docs', {
    method: 'POST', token: alice.token, body: { title: 'after expiry' },
  });
  check('an expired session creates a GUEST document, not one owned by the user',
    doc.body.doc?.ownerId == null && doc.body.doc?.unowned === true,
    `ownerId=${doc.body.doc?.ownerId} unowned=${doc.body.doc?.unowned}`);

  const acl = new Db({
    connectionString: config.databaseUrlAdmin ?? config.databaseUrl, schema,
  });
  const rows = await acl.one(
    'SELECT count(*)::int AS n FROM {acl} WHERE doc_id = $1', [doc.body.doc.docId]);
  check('and no ACL row was written for the expired session', rows.n === 0, `${rows.n} rows`);
  await acl.close();
  await admin.close();
}

// Alice needs a live session again for the rest.
const relogin = await api('/api/auth/login', {
  method: 'POST', body: { email: alice.email, password: 'hunter2hunter2' },
});
alice.token = relogin.body.token;
check('logging in again issues a working session', relogin.status === 200 && !!alice.token);

// ---------------------------------------------------------------------------
console.log('\n2. logout invalidates the token immediately');
{
  const throwaway = await api('/api/auth/login', {
    method: 'POST', body: { email: bob.email, password: 'hunter2hunter2' },
  });
  const t = throwaway.body.token;
  check('the second session works', (await api('/api/me', { token: t })).status === 200);

  await api('/api/auth/logout', { method: 'POST', token: t });
  check('the token is dead after logout',
    (await api('/api/me', { token: t })).status === 401);
  check('bob\'s other session is unaffected',
    (await api('/api/me', { token: bob.token })).status === 200);
}

// ---------------------------------------------------------------------------
console.log('\n3. a collaborator cannot escalate');
{
  const created = await api('/api/docs', {
    method: 'POST', token: alice.token, body: { title: 'alice private' },
  });
  const docId = created.body.doc.docId;

  await api(`/api/docs/${docId}/share`, {
    method: 'POST', token: alice.token, body: { email: bob.email, role: 'viewer' },
  });

  // A viewer may read.
  check('the viewer can read the document',
    (await api(`/api/docs/${docId}`, { token: bob.token })).status === 200);

  // ...and may not hand out access, to anyone, including themselves.
  const reshare = await api(`/api/docs/${docId}/share`, {
    method: 'POST', token: bob.token, body: { email: mallory.email, role: 'editor' },
  });
  check('a viewer cannot share the document onward',
    reshare.status === 403, `status ${reshare.status}`);

  const selfPromote = await api(`/api/docs/${docId}/share`, {
    method: 'POST', token: bob.token, body: { email: bob.email, role: 'editor' },
  });
  check('a viewer cannot promote themselves', selfPromote.status === 403,
    `status ${selfPromote.status}`);

  // The owner CAN share, but `role` is clamped: there is no request that
  // makes a second owner, so ownership cannot be handed out by accident.
  await api(`/api/docs/${docId}/share`, {
    method: 'POST', token: alice.token, body: { email: bob.email, role: 'owner' },
  });
  const people = await api(`/api/docs/${docId}/share`, { token: alice.token });
  const bobRole = people.body.collaborators?.find((c) => c.userId === bob.id)?.role;
  check('asking for role "owner" does not grant it', bobRole !== 'owner', `role=${bobRole}`);

  // The owner's own grant cannot be revoked, by anyone.
  const selfRevoke = await api(`/api/docs/${docId}/share/${alice.id}`, {
    method: 'DELETE', token: alice.token,
  });
  const afterRevoke = await api(`/api/docs/${docId}/share`, { token: alice.token });
  const aliceRole = afterRevoke.body.collaborators?.find((c) => c.userId === alice.id)?.role;
  check('the owner cannot be revoked out of their own document',
    aliceRole === 'owner', `role=${aliceRole} (revoke returned ${selfRevoke.status})`);

  // A stranger is a stranger even knowing the id.
  const stranger = await api(`/api/docs/${docId}`, { token: mallory.token });
  check('a stranger who knows the id is still refused',
    stranger.status === 403 || stranger.status === 404, `status ${stranger.status}`);
  const strangerDelete = await api(`/api/docs/${docId}`, {
    method: 'DELETE', token: mallory.token,
  });
  check('and cannot delete it', strangerDelete.status >= 400, `status ${strangerDelete.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n4. no endpoint hands back a credential');
{
  const me = await api('/api/me', { token: alice.token });
  const text = JSON.stringify(me.body);
  check('/api/me returns no password hash and no token',
    !/password|token|hash/i.test(text), text.slice(0, 120));

  const users = await api(`/api/users?q=${encodeURIComponent(bob.email.slice(0, 6))}`,
    { token: alice.token });
  check('the user search returns no password material',
    !/password|hash/i.test(JSON.stringify(users.body)));
  check('the user search requires a session',
    (await api('/api/users?q=alice')).status === 401);

  const health = await api('/api/health');
  const h = JSON.stringify(health.body);
  check('/api/health leaks no ids, titles or connection details',
    !/postgres|sslmode|doc_id|@example\.com/i.test(h), h.slice(0, 100));
}

// ---------------------------------------------------------------------------
console.log('\n5. a thread id does not carry access to the document it is in');
{
  // The shape of the hole: every comment route takes a DOCUMENT id and a
  // THREAD id, and the role is decided from the document. If the two are not
  // checked against each other, a document you legitimately edit -- your own,
  // or any unowned one, which anybody may create -- authorises writing to a
  // thread in somebody else's private document.
  const aliceDoc = (await api('/api/docs', {
    method: 'POST', token: alice.token, body: { title: 'alice notes' },
  })).body.doc.docId;
  const mallorysDoc = (await api('/api/docs', {
    method: 'POST', token: mallory.token, body: { title: 'mallory notes' },
  })).body.doc.docId;

  const opened = await api(`/api/docs/${aliceDoc}/comments`, {
    method: 'POST',
    token: alice.token,
    body: { anchor: { kind: 'test', from: 0, to: 1 }, quote: 'h', body: 'alice only' },
  });
  const threadId = opened.body.thread?.id;
  const commentId = opened.body.thread?.comments?.[0]?.id;
  check('alice can open a thread on her own document', Boolean(threadId),
    `status ${opened.status}`);

  const viaHerOwn = (p, opts) => api(`/api/docs/${mallorysDoc}/comments/${p}`,
    { token: mallory.token, ...opts });

  check('a stranger cannot reply into it through a document of their own',
    (await viaHerOwn(threadId, { method: 'POST', body: { body: 'hello' } })).status === 404);
  check('nor resolve it',
    (await viaHerOwn(`${threadId}/resolve`, { method: 'POST', body: {} })).status === 404);
  check('nor delete one of its comments',
    (await viaHerOwn(`${threadId}/${commentId}`, { method: 'DELETE' })).status === 404);
  check('nor delete the thread',
    (await viaHerOwn(threadId, { method: 'DELETE' })).status === 404);

  // And none of the four did anything on the way to being refused.
  const after = await api(`/api/docs/${aliceDoc}/comments`, { token: alice.token });
  const thread = after.body.threads?.find((t) => t.id === threadId);
  check('the thread is untouched', Boolean(thread) && thread.comments.length === 1
    && thread.resolved === false, JSON.stringify(thread?.comments?.length));
}

server.kill('SIGKILL');
await sleep(200);
await resetSchemas(schema, accountsSchema);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
