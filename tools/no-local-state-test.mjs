/**
 * The server must start, serve and persist with no filesystem state at all.
 *
 *   node tools/no-local-state-test.mjs
 *
 * WHY THIS EXISTS
 *
 * ADR-019's whole claim is that nothing durable lives on disk. On a clean
 * checkout there is nothing under `backend/data/` to move aside, so this
 * asserts the claim directly.
 *
 * It stashes the directory if it finds one anyway, because the interesting
 * failure is somebody reintroducing local state and everything continuing to
 * work on their machine while breaking on a host that wipes its filesystem
 * every deploy. Render is that host.
 *
 * The load-bearing assertion is the last one: the server WROTE nothing to
 * disk while running. A server that recreates a data directory is a server
 * that will quietly start depending on one.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8106;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { scratchSchemas, scratchEnv, resetSchemas } = await import('./test-schema.mjs');
const { YjsSync } = await import('../frontend/src/sync/yjs-sync.js');
const { schema, accountsSchema } = scratchSchemas('nolocalstate');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('\nStartup with no local database file and no data directory\n');

const dataDir = path.join(root, 'backend/data');
const stashed = path.join(root, 'backend/.data-stashed-by-test');
let moved = false;

// Belt and braces: if a previous run died mid-test, put things back first.
if (fs.existsSync(stashed) && !fs.existsSync(dataDir)) fs.renameSync(stashed, dataDir);

try {
  if (fs.existsSync(dataDir)) {
    fs.renameSync(dataDir, stashed);
    moved = true;
  }
  check('backend/data is genuinely absent', !fs.existsSync(dataDir));

  // Excluding this test's own stash, which is where those files went a moment
  // ago and which is put back in the `finally` below.
  const leftovers = fs.readdirSync(path.join(root, 'backend'), { recursive: true })
    .map(String)
    .filter((f) => /\.(sqlite|db)$/.test(f) && !f.includes('.data-stashed-by-test'));
  check('no local database file exists anywhere under backend/',
    leftovers.length === 0, leftovers.join(', '));

  await resetSchemas(schema, accountsSchema);

  const logs = [];
  const server = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: PORT }),
      PERSIST_WINDOW_MS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => logs.push(String(d)));
  server.stderr.on('data', (d) => logs.push(String(d)));

  const started = await Promise.race([
    new Promise((r) => server.stdout.on('data',
      (d) => { if (String(d).includes('listening')) r(true); })),
    sleep(30_000).then(() => false),
  ]);
  check('the server starts with no local state', started,
    started ? '' : logs.join('').slice(-200));

  if (started) {
    const health = await (await fetch(`http://localhost:${PORT}/api/health`)).json();
    check('/api/health answers', health.ok === true);

    // A real round trip, so this is not just "the process did not exit".
    const DOC = 'no-local-state-doc';
    const a = new YjsSync({ url: `ws://localhost:${PORT}`, docId: DOC, clientId: 'a' });
    const b = new YjsSync({ url: `ws://localhost:${PORT}`, docId: DOC, clientId: 'b' });
    await Promise.all([a.connect(), b.connect()]);
    const text = 'stored in Postgres, with nowhere on disk to fall back to.';
    a.text.insert(0, text);
    await sleep(600);
    check('two clients converge', a.text.toString() === b.text.toString());
    a.disconnect(); b.disconnect();
    await sleep(400);

    // The document survives a cold read through a brand-new connection.
    const { config } = await import('../backend/src/config.js');
    const { Store } = await import('../backend/src/storage/store.js');
    const { YjsEngine } = await import('../backend/src/engines/yjs-engine.js');
    const store = await new Store({
      connectionString: config.databaseUrl,
      schema,
      adminConnectionString: config.databaseUrlAdmin,
      appRole: config.appRole,
    }).init();
    const engine = new YjsEngine(DOC, () => {});
    engine.restore(await store.load(DOC));
    const recovered = engine.readDocument().toString();
    engine.destroy();
    await store.close();
    check('the text is durable in Postgres', recovered === text,
      JSON.stringify(recovered.slice(0, 50)));

    check('the server created no data directory while running',
      !fs.existsSync(dataDir), 'backend/data reappeared');

    server.kill('SIGKILL');
    await sleep(300);
  } else {
    server.kill('SIGKILL');
  }

  await resetSchemas(schema, accountsSchema);
} finally {
  // Always put it back, whatever happened above.
  if (moved && fs.existsSync(stashed)) {
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    fs.renameSync(stashed, dataDir);
  }
}

check('backend/data was restored afterwards', !moved || fs.existsSync(dataDir));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
