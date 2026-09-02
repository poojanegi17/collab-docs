/**
 * Shutdown must flush the write buffer before the process goes away.
 *
 *   node tools/shutdown-test.mjs
 *
 * WHY THIS EXISTS
 *
 * Render stops a service with SIGTERM and kills it shortly after. Everything
 * typed inside the last `persistWindowMs` is at that moment an array in this
 * process and not in Postgres, so whether a deploy loses the last keystrokes
 * of every open document comes down entirely to whether the shutdown path
 * drains that buffer first. Nothing else in the system answers this: the
 * client has the state, but a client that closed with the tab does not.
 *
 * TWO PARTS, BECAUSE ONE OF THEM CANNOT RUN EVERYWHERE
 *
 * A. The flush itself, driven by calling `shutdown()` directly. Portable, and
 *    it is the part that carries the data guarantee. The window is set to two
 *    seconds so nothing can be saved by the ordinary timer -- only a real
 *    flush can get that text into Postgres.
 *
 * B. Signal DELIVERY: that SIGTERM actually reaches the handler and the
 *    process exits 0. This is skipped on Windows, where `child.kill('SIGTERM')`
 *    does not deliver a signal at all -- libuv maps it onto TerminateProcess,
 *    the handler never runs, and the child dies with a null exit code. A test
 *    that "passed" there would be measuring nothing. CI runs on Linux, where
 *    this part is asserted properly.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';

const WINDOW_MS = 2000;

// Bound before anything reads it. Part A runs the server IN THIS PROCESS, so
// it shares this config; part B spawns children and passes its own.
process.env.PORT = '8103';
process.env.DB_SCHEMA = 't_shutdownflush';
process.env.ACCOUNTS_SCHEMA = 't_shutdownflush_accounts';
process.env.PERSIST_WINDOW_MS = String(WINDOW_MS);
process.env.COMPACT_AFTER = '100000';

// NOT a static import. `test-schema.mjs` imports config.js, and config.js
// reads the environment ONCE at module evaluation -- so importing it before
// the scratch PORT and DB_SCHEMA are set would bind the server to 8080 and
// the real schemas. ESM hoists imports above assignments, so the only way to
// order this correctly is to load it after.
const { scratchSchemas, scratchEnv, resetSchemas } = await import('./test-schema.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('\nGraceful shutdown flushes pending writes\n');

// ---------------------------------------------------------------------------
console.log('A. shutdown() drains the buffer');
{
  const { schema, accountsSchema } = scratchSchemas('shutdownflush');
  await resetSchemas(schema, accountsSchema);
  const { startServer } = await import('../backend/src/transport/server.js');
  const { config } = await import('../backend/src/config.js');
  const { Store } = await import('../backend/src/storage/store.js');
  const { YjsEngine } = await import('../backend/src/engines/yjs-engine.js');

  const server = await startServer();
  const DOC = 'shutdown-doc';
  const client = new YjsSync({ url: 'ws://localhost:8103', docId: DOC, clientId: 'writer' });
  await client.connect();

  const text = 'typed and never given time to reach the database on its own.';
  client.text.insert(0, text);
  await sleep(150);            // far inside the 2000ms window

  const pendingBefore = server.store.buffer.pending(DOC);
  check('the update really is still only in the buffer',
    pendingBefore > 0, `${pendingBefore} queued`);

  await server.shutdown({ exit: false });

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

  check('shutdown flushed it to Postgres', recovered === text,
    JSON.stringify(recovered.slice(0, 60)));
  await resetSchemas(schema, accountsSchema);
}

// ---------------------------------------------------------------------------
console.log('\nB. SIGTERM reaches the handler and the process exits 0');
if (process.platform === 'win32') {
  console.log('  SKIP  not assertable on win32: child.kill("SIGTERM") maps to');
  console.log('        TerminateProcess, so no handler runs. Asserted in CI (Linux).');
} else {
  const { schema, accountsSchema } = scratchSchemas('shutdownsignal');
  await resetSchemas(schema, accountsSchema);

  const log = [];
  const child = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: 8104 }),
      PERSIST_WINDOW_MS: String(WINDOW_MS),
      COMPACT_AFTER: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  await new Promise((resolve) => {
    child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
  });

  const DOC = 'signal-doc';
  const client = new YjsSync({ url: 'ws://localhost:8104', docId: DOC, clientId: 'writer' });
  await client.connect();
  const tail = 'typed in the last instant before SIGTERM.';
  client.text.insert(0, tail);
  await sleep(150);

  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  child.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(20_000).then(() => 'TIMEOUT')]);

  check('the process exits rather than hanging', code !== 'TIMEOUT', String(code));
  check('and exits 0', code === 0, `exit code ${code}`);
  check('the handler ran', log.some((l) => l.includes('shutting down')),
    log.join('').slice(-120));

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

  check('text inside the write window survived the signal', recovered === tail,
    JSON.stringify(recovered.slice(0, 60)));
  await resetSchemas(schema, accountsSchema);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
