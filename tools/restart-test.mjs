/**
 * Done-checklist item: "kill the server with clients connected, restart it,
 * everything converges and nothing is lost."
 *
 * Owns the server process itself, so run it on its own (stop `npm run dev`
 * first) -- it binds the same port.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { schema, accountsSchema } = scratchSchemas('restart');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOC = 'restart-doc';

  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);

function boot() {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: 8099 }),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      process.stdout.write('    [server] ' + d);
      if (String(d).includes('listening')) resolve(p);
    });
  });
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('\nServer restart / durability\n');

let server = await boot();

const a = new YjsSync({ url: 'ws://localhost:8099', docId: DOC, clientId: 'alice' });
const b = new YjsSync({ url: 'ws://localhost:8099', docId: DOC, clientId: 'bob' });
await Promise.all([a.connect(), b.connect()]);

a.text.insert(0, 'written before the crash. ');
b.text.insert(b.text.length, 'bob was here too. ');
await sleep(400);
const beforeCrash = a.text.toString();
check('edits agreed before restart', a.text.toString() === b.text.toString(), JSON.stringify(beforeCrash));

console.log('\n  ...killing the server with 2 clients still connected\n');
server.kill('SIGKILL'); // SIGKILL, not SIGINT: no chance for a graceful snapshot
await sleep(500);
check('clients noticed the drop', a.status !== 'synced' && b.status !== 'synced', `alice=${a.status}`);

// Type into the void. These edits exist only in the clients right now.
a.text.insert(a.text.length, 'typed while the server was DOWN. ');
await sleep(200);

console.log('  ...restarting\n');
server = await boot();

await Promise.all([a.connect(), b.connect()]);
await sleep(800);

const after = a.text.toString();
check('reconnected automatically', a.status === 'synced' && b.status === 'synced');
check('pre-crash edits survived the restart', after.includes('written before the crash.') && after.includes('bob was here too.'));
check('edits made while server was down landed', after.includes('typed while the server was DOWN.'));
check('both clients converged', a.text.toString() === b.text.toString(), JSON.stringify(after));

// A brand-new client must see the same document, i.e. it really came off disk.
const c = new YjsSync({ url: 'ws://localhost:8099', docId: DOC, clientId: 'carol' });
await c.connect();
await sleep(400);
check('fresh client loads the document from disk', c.text.toString() === after, `${c.text.length} chars`);

for (const cl of [a, b, c]) cl.destroy();
server.kill();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
