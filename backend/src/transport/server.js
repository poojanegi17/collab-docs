/**
 * Transport entry point. Hand-written rather than `y-websocket`, because the
 * transport is where the network simulation and the op-visualisation view hook
 * in -- you cannot instrument a dependency you do not own.
 *
 * One Node http server carries both surfaces: a tiny read-only JSON API for the
 * landing page, and the WebSocket upgrade for everything that matters.
 *
 * ---------------------------------------------------------------------------
 * `startServer` IS ASYNC NOW, and so is the connection handler. Both follow
 * from storage being a network away rather than a file. The one genuinely
 * subtle consequence is dealt with at `wss.on('connection')` below -- read
 * that comment before changing anything there.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { toBytes } from '@collab/protocol';
import { Room } from './room.js';
import { Store } from '../storage/store.js';
import { Accounts } from '../storage/accounts.js';
import { BufferedStore } from '../realtime/update-buffer.js';
import { InProcessRoomRegistry } from '../realtime/room-registry.js';
import { InProcessPubSub } from '../realtime/pubsub.js';
import { createRedis } from '../cache/redis.js';
import { InProcessCache, RedisCache } from '../cache/cache.js';
import { RateLimiter, clientAddress } from './rate-limit.js';
import { createApi } from './api.js';
import { createEngine } from '../engines/index.js';
import { config } from '../config.js';

export async function startServer() {
  /*
   * Redis, or an in-process Map. See ADR-022 for why this is a choice rather
   * than an upgrade: on ONE instance the Map is faster, because it has no
   * network hop, and `REDIS_URL` unset is a supported configuration rather
   * than a degraded one.
   *
   * What Redis buys at `numInstances: 1` is not speed. It is that the session
   * cache and the rate-limit counters survive a restart -- and on a host that
   * spins an idle service down, a restart is a routine event rather than an
   * incident. A rate limit that resets every time the container sleeps is a
   * rate limit an attacker can reset on demand by waiting.
   */
  const redis = createRedis(config.redisUrl);
  const cache = redis
    ? new RedisCache(redis, { prefix: config.redisPrefix })
    : new InProcessCache();

  const rateLimiter = new RateLimiter(cache, config.rateLimits);

  const base = new Store({
    connectionString: config.databaseUrl,
    schema: config.schema,
    // Used only by init(), and only if set. In production it is not: the
    // schema is created by the pre-deploy migrate step and this process holds
    // a role that cannot create anything. See config.databaseUrlAdmin.
    adminConnectionString: config.databaseUrlAdmin,
    appRole: config.appRole,
  });
  const accounts = new Accounts({
    connectionString: config.databaseUrl,
    schema: config.accountsSchema,
    adminConnectionString: config.databaseUrlAdmin,
    appRole: config.appRole,
    // The session cache. Deliberately NOT namespaced by engine: a session is
    // valid on both servers because a user is not engine-specific (see
    // db.js on why `accounts` is one schema and documents are two), so the
    // CRDT server and the OT server SHOULD share these entries.
    cache,
    cacheMs: config.sessionCacheMs,
  });
  // Schema creation is a round trip, so it cannot happen in a constructor.
  // Both are idempotent, and running them on every boot is what makes a deploy
  // to a host with an ephemeral filesystem a non-event.
  await base.init();
  await accounts.init();

  // Appends are batched from here on. Every read that could observe the log
  // flushes first -- see ../realtime/update-buffer.js, which is where that
  // rule lives so no caller has to remember it.
  const rooms = new InProcessRoomRegistry();

  // A batch the buffer has given up on is reported here rather than being
  // logged and forgotten. The room that owns the document stops serving it:
  // see Room.failPersistence.
  const store = new BufferedStore(base, {
    windowMs: config.persistWindowMs,
    onFailure: (docId, err) => {
      const room = rooms.get(docId);
      if (room) room.failPersistence(err);
      else console.error(`[store] lost updates for ${docId}: ${err?.message ?? err}`);
    },
  });

  const pubsub = new InProcessPubSub();

  const handleHttp = createApi({
    store,
    accounts,
    rooms,
    config,
    rateLimiter,
    makeEngine: (docId, persist) => createEngine(config.engine, docId, persist),
  });

  const httpServer = http.createServer((req, res) => { void handleHttp(req, res); });

  /*
   * `noServer` rather than `{ server }`, so the upgrade can be REFUSED.
   *
   * With `{ server }`, ws installs its own 'upgrade' listener at construction
   * and every upgrade becomes a WebSocket before this file gets a say. The
   * rate limiter lives in `handleHttp`, which is bound to the 'request' event
   * -- and an upgrade is not a request, so it never passed through the limiter
   * at all. That was a real hole: see the `socket` tier in ../config.js for
   * what it left open.
   *
   * Taking the listener means the guard runs BEFORE the handshake, so a
   * refused connection costs a 429 on a raw socket rather than a live
   * WebSocket that then has to be closed.
   */
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        const result = await rateLimiter.check('socket', clientAddress(req));
        if (!result.ok) {
          // A raw socket, so the HTTP response has to be written by hand --
          // there is no `res` before the handshake. `Retry-After` is included
          // for the same reason it is on the API: a client that is told how
          // long to wait can wait, and one that is not will hammer.
          const retry = Math.ceil(result.resetMs / 1000);
          socket.write('HTTP/1.1 429 Too Many Requests\r\n'
            + `Retry-After: ${retry}\r\n`
            + 'Connection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } catch (err) {
        // Never leave a half-upgraded socket open on an unexpected failure.
        console.error('[upgrade] failed:', err.message);
        try { socket.destroy(); } catch { /* already gone */ }
      }
    })();
  });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const docId = url.searchParams.get('doc') || 'demo';
    // Ours, always unique. The client-supplied id is display identity only and
    // is allowed to collide across tabs.
    const connId = randomUUID();

    /*
     * FRAMES THAT ARRIVE BEFORE THE ROOM IS READY.
     *
     * This is the one place an async admission path can drop a frame, so it is
     * handled explicitly rather than left to luck.
     *
     * Admitting a connection takes several awaits: the session lookup, the
     * tab check, the document read, the permission check, and the room's own
     * load. A client that opens a socket and immediately sends its first
     * update -- which is exactly what the client does -- will have that frame
     * emitted while those awaits are still outstanding.
     *
     * Attaching the listener SYNCHRONOUSLY and queueing is what keeps those
     * frames. Dropping early ones instead would lose the first keystrokes of
     * a fast typist, which is both data loss and almost impossible to
     * reproduce deliberately.
     */
    /** @type {any[]} */
    const early = [];
    let deliver = (data) => { early.push(data); };
    socket.on('message', (data) => deliver(data));

    /*
     * DEPARTURE, WIRED UP BEFORE THERE IS ANYWHERE TO DEPART FROM.
     *
     * `room.join` registers the connection synchronously and then awaits
     * `helloFor`, which is one or two Postgres queries. Attaching the close
     * listener after the join therefore leaves a round-trip-wide window in
     * which a disconnect is never noticed: the entry stays in `room.clients`
     * for the life of the process, the room never reports itself empty, and
     * so it is never evicted and never takes its closing snapshot.
     *
     * So the listener is attached now, and what it does is swapped in later.
     * `depart` is idempotent because the two paths can race each other: the
     * listener may fire while the admit path is still running, in which case
     * the admit path calls it directly on the way out.
     */
    let closed = false;
    let departed = false;
    let onClose = () => {};
    const depart = () => {
      if (departed) return;
      departed = true;
      onClose();
    };
    socket.on('close', () => { closed = true; depart(); });
    socket.on('error', (err) => console.error(`[client ${connId}]`, err.message));

    void (async () => {
      try {
        // Identity comes from the session token, not from the query string.
        //
        // The token is a query parameter because the browser WebSocket API
        // cannot set request headers -- there is no way to send an
        // Authorization header on an upgrade. That puts the token in this
        // server's request log, which is the accepted cost; the alternative (a
        // ticket endpoint that mints a single-use code) is the right fix and
        // is not worth it here.
        const user = await accounts.userForToken(url.searchParams.get('token'));

        // Opening a document id nothing knows about CREATES it, unowned.
        //
        // That is not a loophole bolted on -- it is what makes a document
        // reachable without an account (ADR-010), and the lab depends on it:
        // every replica pane invents a document id and expects to be able to
        // type in it. Without this a fresh id has no metadata row, so
        // `roleFor` correctly reports "no such document" and the socket is
        // refused, which presents as the lab silently failing to connect.
        //
        // `requireOwner` turns it off, and then documents can only be created
        // through the API, by someone signed in.
        //
        // A TAB id is the exception, and the reason is that the rule above is
        // about ids nobody has seen before. A tab id is not one of those: it
        // was minted by the API against a document that already exists, so an
        // id with no row is not a new document, it is a wrong answer -- a
        // deleted tab, or something invented. Creating a `docs` row for it
        // would make a tab into its own top-level document, which is precisely
        // what ADR-014 arranges for it not to be.
        const { docId: parentId, tabId } = Store.tabOf(docId);
        if (tabId && !(await store.getTab(tabId))) {
          socket.close(1008, 'no such tab');
          console.log(`[room ${docId}] refused: no such tab`);
          return;
        }
        if (!(await store.getDoc(parentId)) && !config.requireOwner) {
          await store.createDoc({ docId: parentId, title: parentId, ownerId: null });
        }

        const role = await store.roleFor(docId, user?.id,
          { requireOwner: config.requireOwner });
        if (!role) {
          // 1008 = policy violation. Closing with a reason means the client
          // can say "you do not have access" instead of retrying forever.
          socket.close(1008,
            user ? 'no access to this document' : 'sign in to open this document');
          console.log(`[room ${docId}] refused ${user?.email ?? 'anonymous'}`);
          return;
        }

        // Presence identity, which is NOT the same thing as authorisation.
        //
        // Authorisation is the account, decided above. Presence is per
        // connection, and one account can legitimately hold several at once:
        // the lab opens two or more replicas of a document as the same
        // signed-in person, and they have to appear as separate cursors or the
        // whole point of the page is lost. So the `client` label sub-divides
        // the account rather than replacing it -- `<user>:alice` and
        // `<user>:bob` are one person editing from two replicas, and neither
        // can do anything the account cannot.
        const label = url.searchParams.get('client');
        const clientId = user
          ? (label ? `${user.id}:${label}` : user.id)
          : (label ?? randomUUID().slice(0, 8));

        let room = rooms.get(docId);
        if (!room) {
          room = new Room(docId, store, {
            accounts,
            pubsub,
            // A room that cannot store what it is serving is dropped rather
            // than kept: its engine holds updates Postgres does not have, so
            // the next joiner must rebuild from storage instead of inheriting
            // that state. Deliberately no `destroy()` here -- destroy would
            // compact, and compacting a log with a hole in it is the one
            // thing that would make the loss permanent.
            onFatal: (id) => { if (rooms.get(id) === room) rooms.delete(id); },
          });
          rooms.set(docId, room);
        }
        // Rehydration is a read, so joining waits for it. Concurrent joiners
        // await the same promise rather than each triggering a load.
        await room.ready();

        // The client may have gone away during all of the above.
        if (closed) return;

        // Registered BEFORE the join that can be interrupted, so a
        // disconnect during `helloFor` still unwinds the room entry.
        onClose = () => {
          void room.leave(connId);
          // Keep empty rooms warm briefly: a page refresh should not cost a
          // full reload from storage, and a reconnect burst should not thrash
          // the store. That mattered against a local file and it matters more
          // against a network database.
          if (room.isEmpty) {
            setTimeout(() => {
              if (room.isEmpty && rooms.get(docId) === room) {
                void room.destroy();
                rooms.delete(docId);
                console.log(`[room ${docId}] evicted (idle)`);
              }
            }, 30_000).unref?.();
          }
        };

        await room.join(connId, clientId, socket, { role, user });

        // Closed during the join: the listener above already ran, while
        // `onClose` was still the no-op it is initialised to. Unwind here.
        if (closed) { depart(); return; }

        const onFrame = (data) => {
          // `handle` is async now, so a `try/catch` around the call catches
          // only what throws before the first await -- a rejection after it
          // escapes as an unhandled rejection and is reported nowhere. The
          // frame path is the last place that can afford a silent failure:
          // a dropped engine frame is an edit that does not reach anyone,
          // and it presents as "sync is broken" with nothing in the log.
          try {
            room.handle(connId, toBytes(data)).catch((err) => {
              console.error(`[room ${docId}] error handling frame from ${clientId}:`, err);
            });
          } catch (err) {
            console.error(`[room ${docId}] error handling frame from ${clientId}:`, err);
          }
        };
        // Drain what arrived while we were setting up, IN ORDER, then switch
        // to direct delivery.
        deliver = onFrame;
        for (const data of early.splice(0)) onFrame(data);

      } catch (err) {
        console.error(`[room ${docId}] failed to admit a connection:`, err);
        // 1011 = internal error. A client that cannot be admitted because the
        // database is unreachable should be told so it can retry, not left
        // holding an open socket that will never carry anything.
        try { socket.close(1011, 'server error'); } catch { /* already gone */ }
      }
    })();
  });

  await new Promise((resolve) => httpServer.listen(config.port, resolve));

  console.log(`collab server listening on ws://localhost:${config.port}  engine=${config.engine}`);
  console.log(`  http:     http://localhost:${config.port}/api/docs`);
  console.log(`  storage:  postgres schema "${config.schema}"`);
  console.log(`  accounts: postgres schema "${config.accountsSchema}"`);
  console.log(`  persist:  ${config.persistWindowMs}ms write buffer`);
  console.log(`  cache:    ${redis ? `redis (prefix "${config.redisPrefix}")` : 'in-process'}`);

  let shuttingDown = false;

  /*
   * Boot maintenance: adopt, index, sweep. RUNS AFTER THE PORT IS OPEN.
   *
   * All three are round trips to Postgres and the middle one is unbounded --
   * it reads every never-indexed document through an engine, one at a time.
   * Doing that before `listen` put the whole of it on the path to the first
   * response, on a host that suspends an idle instance and against a database
   * that suspends an idle compute. None of it is needed to serve a request:
   * adoption fixes a listing, indexing fixes a search, and the sweep deletes
   * documents nobody is looking at. So it became work the server does while it
   * is already answering, rather than work the first visitor waits for.
   *
   * Two things follow from the reordering, and both are handled here:
   *
   *   1. The sweep now runs against a live server, so a document somebody has
   *      open has to be exempt -- see the `isBusy` argument below, and the
   *      comment on `purgeEmptyUnowned` for why a guest who connected one
   *      second ago is indistinguishable from the rubbish it deletes.
   *   2. Shutdown has to wait for it. The indexing loop writes, and those
   *      writes have to reach the buffer before the buffer is drained, so
   *      `shutdown` awaits this promise before `store.close()`. The loop
   *      checks `shuttingDown` between documents, so a SIGTERM during a long
   *      sweep stops it at the next one instead of holding the drain open for
   *      the rest of them.
   */
  const maintenance = (async () => {
    // Adopt any document that has content but no metadata row. Without this, a
    // database from before the docs table looks empty in the new listing --
    // the updates are all still there, nothing knows they are documents.
    const adopted = await store.backfillDocs();
    if (adopted) console.log(`adopted ${adopted} pre-existing document(s) as unowned`);

    /*
     * Clear unowned documents with nothing in them.
     *
     * A room discards its own on the way out, but only for a document somebody
     * opened. These were left behind before that existed, and nothing will
     * ever open them again -- so nothing would ever notice they are empty.
     *
     * Two passes, because the storage layer cannot answer the question on its
     * own. It can see the search projection, but a document compacted into a
     * snapshot before that projection existed has no row in it, and "not
     * indexed" is not "empty". So anything unindexed is read through the
     * engine first, which is the one thing that can turn bytes back into text,
     * and indexed on the way past. Then the sweep runs, and every document it
     * looks at has a real answer behind it.
     *
     * The indexing is worth having on its own: those documents were not
     * searchable, and now they are.
     */
    const unindexed = await store.unindexedUnowned();
    let indexed = 0;
    for (const docId of unindexed) {
      if (shuttingDown) break;
      const engine = createEngine(config.engine, docId, () => {});
      try {
        engine.restore(await store.load(docId));
        await store.indexDoc(docId, engine.readDocument().toString());
        indexed++;
      } catch (err) {
        // A document that cannot be read is one the sweep must not judge. It
        // keeps its missing index row, and `purgeEmptyUnowned` leaves it alone.
        console.error(`[boot] could not read ${docId}: ${err.message}`);
      } finally {
        engine.destroy();
      }
    }
    if (indexed) console.log(`indexed ${indexed} document(s) that had never been`);

    if (shuttingDown) return;
    // Two guards, and the second is the one that actually holds. An open room
    // means somebody is in that document -- but the room is registered several
    // awaits AFTER the `docs` row is created, so a connection in flight is
    // invisible here. The age floor is what makes this independent of that
    // timing: nothing created in the last minute is swept, whatever the
    // registry says. See purgeEmptyUnowned.
    const swept = await store.purgeEmptyUnowned(
      (docId) => Boolean(rooms.get(docId)), 60_000);
    if (swept) console.log(`discarded ${swept} empty unowned document(s)`);
  })().catch((err) => {
    // Housekeeping failing must not take the server down -- every one of these
    // tasks is retried on the next boot anyway. This catch is also what makes
    // the promise safe to await in `shutdown`.
    console.error(`[boot] maintenance did not finish: ${err.message}`);
  });

  /**
   * @param {{exit?: boolean}} [opts] `exit: false` runs the same drain
   *   without killing the process, which is how tools/shutdown-test.mjs
   *   asserts the flush on a platform where SIGTERM cannot be delivered.
   *   The signal handlers below use the default.
   */
  const shutdown = async ({ exit = true } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nshutting down, snapshotting open documents...');
    try {
      // Sockets first. Destroying a room snapshots it, and the snapshot and
      // the sequence number it is stored against have to describe the same
      // instant; an edit arriving from a still-open socket part-way through
      // is exactly the thing that breaks that. Closing the listener and
      // evicting the clients removes the source rather than racing it.
      wss.close();
      // Boot maintenance writes through the buffer, so it has to be finished
      // before the drain below. It checks `shuttingDown` between documents, so
      // this waits for the document in flight, not for all of them.
      await maintenance;
      for (const room of [...rooms.values()]) {
        await room.evictAll('the server is restarting').catch(() => {});
      }
      // Then the rooms: destroying one snapshots it, which is a write, and
      // those writes have to be in the buffer before the buffer is drained.
      await Promise.all([...rooms.values()].map((room) => room.destroy()));
      // `close` flushes everything still queued. This is the line that decides
      // whether a clean shutdown loses the last few milliseconds of typing.
      await store.close();
      await accounts.close();
      await pubsub.close();
      // Last, because both of the above may still want to evict a key on the
      // way out. Closing a cache is never the reason a shutdown fails.
      await cache.close().catch(() => {});
    } catch (err) {
      console.error('shutdown error:', err.message);
    }
    if (!exit) { httpServer.close(); return; }
    httpServer.close(() => process.exit(0));
    // Render sends SIGTERM and then kills; do not be the reason it has to.
    setTimeout(() => process.exit(0), 2000).unref?.();
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  // `maintenance` is returned so a harness can await the sweep rather than
  // racing it -- `startServer` resolves before it has run.
  return {
    wss, httpServer, store, accounts, rooms, pubsub, shutdown, maintenance,
    cache, rateLimiter,
  };
}
