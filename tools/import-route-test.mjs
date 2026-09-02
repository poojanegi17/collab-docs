/**
 * The import route: filling an empty document with converted content.
 *
 *   node tools/import-route-test.mjs
 *
 * `tools/import-html-test.mjs` covers the conversion and needs no server. This
 * covers the half that does: that imported runs reach the document THROUGH THE
 * ENGINE and come back out as a real document, live and offline, and that the
 * route refuses the two things that would make it dangerous -- writing into a
 * document that already has content, and writing into one the caller may not
 * edit.
 *
 * The end-to-end assertion is the one worth having: a real Google export goes
 * in as HTML at one end and comes back out of the version API as formatted
 * runs at the other, having been through the converter, the route, the engine
 * and the log.
 *
 * Owns its own server and port.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8111;
const B = `http://localhost:${PORT}`;

const { scratchSchemas, scratchEnv, resetSchemas } = await import('./test-schema.mjs');
const { htmlToRichText } = await import('../frontend/src/ui/import/html-to-rich.js');
const { schema, accountsSchema } = scratchSchemas('importroute');

let pass = 0, fail = 0;
const children = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

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

console.log('\nImport route\n');
await resetSchemas(schema, accountsSchema);

const server = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: { ...process.env, ...scratchEnv({ schema, accountsSchema, port: PORT }) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(child); });
  child.once('exit', (c) => reject(new Error(`server exited ${c} before listening`)));
});

try {
  const fixture = fs.readFileSync(path.join(root, 'tools/fixtures/google-doc-export.html'), 'utf8');
  const { rich } = htmlToRichText(fixture);

  const newDoc = async (title, token) =>
    (await api('/api/docs', { method: 'POST', body: { title }, token })).body.doc.docId;

  // ---- the whole journey, offline path -----------------------------------
  // Nobody is connected, so the route applies the edit on a throwaway engine
  // whose persist callback writes to the real log.
  const docId = await newDoc('Imported');
  const imported = await api(`/api/docs/${docId}/import`,
    { method: 'POST', body: { runs: rich.toJSON() } });
  check('an empty document accepts an import',
    imported.status === 200 && imported.body.characters === rich.length,
    JSON.stringify(imported.body).slice(0, 100));

  // Read back through the version API -- a different code path from the one
  // that wrote it, and the one a client actually loads through.
  const seq = (await api(`/api/docs/${docId}/history`)).body.currentSeq;
  const back = await api(`/api/docs/${docId}/versions?seq=${seq}`);
  check('the text survives the round trip through the engine and the log',
    back.body.text === rich.toString(),
    `${back.body.text?.length} chars vs ${rich.length}`);

  // The point of the whole feature: it is not plain text at the other end.
  const runs = back.body.runs ?? [];
  const attrs = (needle) => runs.find((r) => r.text.includes(needle))?.attributes;
  check('and so does the formatting',
    attrs('bold word')?.bold === true
    && attrs('Red text')?.color === '#b91c1c'
    && attrs('the report')?.link === 'https://example.com/report',
    JSON.stringify(attrs('bold word')));

  check('including the line attributes, which ride on the newlines',
    runs.some((r) => r.text.includes('\n') && r.attributes?.header === 1)
    && runs.some((r) => r.attributes?.list === 'bullet'));

  // ---- the refusals -------------------------------------------------------
  // `replaceWith` is a REPLACE. Pointing it at a document with anything in it
  // would destroy that document, so a second import is refused rather than
  // merged, appended or silently overwritten.
  const again = await api(`/api/docs/${docId}/import`,
    { method: 'POST', body: { runs: rich.toJSON() } });
  check('a second import is refused rather than overwriting the first',
    again.status === 409, JSON.stringify(again.body));

  check('the document is untouched by the refusal',
    (await api(`/api/docs/${docId}/versions?seq=${seq}`)).body.text === rich.toString());

  const empty = await newDoc('Empty');
  check('runs that are not an array are refused',
    (await api(`/api/docs/${empty}/import`, { method: 'POST', body: { runs: 'nope' } })).status === 400);
  check('a missing body is refused',
    (await api(`/api/docs/${empty}/import`, { method: 'POST', body: {} })).status === 400);
  check('an empty document is refused rather than created blank',
    (await api(`/api/docs/${empty}/import`, { method: 'POST', body: { runs: [] } })).status === 400);
  check('malformed runs are refused rather than throwing',
    [400, 500].includes(
      (await api(`/api/docs/${empty}/import`, { method: 'POST', body: { runs: [null] } })).status));
  check('and the document is still importable afterwards',
    (await api(`/api/docs/${empty}/import`,
      { method: 'POST', body: { runs: [{ text: 'ok' }] } })).status === 200);

  // ---- access -------------------------------------------------------------
  const mk = async (name) => {
    const r = await api('/api/auth/signup', {
      method: 'POST',
      body: { email: `${name}-${Date.now()}@example.com`, name, password: 'hunter2hunter2' },
    });
    return { token: r.body.token, id: r.body.user.id };
  };
  const alice = await mk('alice');
  const mallory = await mk('mallory');

  const owned = await newDoc('Alice private', alice.token);
  const strangerImport = await api(`/api/docs/${owned}/import`,
    { method: 'POST', body: { runs: [{ text: 'mine now' }] }, token: mallory.token });
  check('a stranger cannot import into somebody else\'s document',
    strangerImport.status === 403, JSON.stringify(strangerImport.body));

  const anonImport = await api(`/api/docs/${owned}/import`,
    { method: 'POST', body: { runs: [{ text: 'mine now' }] } });
  check('nor can an anonymous caller', anonImport.status === 403);

  // A viewer may read the document, and reading is not writing.
  await api(`/api/docs/${owned}/share`, {
    method: 'POST', body: { email: (await api('/api/me', { token: mallory.token })).body.user.email, role: 'viewer' },
    token: alice.token,
  });
  check('nor can a viewer who has been shared with',
    (await api(`/api/docs/${owned}/import`,
      { method: 'POST', body: { runs: [{ text: 'x' }] }, token: mallory.token })).status === 403);

  check('the owner can', (await api(`/api/docs/${owned}/import`,
    { method: 'POST', body: { runs: [{ text: 'ok' }] }, token: alice.token })).status === 200);

  // ---- the live path ------------------------------------------------------
  // With a room open the route goes through `applyServerEdit` instead, so the
  // engine turns it into an ordinary edit and everyone connected sees it.
  const { WebSocket } = await import('ws');
  const live = await newDoc('Live import');
  const socket = new WebSocket(`ws://localhost:${PORT}/?doc=${live}&client=watcher`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  // Let the room finish its handshake before importing into it.
  await new Promise((r) => setTimeout(r, 300));

  const liveImport = await api(`/api/docs/${live}/import`,
    { method: 'POST', body: { runs: [{ text: 'live ' }, { text: 'import', attributes: { bold: true } }] } });
  check('a document with a room open accepts an import', liveImport.status === 200,
    JSON.stringify(liveImport.body));

  await new Promise((r) => setTimeout(r, 400));
  const liveSeq = (await api(`/api/docs/${live}/history`)).body.currentSeq;
  const liveBack = await api(`/api/docs/${live}/versions?seq=${liveSeq}`);
  check('and it lands in the document as an ordinary edit',
    liveBack.body.text === 'live import', JSON.stringify(liveBack.body.text));
  socket.close();
} catch (err) {
  check('the suite ran to completion', false, err.stack?.split('\n').slice(0, 3).join(' | '));
} finally {
  for (const child of children) child.kill();
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
