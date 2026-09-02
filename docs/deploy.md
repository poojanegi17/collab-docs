# Deploying

Three services and a database. The database is Neon and is not managed by
Render; everything else is in [`render.yaml`](../render.yaml).

```
collab-client   static  Vite build of frontend/           no secrets
collab-yjs      node    the CRDT server, every real doc   DATABASE_URL
collab-ot       node    the OT server, the lab only       DATABASE_URL
Neon Postgres   -       the source of truth               -
```

## The two database roles, and why there are two

`DATABASE_URL` authenticates as **`collab_app`**. It may `SELECT`, `INSERT`,
`UPDATE` and `DELETE` inside `yjs`, `ot` and `accounts`, and it may do nothing
else — no `CREATEDB`, no `CREATEROLE`, no `BYPASSRLS`, no `CREATE` in any
schema, no ownership of anything. It cannot create a table, drop one, alter
one, or read `pg_authid`. That is the credential the running server holds, and
therefore the credential an attacker who reached the server would hold.

Which means it cannot run the schema DDL. That is the point, not an
inconvenience, so schema creation is a separate step with a separate
credential: **`DATABASE_URL_ADMIN`**, the schema owner, on the **direct**
(non-`-pooler`) endpoint — DDL through PgBouncer's transaction pooling
misbehaves in ways that never mention pooling.

```bash
npm run migrate     # DATABASE_URL_ADMIN required; idempotent
```

**On the free plan this is run by hand**, before the first deploy and again
after any schema change. `preDeployCommand` is a paid feature: on free it is
not rejected, it is *ignored*, so a deploy that relies on it comes up against
a database with no schemas. `render.yaml` keeps the line in a comment for
whenever this moves to starter.

Either way it runs once, from `collab-yjs`'s side of the world, and creates
all three schemas — so `collab-ot` deliberately does not repeat it. Two
services migrating the same database in the same deploy is exactly the
catalogue race `ensureSchema`'s advisory lock exists to survive, and not
racing is better than winning.

If the schema is missing and `DATABASE_URL_ADMIN` is unset, the server
**refuses to start** and says so. It does not silently come up unable to
store anything.

### Recreating the runtime role

```sql
CREATE ROLE collab_app WITH LOGIN PASSWORD '...'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
REVOKE ALL ON DATABASE neondb FROM collab_app;
GRANT CONNECT ON DATABASE neondb TO collab_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

`npm run migrate` issues the per-schema grants, including
`ALTER DEFAULT PRIVILEGES`, so tables added by a later migration are covered
without anyone having to remember.

## Environment variables

### `collab-yjs` and `collab-ot` (server, secret)

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | `collab_app` role, **pooled** endpoint. |
| `DATABASE_URL_ADMIN` | migrations only | Owner, **direct** endpoint. Needed by `npm run migrate`. Leave unset on the service if you migrate from CI instead. |
| `PORT` | provided | Render sets it; `config.js` reads it. |
| `ENGINE` | yes | `yjs` or `ot`. |
| `DB_SCHEMA` | yes | `yjs` or `ot`. |
| `ACCOUNTS_SCHEMA` | no | Defaults to `accounts`. Shared by both engines. |
| `ALLOWED_ORIGINS` | recommended | Comma-separated. Unset means any origin. |
| `GOOGLE_CLIENT_ID` | if Google sign-in is on | The **same** value the client compiles in as `VITE_GOOGLE_CLIENT_ID`. Both have to be set: the browser presents the id to Google, and this server refuses any ID token that does not name it as its audience. Unset here, the button renders and `/api/auth/google` answers 501. Not a secret (ADR-020). |
| `REDIS_URL` | no | Optional; see below. Unset is a supported configuration. |
| `DB_APP_ROLE` | no | Defaults to `collab_app`. Only read while migrating. |
| `REQUIRE_OWNER` | no | `true` closes anonymous document creation and the unowned-document listing. Defaults to `false` (ADR-010 guest documents). |
| `PERSIST_WINDOW_MS` | no | Write-buffer window, default 25. `0` is write-through. |
| `COMPACT_AFTER` | no | Updates before compaction, default 200. |
| `BROADCAST_WINDOW_MS`, `BATCH_MIN_CLIENTS`, `SEARCH_INDEX_WINDOW_MS` | no | Tuning; see `config.js`. |

### `collab-client` (static, **public**)

| Variable | Notes |
|---|---|
| `VITE_API_URL_YJS` | e.g. `https://collab-yjs.onrender.com` |
| `VITE_API_URL_OT` | e.g. `https://collab-ot.onrender.com` |
| `VITE_GOOGLE_CLIENT_ID` | Google sign-in. Must equal the server's `GOOGLE_CLIENT_ID`. |
| `VITE_GOOGLE_API_KEY` | Drive import: the Picker browser key. Restrict it to this site's referrer in the Google console -- that, not secrecy, is what protects a browser key. |
| `VITE_GOOGLE_PROJECT_NUMBER` | Drive import: the project **number**, not the id. The Picker sends it as `appId`, which is what brings a picked file under the `drive.file` grant. |

Everything `VITE_`-prefixed is **compiled into the bundle and readable by
every visitor**. Only URLs belong here. `DATABASE_URL` in a `VITE_` variable
would ship the database password to the public internet.

Unset, the client falls back to `http://<hostname>:8080` and `:8081`, which is
what development wants and what will not work in production — the ports are
not reachable and a `ws://` socket from an HTTPS page is blocked as mixed
content before it leaves the browser.

## No disk

Nothing durable is written to the filesystem: `backend/src/` contains no
`writeFile`, `mkdir` or write stream at all. No Render disk is needed, and
wiping the filesystem loses nothing. That is the whole point of ADR-019: a file
written here would hold the only copy of a document and would not survive a
deploy.

## Single instance, deliberately

**Do not raise `numInstances`, and do not enable autoscaling.**

Rooms, presence and the pub/sub between them are in-process `Map`s
(`backend/src/realtime/`). Two instances of one engine would each hold some of
the people in a document and neither would know about the other. Two users
editing the same page would see nothing from each other — silently, with no
error anywhere, because the append-only log in Postgres would still be
perfectly correct. It presents as "collaboration is broken", not as a crash.

`RoomRegistry`, `PubSub` and `PresenceStore` are interfaces precisely so a
Redis implementation can be dropped in later. Until that exists, one instance
per engine.

## Redis, and what is allowed in it

`REDIS_URL` is **optional**. Unset, the server uses in-process implementations
that are correct — and on a single instance *faster*, having no network hop.
Set, it gets two things a Map cannot give:

- **the session cache survives a restart.** `Accounts.userForToken` is two
  sequential Postgres queries and runs on every authenticated request and every
  WebSocket upgrade; it is the most-called query in the system.
- **rate-limit counters survive a restart.** This one is not a nicety. On a
  host that spins an idle service down, a limit held in memory resets every
  time the container sleeps — so an attacker gets a fresh quota by waiting.

The rule from ADR-019 has not moved: **Postgres is the source of truth and
Redis may only ever be a cache.** Before putting anything in it, ask whether
the system still works if the key vanishes — because it can, through eviction,
a restart, or a free plan's command budget. If the answer is no, it does not
belong there.

Set `REDIS_PREFIX` if more than one deployment shares one instance. Postgres
gets that separation from schemas; Redis has no equivalent, so it is a string.

### Rate limits

| tier | routes | default |
|---|---|---|
| `auth` | `/api/auth/login`, `/api/auth/signup`, `/api/auth/google` | 10 / 15 min |
| `write` | every other non-GET | 120 / min |
| `read` | every GET | 600 / min |
| `socket` | WebSocket upgrades | 120 / min |

The `socket` tier is not a GET and is not counted as one — an upgrade is
refused *before* the handshake, as a plain HTTP 429 on the raw socket. It
exists because opening an unknown document id **creates that document** while
`REQUIRE_OWNER` is false, and unmetered that is unbounded creation by anyone
who can open a socket.

Do **not** "fix" that by setting `REQUIRE_OWNER=true` in production. That flag
switches off unowned documents altogether, which is the product decision
ADR-010 records — *writing needs no account* — and it also breaks the lab,
where every replica pane invents an id and expects to be able to type in it.
Rate limiting is the fix; the flag is a different feature.

`/api/health` is exempt — Render's health check and the keep-alive cron both
hit it. Limits are per client address, never per account: limiting by email
would let anyone lock a specific person out of their own account by burning
that email's quota. Set any of `RATE_LIMIT_AUTH`, `RATE_LIMIT_WRITE` or
`RATE_LIMIT_READ` to `0` to switch a tier off, which is what the harnesses do.

The limiter **fails open**: if the shared counter is unreachable it falls back
to a per-process counter rather than refusing traffic, because a Redis outage
taking the site down is worse than the attack being defended against.

## Cold starts, and why there is a cron

Two suspensions stack on the first visit to an idle site, and they are three
orders of magnitude apart:

| | idle timeout | first-request cost |
|---|---|---|
| Render (free) | ~15 min | tens of seconds — schedule a container, boot Node |
| Neon | 5 min | a few hundred ms |

Read the right-hand column before optimising anything. Render's wake dominates,
and a cache in front of Postgres does not touch it — the container still has to
start, and the boot path still has to reach Postgres to find out what it is
missing. ADR-022 has the full argument, including why an in-process `Map` beats
Redis while `numInstances` is 1.

Two things follow, and both are in the repository:

- **Boot maintenance runs after `listen`.** Adoption, back-indexing and the
  empty-document sweep are a background promise in `startServer`, not a
  precondition of opening the port. The sweep therefore takes an `isBusy`
  predicate, because an unowned document with no updates is exactly what a
  guest who connected a second ago has just created.
- **`.github/workflows/keepalive.yml`** pings `/api/health` every 10 minutes.
  That endpoint calls `store.listDocs`, so one request keeps the Render
  instance *and* the Neon compute warm. Set the `KEEPALIVE_URL` repository
  **variable** (not a secret — it is a public URL) or the job no-ops.

Caveats worth knowing before trusting it: GitHub delays scheduled runs at busy
times, so a 10-minute cron against a 15-minute timeout occasionally loses the
race; GitHub disables schedules on a repository with no pushes for 60 days, and
does not tell you; and free-tier instance hours (750/month against ~730 for an
always-awake service) are why only `collab-yjs` is pinged. `collab-ot` is the
lab's second engine and is left to sleep.

## Shutdown

Render sends `SIGTERM`, then kills. The handler closes the listener, evicts
clients, snapshots each open room and **flushes the write buffer** before
exiting — without that last part every deploy would lose the last
`PERSIST_WINDOW_MS` of typing in every open document. Asserted by
`tools/shutdown-test.mjs` (the signal half runs on Linux only; Windows cannot
deliver `SIGTERM` to a child at all).

The handler also waits for boot maintenance, since the back-indexing loop
writes through the same buffer it is about to drain. That loop checks the
shutdown flag between documents, so the wait is bounded by one document rather
than by the whole sweep.

`/api/health` is the health check. It returns counts and timings only — no
document ids, no titles, no user data.
