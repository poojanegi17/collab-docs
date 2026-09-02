/**
 * Kill the server mid-edit and count what survived.
 *
 * `restart-test.mjs` already asserts that nothing is lost across a `SIGKILL`.
 * This measures the same scenario and writes the numbers down: the landing
 * page makes a claim about crash safety, and a claim on that page has to come
 * from a file something produced, not from a sentence somebody typed.
 *
 * The distinction from restart-test is only what it does with the result --
 * that one exits non-zero, this one emits JSON. Both drive a real server
 * process and a real client; neither simulates anything.
 *
 *   node tools/measure-durability.mjs           print a summary
 *   node tools/measure-durability.mjs --json    emit the record
 *   npm run measure:durability                  write it where the UI reads it
 *
 * The port and database are its own, so it does not disturb `npm run dev`.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';
import { Db } from '../backend/src/storage/db.js';
import { config } from '../backend/src/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { schema, accountsSchema } = scratchSchemas('durability');
const PORT = 8097;
const DOC = 'durability-measure';
const JSON_ONLY = process.argv.includes('--json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { if (!JSON_ONLY) console.log(...a); };

const cleanDb = async () => {
  // A clean slate: the scratch schema is dropped and recreated. Async,
  // because dropping a schema is a round trip. See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);
};

function boot() {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: PORT }),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
  });
}

await cleanDb();

/**
 * The edit burst. Written one insert at a time rather than as one big string
 * so the crash lands in the middle of a stream of updates, which is the case
 * that can actually lose data -- a single atomic write is not a test of
 * anything.
 */
const BURST = 40;
const CHUNK = 'the quick brown fox. ';

log('\nDurability under SIGKILL\n');

let server = await boot();

const alice = new YjsSync({ url: `ws://localhost:${PORT}`, docId: DOC, clientId: 'alice' });
await alice.connect();

// ---- 1. write, with the server up ------------------------------------------
for (let i = 0; i < BURST; i++) {
  alice.text.insert(alice.text.length, CHUNK);
  // Long enough that these are separate updates on the wire, short enough that
  // the whole measurement stays a few seconds.
  if (i % 8 === 0) await sleep(12);
}
await sleep(500);

const online = alice.text.toString();
log(`  wrote ${online.length} characters with the server up`);

// ---- 2. SIGKILL, then keep typing into the void -----------------------------
// SIGKILL and not SIGINT: no chance for a graceful snapshot, no unwind, no
// flush. Whatever is on disk is whatever the append-only log already had.
server.kill('SIGKILL');
await sleep(400);

const OFFLINE_CHUNK = 'typed while the server was down. ';
const OFFLINE_N = 10;
for (let i = 0; i < OFFLINE_N; i++) alice.text.insert(alice.text.length, OFFLINE_CHUNK);
await sleep(150);

const offlineChars = OFFLINE_CHUNK.length * OFFLINE_N;
log(`  killed the server, then typed ${offlineChars} more characters offline`);

// ---- 3. restart and time the recovery ---------------------------------------
const t0 = performance.now();
server = await boot();
await alice.connect();

// Wait for the client to report itself synced rather than sleeping a fixed
// amount -- a hardcoded sleep would be measuring the sleep.
const deadline = Date.now() + 10_000;
while (alice.status !== 'synced' && Date.now() < deadline) await sleep(10);
const recoveryMs = performance.now() - t0;

await sleep(300);
const after = alice.text.toString();

// ---- 4. a cold client, to prove it came off disk ----------------------------
const carol = new YjsSync({ url: `ws://localhost:${PORT}`, docId: DOC, clientId: 'carol' });
await carol.connect();
await sleep(500);
const fromDisk = carol.text.toString();

const expected = online + OFFLINE_CHUNK.repeat(OFFLINE_N);
const lost = expected.length - after.length;

// What the document costs in Postgres. The log and the snapshot are what
// durability actually spends, so they are what is measured -- summing bytes
// rather than asking the database for a page count, which would fold in
// storage overhead that was never the interesting part.
const sizeDb = new Db({ connectionString: config.databaseUrl, schema });
const bytes = Number((await sizeDb.one(
  `SELECT COALESCE((SELECT SUM(octet_length(data)) FROM {updates} WHERE doc_id = $1), 0)
        + COALESCE((SELECT SUM(octet_length(data)) FROM {snapshots} WHERE doc_id = $1), 0)
     AS n`, [DOC])).n);
await sizeDb.close();

for (const c of [alice, carol]) c.destroy();
server.kill();
await sleep(150);
await cleanDb();

const record = {
  charsWritten: expected.length,
  charsBeforeKill: online.length,
  charsWrittenOffline: offlineChars,
  charsRecovered: after.length,
  charsLost: Math.max(0, lost),
  recoveryMs: Number(recoveryMs.toFixed(1)),
  coldClientAgrees: fromDisk === after,
  updates: BURST + OFFLINE_N,
  signal: 'SIGKILL',
  bytesStored: bytes,
  measuredOn: {
    date: new Date().toISOString().slice(0, 10),
    node: process.version,
  },
};

if (JSON_ONLY) {
  process.stdout.write(JSON.stringify(record, null, 2) + '\n');
} else {
  log('');
  log(`  characters written      ${record.charsWritten}`);
  log(`  characters recovered    ${record.charsRecovered}`);
  log(`  characters lost         ${record.charsLost}`);
  log(`  recovery                ${record.recoveryMs.toFixed(0)}ms`);
  log(`  cold client agrees      ${record.coldClientAgrees}`);
  log('');
}

// A measurement that found data loss is a failed measurement, not a number to
// publish. The landing panel would happily render "37 characters lost" and
// that is exactly the sentence nobody would notice was wrong.
if (record.charsLost !== 0 || !record.coldClientAgrees) {
  console.error('\nDATA WAS LOST. Not writing a record.\n');
  process.exit(1);
}
process.exit(0);
