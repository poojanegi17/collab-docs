/**
 * The Postgres schema.
 *
 * Kept in its own file rather than inline in a constructor, because it is DDL
 * that runs against a shared remote database rather than against something one
 * process owns. It is idempotent and safe to run on every boot -- deliberately
 * so, because that is what makes a deploy to an ephemeral host a non-event.
 *
 * THE TYPE CHOICES THAT ARE NOT THE OBVIOUS ONES
 *
 * Timestamps are `bigint`, not `timestamptz`. Every `created`/`updated`/
 * `deleted` column here is milliseconds since the epoch: `Date.now()` goes in
 * and `Number(row.created)` comes out in about forty places, and the driver
 * parses int8 back to Number (db.js). A date type would be tidier Postgres and
 * would change what all forty of those expressions mean.
 *
 * `resolved`, `orphaned` and `done` are 0/1 integers, not `boolean`, and are
 * read as `!!row.resolved` for the same reason.
 *
 * `updates.seq` is `bigint GENERATED ALWAYS AS IDENTITY`. It is the backbone
 * of the whole log: compaction preserves it, `archive` reuses it, and
 * `fullLog` concatenates the two back into one ordered history, so it has to
 * be monotonic and it has to survive rows being deleted beneath it.
 *
 * Document bytes are `bytea`. `pg` gives them back as a Buffer, which is a
 * Uint8Array, so the engines take them unchanged. See `toBytes` in db.js.
 *
 * FULL-TEXT SEARCH
 *
 * An ordinary table with a generated `tsvector` column, queried with
 * `body_tsv @@ to_tsquery(...)`, ranked with `ts_rank` and excerpted with
 * `ts_headline`. Prefix terms are `tok:*`.
 *
 * The text search configuration is `simple`, not `english`, and that is the
 * one choice here worth defending: `simple` folds case and accents and does
 * NOT stem. Under `english` a search for "running" starts matching "run" --
 * arguably nicer, and a different product decision from the one /docs makes,
 * which is that the search box finds the words you typed.
 *
 * The `tsvector` is a STORED GENERATED column, so it cannot drift from `body`.
 */

/** Schemas, and which server uses which. See db.js for why the split matters. */
export const SCHEMAS = { yjs: 'yjs', ot: 'ot', accounts: 'accounts' };

/**
 * Everything a document server needs. Runs against `yjs` or `ot`.
 *
 * `{table}` is expanded to `"schema"."table"` by Db#sql, so this one string
 * serves both engines without either being able to reach the other's rows.
 */
export const DOCS_DDL = `
  CREATE TABLE IF NOT EXISTS {updates} (
    seq     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id  text   NOT NULL,
    data    bytea  NOT NULL,
    created bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_updates_doc ON {updates} (doc_id, seq);

  CREATE TABLE IF NOT EXISTS {snapshots} (
    doc_id      text   PRIMARY KEY,
    data        bytea  NOT NULL,
    through_seq bigint NOT NULL,
    created     bigint NOT NULL
  );

  -- owner_id NULL means UNOWNED, and unowned is a real state rather than a
  -- missing value: the lab creates scratch documents with no account behind
  -- them, and everything created before this table existed has no owner
  -- either. Unowned documents are open; owned ones are not. See roleFor().
  CREATE TABLE IF NOT EXISTS {docs} (
    doc_id   text   PRIMARY KEY,
    title    text   NOT NULL,
    owner_id text,
    created  bigint NOT NULL,
    updated  bigint NOT NULL,
    deleted  bigint
  );
  CREATE INDEX IF NOT EXISTS idx_docs_owner ON {docs} (owner_id, updated DESC);

  -- The owner also gets a row here, so a permission check is one lookup
  -- rather than "check the ACL, then check ownership".
  CREATE TABLE IF NOT EXISTS {acl} (
    doc_id  text   NOT NULL,
    user_id text   NOT NULL,
    role    text   NOT NULL,
    granted bigint NOT NULL,
    PRIMARY KEY (doc_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_acl_user ON {acl} (user_id);

  -- Where compaction puts the updates it folds into a snapshot, instead of
  -- deleting them. Same seq numbers as the original rows, so archive and
  -- updates concatenate back into one ordered log. This is the whole basis of
  -- version history -- note there is no IDENTITY here, because the seq is
  -- carried over from {updates} rather than minted.
  CREATE TABLE IF NOT EXISTS {archive} (
    seq     bigint PRIMARY KEY,
    doc_id  text   NOT NULL,
    data    bytea  NOT NULL,
    created bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_archive_doc ON {archive} (doc_id, seq);

  CREATE TABLE IF NOT EXISTS {checkpoints} (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id    text   NOT NULL,
    seq       bigint NOT NULL,
    label     text,
    author_id text,
    data      bytea  NOT NULL,
    created   bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_checkpoints_doc ON {checkpoints} (doc_id, seq DESC);

  -- Comment threads live in the ENGINE's schema rather than the shared
  -- accounts one, because 'anchor' is an engine-specific opaque value: a
  -- Y.RelativePosition under the CRDT, a server-transformed index pair under
  -- OT. Neither engine can read the other's (ADR-012).
  CREATE TABLE IF NOT EXISTS {comment_threads} (
    id           text   PRIMARY KEY,
    doc_id       text   NOT NULL,
    anchor       text   NOT NULL,
    quote        text   NOT NULL,
    resolved     integer NOT NULL DEFAULT 0,
    orphaned     integer NOT NULL DEFAULT 0,
    author_id    text,
    author_name  text   NOT NULL,
    author_color text,
    created      bigint NOT NULL,
    updated      bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_threads_doc ON {comment_threads} (doc_id, created);

  CREATE TABLE IF NOT EXISTS {comments} (
    id           text   PRIMARY KEY,
    thread_id    text   NOT NULL,
    body         text   NOT NULL,
    author_id    text,
    author_name  text   NOT NULL,
    author_color text,
    created      bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_thread ON {comments} (thread_id, created);

  -- ADR-014: a tab IS a document. tab_id is the doc_id its content lives
  -- under, and this table says only which documents are tabs of which, in
  -- what order. A document with no rows here is ONE tab whose content is
  -- stored under the document's own id.
  CREATE TABLE IF NOT EXISTS {tabs} (
    tab_id   text   PRIMARY KEY,
    doc_id   text   NOT NULL,
    title    text   NOT NULL,
    position integer NOT NULL,
    created  bigint NOT NULL,
    updated  bigint NOT NULL,
    deleted  bigint
  );
  CREATE INDEX IF NOT EXISTS idx_tabs_doc ON {tabs} (doc_id, position);

  -- ADR-015. Scoped to the DOCUMENT, not the tab.
  CREATE TABLE IF NOT EXISTS {tasks} (
    id            text   PRIMARY KEY,
    doc_id        text   NOT NULL,
    body          text   NOT NULL,
    done          integer NOT NULL DEFAULT 0,
    done_by_id    text,
    done_by_name  text,
    done_at       bigint,
    author_id     text,
    author_name   text   NOT NULL,
    author_color  text,
    position      integer NOT NULL,
    created       bigint NOT NULL,
    updated       bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_doc ON {tasks} (doc_id, position, created);

  -- The search projection (ADR-017). Derived, not authoritative: dropping it
  -- loses nothing that replaying the logs cannot rebuild.
  --
  -- doc_id is the LOG id, so a tab indexes under its own id (ADR-014).
  -- parent_id is what a result must point at, because you open a document,
  -- not a log. Only body is searchable -- titles are matched live against
  -- {docs}, where a rename keeps them authoritative.
  CREATE TABLE IF NOT EXISTS {doc_search} (
    doc_id    text PRIMARY KEY,
    parent_id text NOT NULL,
    tab_id    text NOT NULL DEFAULT '',
    body      text NOT NULL,
    body_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED
  );
  CREATE INDEX IF NOT EXISTS idx_search_tsv    ON {doc_search} USING GIN (body_tsv);
  CREATE INDEX IF NOT EXISTS idx_search_parent ON {doc_search} (parent_id);
`;

/**
 * People. Runs against `accounts`, and both engine servers share it.
 *
 * `email COLLATE NOCASE` has no Postgres equivalent as a column property. The
 * `citext` extension is the usual answer and is avoided here because it needs
 * CREATE EXTENSION rights that a deployment role may not have. A unique index
 * on `lower(email)` gives the same guarantee -- one account per person however
 * they capitalised it -- using nothing but core Postgres, and the two lookups
 * that relied on the collation match `lower(email) = lower($1)` instead.
 */
export const ACCOUNTS_DDL = `
  CREATE TABLE IF NOT EXISTS {users} (
    id            text   PRIMARY KEY,
    email         text   NOT NULL,
    name          text   NOT NULL,
    color         text   NOT NULL,
    password_hash text,
    created       bigint NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON {users} (lower(email));

  CREATE TABLE IF NOT EXISTS {sessions} (
    token_hash text   PRIMARY KEY,
    user_id    text   NOT NULL,
    created    bigint NOT NULL,
    expires    bigint NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON {sessions} (user_id);

  -- password_hash is nullable above, because a user who signs in through a
  -- provider has no password. CREATE TABLE IF NOT EXISTS does not reconcile a
  -- table that is already there, so a database holding an older, stricter
  -- version of this column is brought into line here.
  --
  -- GUARDED, rather than run unconditionally. Dropping a constraint that is
  -- already absent is a no-op and would be idempotent enough on its own -- but
  -- ALTER TABLE takes an ACCESS EXCLUSIVE lock to decide that, and this DDL
  -- runs on EVERY boot of EVERY server. Two dev servers share this schema and
  -- start together, and every restart-and-recover harness boots again; making
  -- all of them queue behind a table lock for nothing is a cost with no
  -- upside. The catalogue read takes no lock, so the exclusive one is taken
  -- once, ever.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = '{users}'::regclass
        AND attname = 'password_hash'
        AND attnotnull
    ) THEN
      EXECUTE 'ALTER TABLE {users} ALTER COLUMN password_hash DROP NOT NULL';
    END IF;
  END $$;

  -- HOW SOMEBODY PROVES WHO THEY ARE, WHICH IS NOT WHO THEY ARE.
  --
  -- The same argument this schema already makes one level up: a document
  -- belongs to an engine and a person does not, so people live in their own
  -- schema. A credential belongs to a PROVIDER and a person does not, so
  -- credentials live in their own table. Without it, adding Google means
  -- adding a google_sub column to {users}, and the next provider means another
  -- column, and an account with two ways to sign in has no representation at
  -- all.
  --
  -- The primary key is (provider, subject) rather than an id of its own: one
  -- Google account is one identity, and making that a key rather than a
  -- uniqueness check is what stops two concurrent first-time sign-ins from
  -- creating two users for one person. The subject column holds Google's sub
  -- claim -- never the email, which a person can change and which Google
  -- explicitly says not to key on.
  -- No index on user_id, deliberately. Every read of this table is by the
  -- primary key -- "which user is this Google subject" -- and nothing asks the
  -- question the other way round, because listing or unlinking a person's
  -- identities is not a feature that exists. This DDL runs on every boot of
  -- every server, so an index kept in case it is wanted later is paid for on
  -- every one of them.
  CREATE TABLE IF NOT EXISTS {identities} (
    provider text   NOT NULL,
    subject  text   NOT NULL,
    user_id  text   NOT NULL,
    created  bigint NOT NULL,
    PRIMARY KEY (provider, subject)
  );
`;

/**
 * A stable 32-bit key for a schema name, for the advisory lock below.
 *
 * FNV-1a, computed here rather than with Postgres's `hashtext`, because
 * `hashtext` is an internal function with no compatibility promise and this
 * only has to agree with ITSELF across processes.
 *
 * Signed: `pg_advisory_xact_lock(int)` takes an int4, and a value above 2^31
 * overflows it.
 */
function lockKey(name) {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h | 0;
}

/**
 * Create the schema if it is not there, then the tables in it.
 *
 * Idempotent by design: every server runs this on boot, and on a host that
 * rebuilds the container on each deploy that is the only thing standing
 * between a fresh process and a working database.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ADVISORY LOCK. `CREATE TABLE IF NOT EXISTS` IS NOT CONCURRENCY-SAFE.
 *
 * This reads like a belt-and-braces flourish and is not. The `IF NOT EXISTS`
 * check and the creation that follows it are not atomic with respect to each
 * other, so two sessions that both find a table missing will both attempt to
 * create it -- and the loser does not get a polite no-op. It gets
 *
 *   duplicate key value violates unique constraint "pg_type_typname_nsp_index"
 *
 * a unique violation on an internal catalogue index. `CREATE SCHEMA IF NOT
 * EXISTS` and `CREATE INDEX IF NOT EXISTS` behave the same way.
 *
 * That is not a theoretical race here. `npm run dev` starts the CRDT server
 * and the OT server in parallel and they share the `accounts` schema, and a
 * redeploy restarts every instance at once. Without this lock,
 * tools/db-contention-test.mjs kills seven of eight simultaneous initialisers
 * -- and because this runs before the server listens, a process that loses is
 * a process that never comes up.
 *
 * `pg_advisory_xact_lock` is held for the transaction and released when it
 * ends, including when it aborts, so there is no leak path. Losers block for
 * the few milliseconds the DDL takes and then find everything already there.
 */
/**
 * Postgres error codes that all mean "somebody else created it first".
 *
 * Every one of these is a SUCCESS for our purposes: the object we wanted to
 * exist now exists. They are separated out because tolerating an error class
 * by code is very different from swallowing errors generally, and only these
 * may be tolerated -- a syntax error or a permission failure in the DDL must
 * still take the boot down loudly.
 */
const ALREADY_THERE = new Set([
  '23505', // unique_violation, on pg_namespace_nspname_index / pg_type_typname_nsp_index
  '42P06', // duplicate_schema
  '42P07', // duplicate_table
  '42710', // duplicate_object
]);

/**
 * Bring one schema up to date, using the OWNER credential if there is one.
 *
 * `DATABASE_URL` is a least-privilege role that cannot CREATE anything, so
 * the DDL below cannot run as the server's own connection. When
 * `adminConnectionString` is supplied the DDL runs over a short-lived owner
 * connection which is closed immediately afterwards; the server keeps only
 * its restricted pool.
 *
 * When it is NOT supplied -- the production case, where the schema was
 * created by the pre-deploy migrate step and the service holds no owner
 * credential -- this verifies the schema is present and returns. A missing
 * schema then fails loudly, because a server that cannot store anything
 * should not start and pretend otherwise.
 *
 * @param {import('./db.js').Db} db      the runtime (restricted) connection
 * @param {string} ddl                   the tables for this schema
 * @param {object} [opts]
 * @param {string} [opts.adminConnectionString] owner credential, direct endpoint
 * @param {string} [opts.appRole]        role to grant DML to as tables appear
 * @param {number} [opts.attempts]
 */
export async function ensureSchema(db, ddl, opts = {}) {
  const { adminConnectionString, appRole, attempts = 5 } = opts;

  if (!adminConnectionString) {
    if (await schemaIsReady(db)) return;
    throw new Error(
      `schema "${db.schema}" does not exist, and DATABASE_URL_ADMIN is not set so it `
      + 'cannot be created. Run `npm run migrate` with the owner credential first. '
      + '(The runtime role is deliberately not allowed to create schemas.)');
  }

  const { Db } = await import('./db.js');
  const admin = new Db({ connectionString: adminConnectionString, schema: db.schema, max: 2 });
  try {
    await runDdl(admin, ddl, attempts, appRole);
  } finally {
    await admin.close();
  }
}

/** Is the schema present and populated enough to serve from? */
async function schemaIsReady(db) {
  const row = await db.one(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
    [db.schema]);
  return (row?.n ?? 0) > 0;
}

const SAFE_ROLE = /^[a-z_][a-z0-9_]*$/;

async function runDdl(db, ddl, attempts, appRole) {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(async (tx) => {
        // Taken FIRST, and inside the same transaction as the DDL, so the
        // whole create-if-missing sequence is serialised against the other
        // processes that are booting at the same moment.
        await tx.query('SELECT pg_advisory_xact_lock($1)', [lockKey(db.schema)]);
        await tx.query(`CREATE SCHEMA IF NOT EXISTS "${db.schema}"`);
        await tx.query(ddl);

        // The runtime role owns nothing here, so every schema needs granting
        // as it is created -- including the throwaway schemas the harnesses
        // make, which is what lets the tests run as the restricted role
        // rather than proving the owner works.
        //
        // ALTER DEFAULT PRIVILEGES covers tables added by a later migration,
        // so this does not have to be remembered again.
        if (appRole) {
          if (!SAFE_ROLE.test(appRole)) throw new Error(`unsafe role name: ${appRole}`);
          const s = `"${db.schema}"`;
          await tx.query(`GRANT USAGE ON SCHEMA ${s} TO ${appRole}`);
          await tx.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${appRole}`);
          await tx.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${appRole}`);
          await tx.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} `
            + `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`);
          await tx.query(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} `
            + `GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`);
        }
      });
      return;
    } catch (err) {
      /*
       * The lock above removes almost all of this contention and cannot be
       * relied on to remove all of it.
       *
       * `pg_advisory_xact_lock` is held by a TRANSACTION, and Neon's pooled
       * endpoint is PgBouncer in transaction mode. A transaction pins a server
       * connection for its duration, so in principle the lock and the DDL meet
       * on the same backend -- but that is a property of the pooler's
       * behaviour rather than a guarantee this code can make, and under load
       * the catalogue race still surfaced roughly one run in three.
       *
       * So the lock is the fast path and this is the correct one. Losing the
       * race is not a failure: the object exists, which is the entire
       * postcondition `ensureSchema` promises. Retrying re-runs the DDL, which
       * is idempotent by construction, and the loser finds everything already
       * in place.
       */
      if (!ALREADY_THERE.has(err?.code) || attempt >= attempts) throw err;
      // A short, slightly jittered pause so N racing processes do not simply
      // collide again in lockstep.
      await new Promise((r) => setTimeout(r, 25 * attempt + Math.random() * 25));
    }
  }
}
