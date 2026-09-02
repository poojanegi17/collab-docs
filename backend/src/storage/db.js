/**
 * The Postgres connection, and the one place that knows we are on Postgres.
 *
 * Many callers share one scarce resource here -- a connection pool -- and
 * Postgres arbitrates it.
 *
 * WHY POSTGRES IS THE SOURCE OF TRUTH, AND WHY THAT IS NOT NEGOTIABLE
 *
 * The deployment target has an ephemeral filesystem: it is wiped on every
 * deploy and every restart. Anything stored on that disk -- including the
 * append-only update log, which is the actual content of every document --
 * would not survive a deploy. So everything durable lives here, and anything
 * in front of this layer (Redis, see ../realtime/) is a cache, a transport or
 * a buffer, never the record.
 *
 * SCHEMAS, NOT DATABASES
 *
 * Three schemas in one database, and the separation between them is
 * load-bearing:
 *
 *   yjs       the CRDT server's documents
 *   ot        the OT server's documents
 *   accounts  people, shared by both
 *
 * The engine split is not tidiness. An update log is engine-specific opaque
 * bytes and a comment anchor is an engine-specific opaque value (ADR-012), so
 * neither server can read the other's rows. Accounts are shared for the
 * opposite reason: a user is not engine-specific, and merging them into the
 * engine schemas would give the same email two different identities depending
 * on which port they signed in to.
 *
 * WHY TABLE NAMES ARE INTERPOLATED RATHER THAN `search_path`
 *
 * The obvious way to scope a connection to a schema is `SET search_path`. That
 * is a SESSION setting, and Neon's pooled endpoint is PgBouncer in transaction
 * mode -- a session is not guaranteed to be the same backend from one
 * statement to the next, so a `SET` issued on connect may silently not apply
 * to the query that follows it. Rather than depend on which endpoint the URL
 * happens to point at, every statement names its schema explicitly: SQL is
 * written with `{updates}` and expanded to `"yjs"."updates"` on the way out.
 * The schema name is validated once in the constructor and can never come from
 * a caller, so the interpolation cannot carry anything but a known identifier.
 */
import pg from 'pg';

/** Anything that is not obviously a bare identifier is refused outright. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Postgres hands `bigint` back as a string, because it does not fit in a
 * double. Every such column here -- `seq`, and every `created`/`updated`
 * millisecond timestamp -- is comfortably inside `Number.MAX_SAFE_INTEGER`,
 * and the rest of the codebase treats them as numbers. Parsing them at the
 * driver keeps `Number(row.seq)` meaning arithmetic rather than quietly
 * becoming `Number("12")`-shaped string handling.
 *
 * 20 is `int8`. Set once, globally, because it is a property of how this
 * application uses Postgres rather than of any one pool.
 */
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export class Db {
  /**
   * @param {object} opts
   * @param {string} opts.connectionString
   * @param {string} opts.schema  one of the schemas described above
   * @param {number} [opts.max]   pool size
   */
  constructor({ connectionString, schema, max = 10 }) {
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set. Postgres is the source of truth for this server '
        + '-- there is no local-file fallback. Run `neon env pull`, or set '
        + 'DATABASE_URL in the environment.');
    }
    if (!SAFE_IDENT.test(schema)) throw new Error(`unsafe schema name: ${schema}`);
    this.schema = schema;

    this.pool = new pg.Pool({
      connectionString,
      max,
      // Neon scales a branch's compute to zero when it is idle and takes a
      // moment to wake. A short connect timeout turns that ordinary cold start
      // into a boot failure, so this is deliberately generous.
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
    });

    // A pool that emits `error` with no listener takes the process down, and
    // an idle connection being closed by the far end is routine on a
    // serverless Postgres rather than exceptional. The pool discards the
    // broken connection by itself; this only stops it being fatal.
    this.pool.on('error', (err) => {
      console.warn(`[db ${this.schema}] idle client error: ${err.message}`);
    });
  }

  /** `{table}` -> `"schema"."table"`. See the header for why this is not search_path. */
  sql(text) {
    return text.replace(/\{([a-z_][a-z0-9_]*)\}/g, (_, name) => `"${this.schema}"."${name}"`);
  }

  /** @returns {Promise<import('pg').QueryResult>} */
  query(text, params = []) {
    return this.pool.query(this.sql(text), params);
  }

  /** The first row, or null. */
  async one(text, params = []) {
    const { rows } = await this.query(text, params);
    return rows.length ? rows[0] : null;
  }

  /** Every row. */
  async all(text, params = []) {
    const { rows } = await this.query(text, params);
    return rows;
  }

  /** How many rows a write touched. */
  async count(text, params = []) {
    const { rowCount } = await this.query(text, params);
    return rowCount;
  }

  /**
   * Run `fn` inside a transaction, on ONE connection.
   *
   * A pool gives no guarantee that two statements land on the same session.
   * Issuing `BEGIN` through `pool.query` and the next statement through
   * another `pool.query` can take two different connections, leaving an open
   * transaction stranded on one and running the work unwrapped on the other.
   *
   * So the callback is handed a client-scoped `tx` and must use it.
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    const tx = {
      query: (text, params = []) => client.query(this.sql(text), params),
      one: async (text, params = []) => {
        const { rows } = await client.query(this.sql(text), params);
        return rows.length ? rows[0] : null;
      },
      all: async (text, params = []) => {
        const { rows } = await client.query(this.sql(text), params);
        return rows;
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // Rollback is best-effort on purpose: if the connection itself is what
      // failed, this throws too, and the original error is the one worth
      // reporting.
      try { await client.query('ROLLBACK'); } catch { /* connection is gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * `bytea` in, `Buffer` out.
 *
 * The engines deal in `Uint8Array` and `pg` deals in `Buffer`. A Buffer IS a
 * Uint8Array, so the outbound direction needs nothing -- but `new
 * Uint8Array(buffer)` would copy the buffer's CONTENTS only if you are lucky
 * and its byteOffset is 0, and silently take the wrong window if it is not.
 * `Buffer.prototype.subarray`-backed views are common enough coming out of a
 * socket that this is worth doing properly rather than hoping.
 */
export function toBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}
