/**
 * Scratch Postgres schemas for the harnesses.
 *
 * WHAT THIS IS
 *
 * Every harness that spawns a server needs a clean slate to run against. Each
 * gets a throwaway SCHEMA in the project's database, dropped and recreated
 * before the run.
 *
 * Nothing is written to the working tree, so a harness cannot leak a scratch
 * database into `git status` however badly it fails.
 *
 * WHY THE NAMES ARE WHAT THEY ARE
 *
 * `t_<harness>_<engine>`. Prefixed so a human looking at the database can tell
 * a test schema from `yjs`, `ot` and `accounts` at a glance, and so
 * `dropAllScratch` can find them without a list to keep up to date.
 *
 * DELIBERATELY NOT UNIQUE PER RUN. A name with a timestamp in it would never
 * collide, and would also leave a new dead schema behind every single run --
 * on a shared database that is a mess that grows forever. A stable name that
 * is dropped on the way IN gives the same isolation, because the drop is what
 * guarantees the clean slate, and it self-limits to one schema per harness.
 *
 * The consequence is that two harnesses using the same name must not run at
 * the same time. They never did: `npm test` is sequential, and each harness
 * already owned a fixed port for the same reason.
 */
import { Db } from '../backend/src/storage/db.js';
import { config } from '../backend/src/config.js';

/** Everything this module creates starts with this, so it can be found again. */
export const SCRATCH_PREFIX = 't_';

const ident = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Names for one harness's pair of schemas.
 *
 * @param {string} harness  e.g. 'api' or 'comments'
 * @param {string} [engine] when a harness runs the same suite under both
 * @returns {{schema: string, accountsSchema: string}}
 */
export function scratchSchemas(harness, engine) {
  const base = `${SCRATCH_PREFIX}${ident(harness)}${engine ? '_' + ident(engine) : ''}`;
  return { schema: base, accountsSchema: `${base}_accounts` };
}

/**
 * Drop the given schemas so the next run starts empty.
 *
 * `CASCADE` because a schema holds tables and this is the whole point --
 * there is nothing in a scratch schema worth keeping by definition.
 */
/**
 * Dropping and creating schemas is DDL, so it needs the OWNER credential --
 * `DATABASE_URL` is now a runtime role that deliberately cannot do either.
 * The servers the harnesses spawn still run as that restricted role, so the
 * tests exercise production permissions rather than the owner's.
 */
function adminDb() {
  if (!config.databaseUrlAdmin) {
    throw new Error(
      'DATABASE_URL_ADMIN is not set. The test harnesses create and drop scratch '
      + 'schemas, which the least-privilege runtime role cannot do. Set it to the '
      + 'owner connection string (the DIRECT endpoint, not -pooler).');
  }
  return new Db({ connectionString: config.databaseUrlAdmin, schema: 'public', max: 2 });
}

export async function resetSchemas(...names) {
  const db = adminDb();
  try {
    for (const name of names.flat()) {
      if (!name) continue;
      if (!name.startsWith(SCRATCH_PREFIX)) {
        // A guard rather than a courtesy. This function drops schemas with
        // CASCADE, and a typo that reached it with 'yjs' would delete every
        // document in the project.
        throw new Error(`refusing to drop "${name}": not a ${SCRATCH_PREFIX}* scratch schema`);
      }
      await db.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
  } finally {
    await db.close();
  }
}

/**
 * The environment a spawned server needs to use a scratch schema.
 *
 * `PERSIST_WINDOW_MS: '0'` is the important one and is not incidental. The
 * server buffers appends for 25ms by default (see config.persistWindowMs), and
 * a harness that writes and then immediately asserts on what is in the log
 * would be racing that window. Zero is write-through, which is what these
 * assertions need.
 */
export function scratchEnv({ schema, accountsSchema, port, engine }) {
  return {
    DB_SCHEMA: schema,
    ACCOUNTS_SCHEMA: accountsSchema,
    PERSIST_WINDOW_MS: '0',
    // Rate limiting OFF for harnesses. Every one of them hammers a server
    // from 127.0.0.1, which is a single identity to the limiter, so a
    // production-shaped limit would make them fail in a way that has nothing
    // to do with what they are testing. The limiter itself is tested with
    // limits deliberately set to 2 and 3 -- see tools/rate-limit-test.mjs,
    // which does NOT use this helper's defaults.
    // NO REDIS for harnesses, even when the developer has one configured.
    //
    // A spawned server inherits this process's environment, so the moment
    // REDIS_URL lands in .env.local every harness would start talking to a
    // hosted Redis -- which makes a local run behave differently from CI (which
    // has no such secret), makes every assertion depend on a third party being
    // up, and spends a metered free-tier command budget on tests. The
    // in-process cache is what CI exercises and what an un-configured clone
    // exercises, so it is what the harnesses exercise.
    //
    // The Redis implementation is covered directly instead, by
    // tools/rate-limit-test.mjs, which reads REDIS_URL itself and asserts the
    // SAME contract against both caches.
    REDIS_URL: '',
    // The session cache OFF for harnesses, and this one is not just
    // convenience. Several harnesses invalidate a session by writing to the
    // sessions table DIRECTLY -- ageing a row past its expiry rather than
    // waiting thirty days -- which is an out-of-band change the cache cannot
    // see. Leaving the cache on would make those assertions fail for a reason
    // that has nothing to do with what they test, and, worse, the obvious
    // 'fix' would be to weaken the assertion. So the strict path stays the
    // one every existing security harness exercises, and the cached path gets
    // its own harness (tools/rate-limit-test.mjs) that asserts the two things
    // that actually matter: a hit returns the right user, and logout evicts
    // immediately rather than after the TTL.
    SESSION_CACHE_MS: '0',
    RATE_LIMIT_AUTH: '0',
    RATE_LIMIT_WRITE: '0',
    RATE_LIMIT_READ: '0',
    // The socket tier too. Several harnesses open dozens of connections in a
    // few seconds, which is exactly the shape this tier exists to refuse.
    RATE_LIMIT_SOCKET: '0',
    ...(port !== undefined ? { PORT: String(port) } : {}),
    ...(engine !== undefined ? { ENGINE: engine } : {}),
  };
}

/** Housekeeping: drop every scratch schema in the database. */
export async function dropAllScratch() {
  const db = adminDb();
  try {
    const rows = await db.all(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1 ORDER BY nspname`,
      [`${SCRATCH_PREFIX}%`]);
    for (const r of rows) await db.query(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`);
    return rows.map((r) => r.nspname);
  } finally {
    await db.close();
  }
}

// `node tools/test-schema.mjs --clean` drops the lot.
if (process.argv[1] && process.argv[1].endsWith('test-schema.mjs')
  && process.argv.includes('--clean')) {
  const dropped = await dropAllScratch();
  console.log(dropped.length ? `dropped: ${dropped.join(', ')}` : 'nothing to drop');
}
