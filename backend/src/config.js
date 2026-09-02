import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_YJS } from '@collab/protocol';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');

/**
 * Load DATABASE_URL from a dotenv file if the environment does not already
 * carry it.
 *
 * Render (and any other host) injects real environment variables, and those
 * always win -- this only covers local development and the test harnesses,
 * which spawn servers as child processes that inherit an environment nobody
 * has exported anything into. `neon env pull` writes `.env.local`, so that is
 * checked first, then `.env`.
 *
 * Deliberately minimal rather than a dotenv dependency: it reads `KEY=value`,
 * strips one layer of quotes, ignores comments, and does nothing else. A
 * connection string is a single line with no escapes, which is the whole of
 * what has to work here.
 */
function loadEnvFile() {
  if (process.env.DATABASE_URL) return;
  for (const name of ['.env.local', '.env']) {
    const file = path.join(repoRoot, name);
    if (!fs.existsSync(file)) continue;
    // `trim` below absorbs the carriage return on a CRLF file, so splitting
    // on the line feed alone is enough on both platforms.
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    if (process.env.DATABASE_URL) return;
  }
}
loadEnvFile();

/**
 * Turn every rate-limit tier off at once.
 *
 * A bare flag rather than `--flag=value`, because it is a switch, and an env
 * var beside it because CI sets one and npm scripts set the other.
 *
 * THIS EXISTS FOR THE BROWSER HARNESSES, and the reason is worth writing down.
 * Harnesses that spawn their own server get limits off through
 * tools/test-schema.mjs. The browser ones cannot: they drive real Chrome
 * against the SHARED dev servers, so fourteen harnesses' worth of page loads,
 * reconnects and lab replicas all land on one address inside one window. That
 * is indistinguishable from abuse to a limiter. The symptom is a harness that
 * passes alone and fails in the suite, showing an empty document and a
 * still-editable editor -- the upgrade refused, and the read-only state never
 * arriving.
 *
 * Production is unaffected: Render runs `npm start`, and only the `dev:*`
 * scripts pass this. The limiter's own behaviour is covered by
 * tools/rate-limit-test.mjs, which spawns a server with the limits set
 * deliberately low.
 */
const rateLimitsOff = process.argv.includes('--no-rate-limit')
  || process.env.RATE_LIMIT_DISABLED === 'true';

/**
 * `--flag=value` from argv. Flags beat env vars, which beat defaults.
 * Flags exist because npm scripts cannot set env vars portably on Windows,
 * and running a second server on another engine has to be one command.
 */
function flag(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

/**
 * A value that a human pasted into a hosting dashboard, with the whitespace
 * that came with it removed.
 *
 * Copying a line out of a `.env` file brings its line ending along, and the
 * field accepts it silently. What follows never mentions whitespace: a client
 * id with a trailing newline is `invalid_client` -- "the OAuth client was not
 * found" -- which reads as a deleted client or the wrong project; a connection
 * string with one fails to parse as a URL somewhere deep in the driver.
 *
 * Whitespace around any of these is always an accident, so removing it costs
 * nothing and turns an invisible failure into no failure at all. Empty after
 * trimming is treated as unset, which is what an empty dashboard field means.
 */
const pasted = (value) => value?.trim() || undefined;

export const config = {
  port: Number(flag('port') ?? process.env.PORT ?? 8080),
  engine: flag('engine') ?? process.env.ENGINE ?? ENGINE_YJS,
  /**
   * Postgres is the source of truth. There is no local-file fallback, and its
   * absence is deliberate: the deployment target wipes its disk on every
   * deploy, so a server that could quietly fall back to a file would be a
   * server that quietly loses every document the next time it restarts. Db
   * throws if this is unset.
   */
  databaseUrl: pasted(flag('database-url') ?? process.env.DATABASE_URL),

  /**
   * The OWNER connection, used only to create schemas and tables.
   *
   * `DATABASE_URL` is a least-privilege role: it may SELECT, INSERT, UPDATE
   * and DELETE in the three application schemas and nothing else. It cannot
   * CREATE, so it cannot run the DDL in schema.js. That is deliberate -- the
   * blast radius of a bug or an injection in the running server should not
   * include dropping a table -- and it means schema creation is a separate
   * step with a separate credential.
   *
   * Unset in production: on Render the schema is created by the pre-deploy
   * migrate step, and the running service never holds this. When it IS unset
   * and the schema is already there, boot proceeds normally; when it is unset
   * and the schema is MISSING, boot fails loudly rather than starting a
   * server that cannot store anything. See ensureSchema.
   *
   * Must be the DIRECT (non-pooled) endpoint: DDL through PgBouncer's
   * transaction pooling misbehaves in ways that do not name pooling.
   */
  databaseUrlAdmin: pasted(flag('database-url-admin') ?? process.env.DATABASE_URL_ADMIN),

  /**
   * The role that `DATABASE_URL` authenticates as, granted DML on each schema
   * as it is created. Only used while running DDL, so only meaningful when
   * `databaseUrlAdmin` is set.
   */
  appRole: process.env.DB_APP_ROLE ?? 'collab_app',

  /**
   * Origins allowed to call the API, comma-separated. Empty means "any",
   * which is what development wants and what this has always done. A
   * deployment that knows its front end's URL should set it.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  /**
   * Which schema this server's documents live in -- `yjs` or `ot`.
   *
   * One schema per engine, because an update log is engine-specific opaque
   * bytes and neither engine can read the other's rows (ADR-012). Defaults to
   * the engine name, so `--engine=ot` selects the OT store with no second
   * flag.
   */
  schema: flag('schema') ?? process.env.DB_SCHEMA
    ?? (flag('engine') ?? process.env.ENGINE ?? ENGINE_YJS),
  /**
   * Compact a document's update log into a single snapshot once it has this
   * many loose updates. Small on purpose so you can actually watch compaction
   * happen while typing instead of having to write 10k characters.
   */
  compactAfterUpdates: Number(process.env.COMPACT_AFTER ?? 200),
  /** Drop a client's presence if we have not heard from it in this long. */
  presenceTimeoutMs: 15_000,

  /**
   * How long the transport may hold outbound engine frames before flushing.
   *
   * The first limit `/scale` measures is broadcast fan-out: every keystroke is
   * relayed to everyone else, so traffic in one document grows with the square
   * of the people in it. Holding frames for a moment lets the engine merge
   * them, and one merged frame goes to the whole room instead of one frame per
   * client per keystroke.
   *
   * 50ms because that is under the ~100ms at which a remote cursor stops
   * feeling live, and long enough to catch a burst of typing. Set to 0 to turn
   * batching off entirely, which is how the "before" numbers in ADR-016 were
   * measured.
   *
   * Only engines that declare themselves `coalescible` are affected. OT is not.
   */
  broadcastWindowMs: Number(flag('broadcast-window') ?? process.env.BROADCAST_WINDOW_MS ?? 50),

  /**
   * Do not batch a room smaller than this.
   *
   * Batching sends ONE merged frame to EVERYONE, senders included, and in a
   * small room that echo costs more than the merge saves: at two clients the
   * naive relay sends 10 frames a second and the batched one sends 20. The
   * measurement in ADR-016 puts the crossover at five, so that is the
   * threshold -- read off a measurement rather than picked.
   *
   * Below it, frames go out immediately, which is also the lowest-latency
   * behaviour for the case that is overwhelmingly common: two people in a
   * document (ADR-016).
   */
  batchMinClients: Number(flag('batch-min-clients') ?? process.env.BATCH_MIN_CLIENTS ?? 5),

  /**
   * How long the search index may lag the document (ADR-017).
   *
   * Indexing is a full re-tokenise -- an inverted index cannot be appended to
   * one word at a time -- so it is debounced rather than run per keystroke.
   * This is the width of that window, and therefore the exact amount by which
   * a search can be out of date while somebody is typing.
   *
   * 2s because search is a navigational action, not a live view: nobody types
   * a word and searches for it in the same second, and the room reindexes
   * unconditionally when the last client leaves anyway. Set to 0 to index on
   * every persisted update, which is what the search harness does so it can
   * assert without sleeping.
   */
  searchIndexWindowMs: Number(
    flag('search-index-window') ?? process.env.SEARCH_INDEX_WINDOW_MS ?? 2000),

  /**
   * Accounts live in ONE database shared by every engine's server, because a
   * user is not engine-specific the way a document is. See accounts.js.
   */
  accountsSchema: flag('accounts-schema') ?? process.env.ACCOUNTS_SCHEMA ?? 'accounts',

  /**
   * How long an accepted update may sit in memory before it reaches Postgres.
   *
   * Zero is write-through: the append reaches Postgres before the room
   * acknowledges it, so a crash loses nothing -- at the price of a network
   * round trip on the path of every keystroke.
   *
   * 25ms buys back most of that -- a burst of typing becomes one multi-row
   * INSERT instead of one per character -- at the cost of a crash losing at
   * most 25ms of server-side log. See ../realtime/update-buffer.js for why
   * that is a smaller loss than it sounds (the clients still hold the state
   * and heal the log on reconnect) and for the Redis-backed version that
   * removes the caveat entirely.
   *
   * Set to 0 for a deployment that would rather have the durability, and for
   * any harness that asserts on what is in the log immediately after a write.
   */
  persistWindowMs: Number(
    flag('persist-window') ?? process.env.PERSIST_WINDOW_MS ?? 25),

  /**
   * The OAuth client id that Google ID tokens must name as their audience.
   *
   * NOT A SECRET, and treating it as one leads to the wrong design. It ships
   * in the front end's JavaScript, because the browser has to present it to
   * Google to get a token at all. What it does here is the other half of the
   * same fact: a token addressed to somebody else's client is a token this
   * server must refuse, and it cannot notice that without knowing its own id.
   *
   * Unset means Google sign-in is switched off, and `/api/auth/google` says so
   * rather than 500ing. That is the default for a checkout with no Google
   * project behind it, which includes every harness that does not test this.
   */
  googleClientId: pasted(process.env.GOOGLE_CLIENT_ID) ?? '',

  /**
   * Where to fetch Google's signing keys, and which issuers to believe.
   *
   * FOR THE HARNESS, AND FOR NOTHING ELSE. `tools/google-auth-test.mjs` stands
   * up a local issuer it holds the private key for, because the assertions
   * worth making are the refusals -- wrong key, wrong audience, `alg: none` --
   * and none of them can be produced by the real Google.
   *
   * These are server-side environment variables, so only whoever deploys the
   * service can set them, and pointing them anywhere but Google means
   * accepting identity assertions from whatever is there instead. They are
   * left as overrides rather than made test-only imports because the
   * alternative is a verifier with a special mode in it, and a security check
   * that behaves differently under test is a security check that is not being
   * tested.
   */
  googleJwksUri: process.env.GOOGLE_JWKS_URI ?? '',
  googleIssuers: (process.env.GOOGLE_ISSUERS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  /**
   * Redis, or nothing.
   *
   * UNSET IS A SUPPORTED CONFIGURATION, not a degraded one. Everything that
   * uses this has an in-process implementation that is correct on a single
   * instance -- and on a single instance an in-process Map is FASTER than
   * Redis, because it has no network hop (ADR-022). So this is switched on for
   * what Redis is actually better at: state that has to be shared between
   * processes, and state that should outlive one.
   *
   * Must be the TCP url (`rediss://...`), not a REST endpoint. TLS is implied
   * by the scheme; a plain `redis://` is for a local instance.
   */
  redisUrl: pasted(flag('redis-url') ?? process.env.REDIS_URL),

  /**
   * Namespace for every key this server writes.
   *
   * Postgres gets this separation from schemas -- `yjs`, `ot`, `accounts`.
   * Redis has no such thing, so it is a string prefix, and it matters for the
   * same reason: the two engines' servers and a developer's laptop can all be
   * pointed at one free-tier instance, and without this the CRDT server's
   * rate-limit counters and the OT server's would be the same counters.
   *
   * Accounts are deliberately NOT namespaced per engine -- see `sessionCache`
   * below -- so this defaults to a shared value rather than to the engine.
   */
  redisPrefix: process.env.REDIS_PREFIX ?? 'collab',

  /**
   * How long a session lookup may be served from cache.
   *
   * `Accounts.userForToken` is TWO sequential Postgres queries -- the session
   * row, then the user row -- and it runs on every authenticated API request
   * and every WebSocket upgrade. It is the most-called query in the system by
   * a wide margin, which makes it the one worth caching.
   *
   * The cost is staleness measured in exactly this many milliseconds: a
   * logout, a revoked session or a changed display name can be up to this far
   * behind. Logout and revocation delete the cache key explicitly, so what is
   * really bounded here is how long a session revoked BY ANOTHER PROCESS stays
   * usable -- which on one instance is never, and on several is this.
   *
   * 30s because it is long enough to collapse a burst of requests from one
   * page load into a single pair of queries, and short enough that nobody
   * reasons about it as a security boundary.
   */
  sessionCacheMs: Number(process.env.SESSION_CACHE_MS ?? 30_000),

  /**
   * Rate limits, per identity, per window.
   *
   * `auth` is the one that matters and the reason this exists: those routes
   * hash a password with scrypt at ~100ms of blocked event loop per attempt,
   * so they are a denial-of-service vector before they are a credential
   * stuffing one (see ../transport/rate-limit.js). Ten attempts in fifteen
   * minutes is far more than a person who has forgotten their password needs
   * and far less than an attack needs.
   *
   * `write` and `read` are set where a human cannot reach them and a script
   * can. They exist to bound the damage from something looping, not to police
   * ordinary use -- a fast typist opening a document with several tabs can
   * legitimately make dozens of requests in a few seconds.
   *
   * Set any limit to 0 to switch that tier off, which is what the harnesses
   * that make hundreds of requests in a second do.
   */
  rateLimits: {
    auth: {
      limit: rateLimitsOff ? 0 : Number(process.env.RATE_LIMIT_AUTH ?? 10),
      windowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS ?? 15 * 60_000),
    },
    write: {
      limit: rateLimitsOff ? 0 : Number(process.env.RATE_LIMIT_WRITE ?? 120),
      windowMs: Number(process.env.RATE_LIMIT_WRITE_WINDOW_MS ?? 60_000),
    },
    read: {
      limit: rateLimitsOff ? 0 : Number(process.env.RATE_LIMIT_READ ?? 600),
      windowMs: Number(process.env.RATE_LIMIT_READ_WINDOW_MS ?? 60_000),
    },
    /**
     * WebSocket upgrades.
     *
     * A separate tier because an upgrade is not a GET and costs something
     * quite different. It is not CPU-bound the way `/api/auth/login` is --
     * there is no scrypt on this path -- but each one runs several Postgres
     * queries, and, while `requireOwner` is false, opening an unknown document
     * id CREATES that document (ADR-010 makes that a feature: writing needs no
     * account). Unmetered, that is unbounded document creation by anyone who
     * can open a socket.
     *
     * Rate limiting is the right fix for that, and turning `requireOwner` on
     * is NOT: it would switch off guest documents altogether, which is the
     * product decision ADR-010 exists to record, and would also break the lab,
     * where every replica pane invents an id and expects to type in it.
     *
     * 120 a minute is two a second sustained. A person opening a document with
     * several tabs makes a handful; the lab's replica panes make more, which
     * is why this is not tighter.
     */
    socket: {
      limit: rateLimitsOff ? 0 : Number(process.env.RATE_LIMIT_SOCKET ?? 120),
      windowMs: Number(process.env.RATE_LIMIT_SOCKET_WINDOW_MS ?? 60_000),
    },
  },

  /**
   * When true, a document with no owner is inaccessible rather than open.
   *
   * Unowned documents are how the lab creates scratch pads and how databases
   * that predate accounts keep working. That is a development affordance, and
   * a deployment carrying real documents should turn it off -- which is why it
   * is a flag with a default rather than an assumption baked into the checks.
   */
  requireOwner: (flag('require-owner') ?? process.env.REQUIRE_OWNER ?? 'false') === 'true',
};
