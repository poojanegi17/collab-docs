/**
 * Users and sessions.
 *
 * Deliberately a SEPARATE schema from the document stores, and the reason is
 * structural rather than tidiness: a document belongs to an engine, because its
 * update log is engine-specific bytes only that engine can read. A user does
 * not. Running the CRDT server and the OT server side by side means two
 * document schemas, and if accounts lived inside them you would have two
 * disjoint sets of people -- the same email would be two different users
 * depending on which port you happened to sign in to.
 *
 * So: the `yjs` and `ot` schemas hold documents, the `accounts` schema holds
 * people, and both servers point at the same one.
 *
 * Passwords are scrypt-hashed with a per-user salt. Session tokens are stored
 * HASHED, never in the clear: a leaked database should not hand out live
 * sessions, and the server never needs the original token for anything except
 * comparing it against what a request presented.
 *
 * ---------------------------------------------------------------------------
 * CASE-INSENSITIVE EMAIL, AND HOW IT IS ENFORCED. Postgres has no per-column
 * case-insensitive collation without the `citext` extension, which needs
 * CREATE EXTENSION rights a deployment role may not have. So the guarantee is
 * a unique index on `lower(email)` (see schema.js) plus an explicit
 * `lower(email) = lower($1)` in the two lookups that depend on it. Write one
 * of those lookups without the `lower()` and you get two accounts for one
 * person, capitalised differently.
 *
 * SESSIONS SURVIVE A DEPLOY, because they live in Postgres like everything
 * else durable. On a host that wipes its disk, anywhere else would mean every
 * deploy signing everybody out.
 */
import {
  randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash,
} from 'node:crypto';
import { Db } from './db.js';
import { ACCOUNTS_DDL, ensureSchema } from './schema.js';

/** scrypt cost. 2^15 is ~100ms here: slow enough to matter, fast enough to log in. */
const SCRYPT_N = 32768;
const KEY_LEN = 64;
const SALT_LEN = 16;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const scryptOpts = (n) => ({ N: n, r: 8, p: 1, maxmem: 256 * n * 8 });

/**
 * Stored as `N$salt$hash`, so the cost parameter travels with the hash.
 * Without it, raising the cost later would invalidate every existing password
 * rather than letting old ones verify at their original cost.
 */
function hashPassword(password, n = SCRYPT_N) {
  const salt = randomBytes(SALT_LEN);
  const key = scryptSync(password, salt, KEY_LEN, scryptOpts(n));
  return `${n}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [nRaw, saltRaw, keyRaw] = String(stored).split('$');
  const n = Number(nRaw);
  if (!n || !saltRaw || !keyRaw) return false;
  const salt = Buffer.from(saltRaw, 'base64');
  const expected = Buffer.from(keyRaw, 'base64');
  const actual = scryptSync(password, salt, expected.length, scryptOpts(n));
  // Constant time: an early exit leaks how many leading bytes matched.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Stable per-user colour, so a cursor looks the same in every document. */
const COLORS = ['#f87171', '#34d399', '#60a5fa', '#fbbf24', '#c084fc', '#2dd4bf', '#f472b6'];
function colorFor(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return COLORS[h % COLORS.length];
}

/** Never let `password_hash` leave this module. */
function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, color: row.color };
}

export class Accounts {
  /**
   * @param {{connectionString: string, schema?: string, max?: number,
   *   cache?: import('../cache/cache.js').Cache, cacheMs?: number}} opts
   *
   * `cache` is optional and the class is fully correct without it -- see
   * `userForToken`, which is the only method that reads it.
   */
  constructor({ connectionString, schema = 'accounts', max,
    adminConnectionString, appRole, cache, cacheMs = 0 } = {}) {
    this.db = new Db({ connectionString, schema, max });
    // See Store: DDL needs the owner, the runtime role cannot CREATE.
    this.adminConnectionString = adminConnectionString;
    this.appRole = appRole;
    // Caching is off unless BOTH are given. `cacheMs = 0` is the switch the
    // harnesses use to assert on session revocation without waiting out a TTL.
    this.cache = cacheMs > 0 ? cache ?? null : null;
    this.cacheMs = cacheMs;
  }

  /**
   * The cache key for a token.
   *
   * THE HASH IS NOT OPTIONAL. A raw session token is a bearer credential --
   * whoever holds it is the user -- and using it directly as a key would write
   * every live credential into Redis in plaintext, where they would show up in
   * `KEYS *`, in a provider's data browser, and in anything that ever dumps
   * the keyspace. The same `sha256` already protects them at rest in Postgres
   * (`token_hash`), and the same reasoning applies one layer out.
   */
  sessionKey(token) { return `sess:${sha256(token)}`; }

  /**
   * Idempotent, and it also sweeps expired sessions. Not the constructor's
   * job: the sweep is a round trip, and a constructor cannot await one.
   */
  async init() {
    await ensureSchema(this.db, ACCOUNTS_DDL, {
      adminConnectionString: this.adminConnectionString,
      appRole: this.appRole,
    });
    await this.db.query('DELETE FROM {sessions} WHERE expires < $1', [Date.now()]);
    return this;
  }

  /** @returns {Promise<{ok: true, user: object} | {ok: false, error: string}>} */
  async createUser({ email, name, password }) {
    email = String(email ?? '').trim();
    name = String(name ?? '').trim() || email.split('@')[0];
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'invalid email' };
    if (String(password ?? '').length < 8) {
      return { ok: false, error: 'password must be at least 8 characters' };
    }
    if (await this.#userByEmail(email)) return { ok: false, error: 'email already registered' };

    const user = {
      id: randomUUID(),
      email,
      name,
      color: colorFor(email.toLowerCase()),
      created: Date.now(),
    };
    // The read above is not a guarantee -- two signups for the same address
    // can both pass it and race to insert. The unique index on lower(email) is
    // what actually enforces one account per person, so a violation of it is
    // that race arriving, not a bug: report it the same way the check does.
    try {
      await this.db.query(
        'INSERT INTO {users} (id, email, name, color, password_hash, created) '
        + 'VALUES ($1,$2,$3,$4,$5,$6)',
        [user.id, user.email, user.name, user.color, hashPassword(password), user.created]);
    } catch (err) {
      if (err?.code === '23505') return { ok: false, error: 'email already registered' };
      throw err;
    }
    return { ok: true, user: publicUser(user) };
  }

  /** The one lookup that has to be case-insensitive. See the header. */
  #userByEmail(email) {
    return this.db.one('SELECT * FROM {users} WHERE lower(email) = lower($1)',
      [String(email ?? '').trim()]);
  }

  /** @returns {Promise<object|null>} the user, or null when credentials do not match */
  async authenticate(email, password) {
    const row = await this.#userByEmail(email);
    // A user who signed in with Google has no password, and `null` must not be
    // something `verifyPassword` gets to have an opinion about -- it splits on
    // `$` and would compare against garbage. Refused exactly like an unknown
    // email, with the same dummy hash and the same message, because "this
    // address exists but signs in another way" is a fact about somebody else's
    // account that a stranger guessing addresses must not be able to learn.
    if (!row || !row.password_hash) {
      // Hash anyway. Returning immediately for an unknown email makes account
      // existence measurable with a stopwatch.
      hashPassword(String(password ?? ''));
      return null;
    }
    if (!verifyPassword(String(password ?? ''), row.password_hash)) return null;
    return publicUser(row);
  }

  /**
   * Find or create the user behind a verified Google identity.
   *
   * EVERY ARGUMENT HERE IS ALREADY TRUSTED. This method does no verifying: it
   * is handed the claims out of an ID token whose signature, issuer, audience
   * and expiry have been checked (see ../auth/google-token.js), and it would
   * happily create an account for anything it is given. That split is
   * deliberate -- verification is cryptography and belongs with the JWKS, and
   * this is storage -- but it means this method must never be called from
   * anywhere except behind that verifier.
   *
   * THREE CASES, AND THE THIRD IS THE ONE WITH A DECISION IN IT.
   *
   *   known identity      -> that user, always. The `sub` is the key.
   *   unknown, new email  -> a new passwordless user, plus the identity.
   *   unknown, KNOWN email -> link Google to the existing password account.
   *
   * The third is account linking, and doing it wrong is account takeover: if
   * an attacker can get an ID token asserting an email they do not own, they
   * inherit whatever that address already owns here. Two things make it safe.
   * Google will not issue a token for an address it has not verified, and the
   * caller refuses any token whose `email_verified` is false -- so by the time
   * the address arrives here, Google has said it belongs to the holder. The
   * alternative -- refusing to link and reporting "email already registered"
   * -- is worse in the way that matters: it strands somebody outside their own
   * documents with no route back in.
   *
   * @param {{sub: string, email: string, name?: string}} claims
   * @returns {Promise<object>} the public user
   */
  async findOrCreateFromGoogle({ sub, email, name }, provider = 'google') {
    const subject = String(sub ?? '');
    if (!subject) throw new Error('google identity has no subject');

    const linked = await this.#userForIdentity(provider, subject);
    if (linked) return linked;

    const existing = await this.#userByEmail(email);
    if (existing) {
      await this.#linkIdentity(provider, subject, existing.id);
      return publicUser(existing);
    }

    const address = String(email ?? '').trim();
    const user = {
      id: randomUUID(),
      email: address,
      name: String(name ?? '').trim() || address.split('@')[0],
      color: colorFor(address.toLowerCase()),
      created: Date.now(),
    };
    try {
      // password_hash stays NULL. There is no password, and inventing an
      // unguessable one would be a credential nobody can use and everybody
      // has to store.
      await this.db.query(
        'INSERT INTO {users} (id, email, name, color, password_hash, created) '
        + 'VALUES ($1,$2,$3,$4,NULL,$5)',
        [user.id, user.email, user.name, user.color, user.created]);
    } catch (err) {
      // Two first-time sign-ins for one address racing each other. The unique
      // index on lower(email) is what actually decides; the loser reads back
      // the winner's row rather than failing a sign-in that should work.
      if (err?.code !== '23505') throw err;
      const won = await this.#userByEmail(address);
      if (!won) throw err;
      await this.#linkIdentity(provider, subject, won.id);
      return publicUser(won);
    }
    await this.#linkIdentity(provider, subject, user.id);
    return publicUser(user);
  }

  async #userForIdentity(provider, subject) {
    const row = await this.db.one(
      'SELECT user_id FROM {identities} WHERE provider = $1 AND subject = $2',
      [provider, subject]);
    return row ? this.getUser(row.user_id) : null;
  }

  /**
   * `ON CONFLICT DO NOTHING` rather than a read-then-insert: two sign-ins for
   * the same brand-new identity can both find it missing, and the primary key
   * on (provider, subject) is the thing that decides. A conflict means the
   * row we wanted is there, which is success.
   */
  #linkIdentity(provider, subject, userId) {
    return this.db.query(
      'INSERT INTO {identities} (provider, subject, user_id, created) '
      + 'VALUES ($1,$2,$3,$4) ON CONFLICT (provider, subject) DO NOTHING',
      [provider, subject, userId, Date.now()]);
  }

  /** @returns {Promise<string>} the session token. Only the caller sees it in full. */
  async startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    await this.db.query(
      'INSERT INTO {sessions} (token_hash, user_id, created, expires) VALUES ($1,$2,$3,$4)',
      [sha256(token), userId, now, now + SESSION_TTL_MS]);
    return token;
  }

  /**
   * @returns {Promise<object|null>} the user behind a token.
   *
   * THE HOTTEST QUERY IN THE SYSTEM. This runs on every authenticated API
   * request and every WebSocket upgrade, and it is two SEQUENTIAL round trips
   * -- the session row, then the user row -- because the second needs the
   * `user_id` the first returns. Since ADR-019 those are network round trips
   * rather than file reads, which is what makes it worth a cache.
   *
   * ONLY POSITIVE RESULTS ARE CACHED, and that asymmetry is deliberate. A hit
   * is a valid session, which is stable and worth remembering. A miss is an
   * invalid, expired or revoked token -- and caching those would let anyone
   * fill the cache with garbage keys by presenting random tokens, which is a
   * memory-exhaustion vector with a free "and the real sessions get evicted"
   * on top. Postgres answers a bad token quickly anyway; the row is not there.
   *
   * STALENESS IS BOUNDED BY `cacheMs` AND IS NOT A SECURITY BOUNDARY. Logout
   * evicts the key, so the case that remains is a session revoked by ANOTHER
   * process -- impossible on one instance, and at most `cacheMs` on several.
   * If a hard revocation guarantee is ever needed, the answer is to shorten
   * this to zero for the affected route, not to reason about the window.
   */
  async userForToken(token) {
    if (!token) return null;

    if (this.cache) {
      const hit = await this.cache.get(this.sessionKey(token));
      if (hit) return hit;
    }

    const row = await this.db.one(
      'SELECT * FROM {sessions} WHERE token_hash = $1', [sha256(token)]);
    if (!row) return null;
    if (Number(row.expires) < Date.now()) {
      await this.db.query('DELETE FROM {sessions} WHERE token_hash = $1', [row.token_hash]);
      return null;
    }
    const user = await this.db.one('SELECT * FROM {users} WHERE id = $1', [row.user_id]);
    if (!user) return null;
    const out = publicUser(user);

    if (this.cache) {
      // Never outlive the session itself. A session with four seconds left
      // must not be served for thirty because the cache was told thirty.
      const remaining = Number(row.expires) - Date.now();
      const ttl = Math.min(this.cacheMs, remaining);
      if (ttl > 0) await this.cache.set(this.sessionKey(token), out, ttl);
    }
    return out;
  }

  async endSession(token) {
    if (!token) return;
    // Evict BEFORE the delete, not after. If it ran after and the process died
    // in between, the row would be gone and the cache entry would survive --
    // a signed-out session that still authenticates until the TTL runs out.
    // This order can only ever leave a valid session uncached, which costs one
    // pair of queries and nothing else.
    if (this.cache) await this.cache.del(this.sessionKey(token));
    await this.db.query('DELETE FROM {sessions} WHERE token_hash = $1', [sha256(token)]);
  }

  async getUser(id) {
    const row = await this.db.one('SELECT * FROM {users} WHERE id = $1', [id]);
    return row ? publicUser(row) : null;
  }

  /**
   * Powers the share dialog. Prefix match only -- not a people directory.
   *
   * `ILIKE`, not `LIKE ... COLLATE NOCASE`. The prefix is escaped because a
   * `%` or `_` typed into the share box would otherwise be a wildcard, which
   * would turn a prefix match on somebody's address into a way to enumerate
   * every address. The original relied on the collation for the case half of
   * this and did not escape at all.
   */
  async searchByEmail(prefix) {
    const q = String(prefix ?? '').trim();
    if (q.length < 2) return [];
    const like = `${q.replace(/[#%_]/g, '#$&')}%`;
    return this.db.all(
      `SELECT id, email, name, color FROM {users}
       WHERE email ILIKE $1 ESCAPE '#' LIMIT 8`, [like]);
  }

  async close() {
    await this.db.close();
  }
}
