/**
 * Create the schemas the server needs, using the OWNER credential.
 *
 *   DATABASE_URL_ADMIN=... node tools/migrate.mjs
 *
 * WHY THIS IS A SEPARATE STEP
 *
 * The server connects as `collab_app`, which may SELECT, INSERT, UPDATE and
 * DELETE inside the three application schemas and do nothing else. It cannot
 * CREATE, DROP or ALTER, so it cannot run the DDL in backend/src/storage/
 * schema.js. That is the point: the credential the internet can reach should
 * not be able to drop a table.
 *
 * So DDL runs here instead, as the schema owner, from a place that is not the
 * request path -- Render's preDeployCommand, or by hand. It is idempotent, so
 * running it on every deploy is correct and running it twice is harmless.
 *
 * It also (re)issues the grants, so a schema created before the runtime role
 * existed is brought up to date rather than left unreadable.
 *
 * The admin URL must be the DIRECT endpoint. DDL through Neon's pooler is
 * transaction-pooled and misbehaves in ways that never mention pooling.
 */
import { Db } from '../backend/src/storage/db.js';
import { DOCS_DDL, ACCOUNTS_DDL, ensureSchema } from '../backend/src/storage/schema.js';
import { config } from '../backend/src/config.js';

const admin = config.databaseUrlAdmin;
if (!admin) {
  console.error(
    'DATABASE_URL_ADMIN is not set.\n'
    + 'It must be the OWNER connection string on the DIRECT (non-pooler) endpoint.');
  process.exit(1);
}
if (admin.includes('-pooler.')) {
  console.error(
    'DATABASE_URL_ADMIN points at the pooled endpoint. Migrations need the direct one:\n'
    + '  remove the "-pooler" from the host, or use DATABASE_URL_UNPOOLED from `neon env pull`.');
  process.exit(1);
}

// Which schemas exist is a deployment question, not a storage one: a CRDT
// server and an OT server each own theirs and share `accounts`. Both are
// created here so one migrate step serves either engine.
const JOBS = [
  { schema: process.env.DB_SCHEMA ?? 'yjs', ddl: DOCS_DDL },
  { schema: process.env.DB_SCHEMA_OT ?? 'ot', ddl: DOCS_DDL },
  { schema: config.accountsSchema, ddl: ACCOUNTS_DDL },
];

console.log(`migrating as owner, granting DML to "${config.appRole}"\n`);

for (const { schema, ddl } of JOBS) {
  // `ensureSchema` wants the runtime handle to test readiness against, and
  // the admin string to do the work with. Here they are the same connection
  // because this script IS the owner.
  const db = new Db({ connectionString: admin, schema, max: 2 });
  try {
    await ensureSchema(db, ddl, {
      adminConnectionString: admin,
      appRole: config.appRole,
    });
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
      [schema]);
    console.log(`  ok  ${schema.padEnd(10)} ${rows[0].n} tables`);
  } finally {
    await db.close();
  }
}

console.log('\nmigration complete.');
