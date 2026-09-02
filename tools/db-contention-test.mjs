/**
 * Both engine servers open the SAME accounts store, at the same moment.
 *
 * `npm run dev` starts them in parallel, and on a host that rebuilds the
 * container on every deploy they also boot together after a restart. So "two
 * processes initialise the same database simultaneously" is not a rare race --
 * it happens on most cold starts.
 *
 *   node tools/db-contention-test.mjs
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS ABOUT
 *
 * A race that is less obvious than it sounds:
 *
 *   `CREATE TABLE IF NOT EXISTS` IS NOT SAFE TO RUN CONCURRENTLY.
 *
 * The `IF NOT EXISTS` check and the creation are not atomic against each
 * other. Two sessions that both find a table missing will both try to create
 * it, and the loser does not get a polite no-op -- it gets
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`,
 * a unique violation on an internal catalogue index. The same is true of
 * `CREATE SCHEMA IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`.
 *
 * Every server boot calls `ensureSchema` (backend/src/storage/schema.js), and
 * that is deliberate: it is what makes a deploy to a host with an ephemeral
 * filesystem a non-event. So this is on the critical path of every start, and
 * a server that dies there is a server that never listens.
 *
 * So: spawn more simultaneous initialisers than the product ever will, against
 * one fresh schema, and require all of them to live and to have a usable
 * connection afterwards.
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratchSchemas, resetSchemas } from './test-schema.mjs';
import { config } from '../backend/src/config.js';

const OPENERS = 8;
const ROUNDS = 3;

// The child half: initialise the schema, do one real write, exit.
if (process.argv[2] === '--child') {
  const schema = process.argv[3];
  const { Accounts } = await import('../backend/src/storage/accounts.js');
  const accounts = new Accounts({
    connectionString: config.databaseUrl,
    schema,
    adminConnectionString: config.databaseUrlAdmin,
    appRole: config.appRole,
  });
  // `init` is the contended call -- it is the one that runs the DDL.
  await accounts.init();
  // Not just init: a write proves the connection is usable, not merely that
  // the DDL returned.
  const r = await accounts.createUser({
    email: `u${process.pid}@example.com`,
    name: `user ${process.pid}`,
    password: 'pw-'.repeat(4),
  });
  await accounts.close();
  if (!r.ok) {
    console.error(`write failed: ${r.error}`);
    process.exit(3);
  }
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set. Run `neon env pull` first.');
  process.exit(1);
}

console.log('\nconcurrent schema initialisation'
  + `  (${OPENERS} openers x ${ROUNDS} rounds)\n`);

for (let round = 1; round <= ROUNDS; round++) {
  // A fresh schema each round: the interesting race is the one run when the
  // tables do not exist yet, and that happens once per schema.
  const { accountsSchema } = scratchSchemas(`contend_${round}`);
  await resetSchemas(accountsSchema);

  const results = await Promise.all(
    Array.from({ length: OPENERS }, () => new Promise((resolve) => {
      const child = fork(fileURLToPath(import.meta.url), ['--child', accountsSchema],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('exit', (code) => resolve({ code, stderr }));
    })),
  );

  const died = results.filter((r) => r.code !== 0);
  // The signature of the catalogue race, so a failure says what it was rather
  // than only that it happened.
  const raced = died.find((r) => /duplicate key|pg_type_typname|already exists|deadlock/i
    .test(r.stderr));
  check(`round ${round}: all ${OPENERS} initialisers survived`,
    died.length === 0,
    died.length
      ? `${died.length} died` + (raced
        ? `; first: ${raced.stderr.trim().split('\n').find((l) => l.trim()) ?? ''}`
        : '')
      : '');

  await resetSchemas(accountsSchema);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
