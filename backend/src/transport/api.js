/**
 * The JSON API: accounts, document lifecycle, sharing, and version history.
 *
 * Its own file rather than a corner of `server.js`, and the rule that decides
 * what may live here is load-bearing enough to state before anything else:
 *
 *   NOTHING THAT CHANGES A DOCUMENT'S CONTENT GOES OVER HTTP.
 *
 * Content changes go over the WebSocket, where the engine can see them, order
 * them, and transform them against concurrent edits. What lives here is
 * everything AROUND a document -- who owns it, what it is called, who may open
 * it, and what it said in the past. Restore looks like an exception and is not:
 * it hands the engine a document and lets the engine produce a normal edit.
 *
 * Auth is a bearer token rather than a cookie. In development the client is on
 * :5173 and this API on :8080, so an HttpOnly cookie would need SameSite=None
 * plus Secure, which needs HTTPS, which is a lot of ceremony to make a study
 * project work on localhost. The honest trade: a token in localStorage is
 * readable by any script that gets injected into the page, where an HttpOnly
 * cookie would not be. A single-origin deployment should switch to the cookie
 * -- `readToken` already accepts one.
 */
import { randomUUID } from 'node:crypto';
import { RichText } from '@collab/ot';
import { Store } from '../storage/store.js';
import { readMetrics } from './metrics.js';
import { createGoogleVerifier } from '../auth/google-token.js';
import { clientAddress, setRateLimitHeaders } from './rate-limit.js';

const MAX_BODY = 256 * 1024;

/**
 * Unowned documents returned by the listing.
 *
 * Small on purpose: this is where the lab and every test harness leave their
 * scratch pads, and there are hundreds of them. Only the ones a browser can
 * match against its own list are ever displayed -- see the GET /api/docs
 * route.
 */
const OPEN_LIMIT = 50;

/** When this process began serving. Reported by /api/health. */
const startedAt = Date.now();

/**
 * The routes that hash a password, and therefore the ones that cost ~100ms of
 * blocked event loop per request. A Set rather than a prefix match on
 * `/api/auth/`, because `logout` and `me` are in that namespace and are
 * cheap -- putting them in the strict tier would let a burst of page loads
 * exhaust a limit meant for attackers.
 */
const RATE_TIERS = {
  auth: new Set(['/api/auth/login', '/api/auth/signup', '/api/auth/google']),
};

export function createApi({ store, accounts, rooms, config, makeEngine, rateLimiter }) {
  /**
   * Built once, because it caches Google's signing keys and a per-request
   * verifier would refetch them on every sign-in. Null when no client id is
   * configured, which is how the route below knows to say the feature is off
   * rather than to fail in the middle of it.
   */
  const googleVerifier = config.googleClientId
    ? createGoogleVerifier({
      clientId: config.googleClientId,
      ...(config.googleJwksUri ? { jwksUri: config.googleJwksUri } : {}),
      ...(config.googleIssuers?.length ? { issuers: config.googleIssuers } : {}),
    })
    : null;

  /** @returns {Promise<any>} parsed JSON body, or {} */
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });

  /**
   * The caller's role, re-asked once if the document appeared underneath us.
   *
   * The editor mounts and immediately fetches comments, tabs and tasks for a
   * document whose metadata row the SOCKET creates lazily on connect (see
   * server.js). Those three routes have always raced that create, and each
   * handled it the same way: if there is no role AND no document, answer with
   * an empty result rather than a permissions error.
   *
   * That guard reads the state TWICE -- once through `roleFor`, once through
   * `getDoc` -- and each read is a network round trip, so there is a window of
   * hundreds of milliseconds between them for the socket's create to land in:
   * `roleFor` sees no document and returns null, `getDoc` then sees the
   * document that has just been created, the "no document" branch does not
   * apply, and the request is refused with a 403 for a document the caller can
   * in fact open. The symptom is every freshly opened document logging a
   * permissions error for its comments pane.
   *
   * Asking again is the fix, and it is not a retry loop: the second answer is
   * taken from the state that now exists, whatever it says. A document that
   * really is someone else's still comes back null and is still refused.
   *
   * @returns {Promise<{role: string|null, exists: boolean}>}
   */
  const roleForRequest = async (docId, user) => {
    const opts = { requireOwner: config.requireOwner };
    const role = await store.roleFor(docId, user?.id, opts);
    if (role) return { role, exists: true };
    const doc = await store.getDoc(Store.tabOf(docId).docId);
    if (!doc) return { role: null, exists: false };
    return { role: await store.roleFor(docId, user?.id, opts), exists: true };
  };

  /**
   * The bearer token, and ONLY the bearer token.
   *
   * No cookie fallback, and that is a security property rather than a
   * simplification. `Access-Control-Allow-Origin: *` below is safe precisely
   * because credentials ride in a header the browser never attaches on its
   * own; a cookie IS attached on its own, on cross-origin writes too. The
   * moment anything started setting one, every state-changing endpoint would
   * be CSRF-able, with no token and no SameSite to stop it, and the wildcard
   * would go from harmless to load-bearing in the wrong way. Reading only the
   * header keeps "credentials are never ambient" true by
   * construction rather than by nobody having got round to it.
   */
  const readToken = (req) => {
    const auth = req.headers.authorization;
    return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  };

  const userFor = (req) => accounts.userForToken(readToken(req));
  // Returns a promise now -- `accounts.userForToken` is a query. Every
  // caller awaits it; there is no synchronous way to know who is asking.

  /**
   * Rebuild a document as it was at `seq`, without disturbing the live one.
   *
   * A throwaway engine restored from the nearest checkpoint. It shares the
   * document's id but nothing else -- note the no-op persist callback, because
   * reading history must never write to the log it is reading.
   */
  const documentAt = async (docId, seq) => {
    const engine = makeEngine(docId, () => {});
    engine.restore(await store.stateAt(docId, seq));
    const doc = engine.readDocument();
    engine.destroy();
    return doc;
  };

  /** The document's current content, from the live room if there is one. */
  const currentDocument = async (docId) => {
    const room = rooms.get(docId);
    if (room) return room.engine.readDocument();
    const engine = makeEngine(docId, () => {});
    engine.restore(await store.load(docId));
    const doc = engine.readDocument();
    engine.destroy();
    return doc;
  };

  /**
   * Who wrote each character (ADR-018).
   *
   * Prefers the LIVE room, and that preference matters more here than it does
   * for content. A cold engine restored from storage rebuilds the CRDT's
   * per-item client ids perfectly -- they are in the document -- but under OT
   * the identity map is repopulated from presence and a cold engine has never
   * seen a connected client. So a document nobody has open answers with real
   * runs and unresolved names, which is exactly the asymmetry ADR-018 is about
   * and is reported rather than papered over.
   */
  const currentAuthorship = async (docId) => {
    const room = rooms.get(docId);
    if (room) return room.engine.readAuthorship();
    const engine = makeEngine(docId, () => {});
    engine.restore(await store.load(docId));
    const out = engine.readAuthorship();
    engine.destroy();
    return out;
  };

  const currentSnapshot = async (docId) => {
    const room = rooms.get(docId);
    if (room) return room.engine.snapshot();
    const engine = makeEngine(docId, () => {});
    engine.restore(await store.load(docId));
    const bytes = engine.snapshot();
    engine.destroy();
    return bytes;
  };

  return async function handleHttp(req, res) {
    /*
     * The client is served from another origin: :5173 in development, a
     * separate static site in production. Credentials ride in the
     * Authorization header and never in a cookie (see readToken), so the
     * browser attaches nothing on its own and a wildcard origin grants an
     * attacker's page no authority it did not already have -- it can call
     * these endpoints, but only with a token it would have to have stolen
     * some other way, and reading the response of a credentialed request is
     * what the wildcard specifically does not allow.
     *
     * `ALLOWED_ORIGINS` narrows it anyway where the deployment knows its own
     * front end, because "safe because of a property of the auth scheme" is
     * worth less than "safe because the list is short". Unset, behaviour is
     * unchanged.
     */
    const origin = req.headers.origin;
    if (config.allowedOrigins?.length) {
      if (origin && config.allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    // Never `Allow-Credentials`. Nothing here authenticates by cookie, and
    // setting it would make the wildcard above illegal in every browser.
    res.setHeader('Vary', 'Origin');

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    /*
     * Rate limiting, before anything expensive happens.
     *
     * Placed here rather than inside the route handlers on purpose: a limiter
     * a route has to remember to call is one a new route will forget to call,
     * and the route that forgets will be the one that needed it. Everything
     * below this line is already inside the limit.
     *
     * BY ADDRESS ONLY, NOT BY ACCOUNT. Limiting login attempts per email is
     * the other obvious design and it is rejected, because it hands anyone a
     * way to lock a specific person out of their own account by burning that
     * email's quota from anywhere. Limiting by address means an attacker can
     * only ever deny service to themselves. It is weaker against a distributed
     * guessing attack spread over many addresses -- but that attack does not
     * threaten the event loop, which is what this is here to protect, and the
     * scrypt cost in accounts.js is what makes it expensive to run.
     */
    if (rateLimiter) {
      // The SHALLOW `/api/health` is exempt. It is Render's health check AND
      // the target of the keep-alive cron (ADR-022), so limiting it would mean
      // the platform rate-limiting itself into declaring the service unhealthy.
      //
      // `?deep=1` is NOT exempt, because it queries Postgres. An unmetered
      // route that queries Postgres is a way for a stranger to drain the
      // database's monthly compute quota -- which is the same failure the
      // keep-alive cron caused by accident, minus the accident.
      const shallowHealth = path === '/api/health'
        && url.searchParams.get('deep') !== '1';
      if (!shallowHealth) {
        const tier = RATE_TIERS.auth.has(path) ? 'auth'
          : method === 'GET' ? 'read'
            : 'write';
        const result = await rateLimiter.check(tier, clientAddress(req));
        setRateLimitHeaders(res, result);
        if (!result.ok) {
          return json(res, 429, {
            error: 'too many requests',
            retryAfterMs: result.resetMs,
          });
        }
      }
    }

    try {
      const handled = await route({ req, res, url, path, method, readBody, userFor });
      if (!handled) json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[api]', method, path, err);
      json(res, err.status ?? 500, { error: err.expose ? err.message : 'internal error' });
    }
  };

  async function route(ctx) {
    return (
      await authRoutes(ctx)
      || await docRoutes(ctx)
      || await shareRoutes(ctx)
      || await historyRoutes(ctx)
      || await commentRoutes(ctx)
      || await tabRoutes(ctx)
      || await taskRoutes(ctx)
      || await miscRoutes(ctx)
    );
  }

  /**
   * Every open room belonging to one document: the document's own, and one per
   * tab.
   *
   * Tabs are separate rooms because they are separate documents (ADR-014), so
   * "tell everyone editing this document" is a fan-out rather than a lookup.
   * Notifications that are ABOUT the document rather than about one tab's text
   * -- the tab list, the task list -- have to reach all of them, or a person
   * in tab three never learns that tab one was renamed.
   */
  function familyRooms(docId) {
    const parentId = Store.tabOf(docId).docId;
    const out = [];
    for (const [id, room] of rooms) {
      if (Store.tabOf(id).docId === parentId) out.push(room);
    }
    return out;
  }

  // ---- accounts -----------------------------------------------------------

  async function authRoutes({ req, res, path, method, readBody, userFor }) {
    if (path === '/api/auth/signup' && method === 'POST') {
      const body = await readBody(req);
      const result = await accounts.createUser(body);
      if (!result.ok) return json(res, 400, { error: result.error });
      const token = await accounts.startSession(result.user.id);
      return json(res, 201, { token, user: result.user });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req);
      const user = await accounts.authenticate(body.email, body.password);
      // One message for both "no such account" and "wrong password". Telling
      // them apart is a free account-existence oracle.
      if (!user) return json(res, 401, { error: 'incorrect email or password' });
      return json(res, 200, { token: await accounts.startSession(user.id), user });
    }

    /**
     * Sign in with a Google ID token.
     *
     * The body is `{ credential }` -- the JWT that Google Identity Services
     * handed the browser. It is verified here and nowhere else (see
     * ../auth/google-token.js), and on success this returns exactly what
     * /login returns: our own session token and our own user. Google is how
     * somebody proved who they are; it is not what the rest of the system
     * talks to. Nothing downstream -- sharing, ownership, roles on the socket
     * -- can tell this session apart from a password one, which is the
     * property that made this feature small (ADR-020).
     */
    if (path === '/api/auth/google' && method === 'POST') {
      if (!googleVerifier) {
        return json(res, 501, { error: 'google sign-in is not configured' });
      }
      const body = await readBody(req);
      let claims;
      try {
        claims = await googleVerifier.verify(body.credential);
      } catch (err) {
        // ONE message for every refusal, and the reason only to the log. The
        // reasons are things like "token is for a different client" and
        // "signature does not verify", and handing those back turns this route
        // into an oracle that helps somebody assemble a token that passes.
        console.warn('google sign-in refused:', err.message);
        return json(res, 401, { error: 'could not verify that Google sign-in' });
      }
      const user = await accounts.findOrCreateFromGoogle(claims);
      return json(res, 200, { token: await accounts.startSession(user.id), user });
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      await accounts.endSession(readToken(req));
      return json(res, 200, { ok: true });
    }

    if (path === '/api/me' && method === 'GET') {
      const user = await userFor(req);
      return json(res, user ? 200 : 401, user ? { user } : { error: 'not signed in' });
    }

    return false;
  }

  // ---- documents ----------------------------------------------------------

  async function docRoutes({ req, res, url, path, method, readBody, userFor }) {
    if (path === '/api/docs' && method === 'GET') {
      const user = await userFor(req);
      // Signed in: the documents you own or someone shared with you, plus the
      // unowned ones (the lab's scratch pads and the harnesses' leavings).
      // Signed out: only the unowned ones -- never a listing of other people's.
      const mine = user ? await store.listForUser(user.id) : [];

      /*
       * Unowned documents are returned, and nothing shows them wholesale.
       *
       * The documents page displays only the ones the BROWSER knows it opened,
       * matched against `local-docs.js` -- the rest are the lab's scratch pads
       * and the test harnesses' leavings, and nobody using the site has any
       * relationship to them. They are still sent because the server cannot
       * tell the difference: "this browser opened it" is not a fact the server
       * has, which is precisely why that list lives in localStorage.
       *
       * The cap therefore now costs something it did not before -- a document
       * older than the fifty most recently touched unowned ones falls out of
       * the response, and it is the only place its owner would see it. The
       * client puts those back from its own list.
       */
      const open = (await store.listUnowned(OPEN_LIMIT))
        .map((d) => ({ ...d, role: 'editor', unowned: true }));
      // Stored size comes from the log aggregate, which the docs table does
      // not duplicate. Without it every consumer of this listing renders
      // "NaN KB".
      //
      // Tab content is stored under an id of its own, so a document's size is
      // the sum over its family. Keying by the raw log id instead would report
      // a five-tab document as the size of its first tab (ADR-014).
      const sizes = new Map();
      for (const d of await store.listDocs(1000)) {
        const parentId = Store.tabOf(d.docId).docId;
        sizes.set(parentId, (sizes.get(parentId) ?? 0) + d.bytes);
      }

      // Resolve owners once rather than per row: a listing is overwhelmingly
      // one or two distinct owners repeated, and this is the hot path for the
      // documents page.
      const owners = new Map();
      // Async now, and still resolving each owner exactly once: the Map
      // caches the PROMISE, so N rows with the same owner still make one
      // query rather than N racing ones.
      const ownerOf = (id) => {
        if (!id) return null;
        if (!owners.has(id)) owners.set(id, accounts.getUser(id));
        return owners.get(id);
      };

      /*
       * How much text each document holds and how it starts, so a listing can
       * tell an empty document from a written one and show a little of it.
       *
       * Reported, not enforced. This route answers "what can you open", and a
       * document you own with nothing in it is still a document you own -- the
       * first version of this filtered them out here and broke that promise
       * three ways at once, because there is no way to WRITE content over this
       * API at all. Text arrives through the engine socket, so an API-created
       * document is empty by construction and filtering here made it invisible
       * to the API that had just created it.
       *
       * Which documents are worth showing is a question about a listing, and
       * it is answered in the listing. See DocsPage.jsx.
       */
      const text = await store.textSummaries();

      const docs = await Promise.all([...mine, ...open].map(async (d) => ({
        chars: text.get(d.docId)?.chars ?? 0,
        // The opening of the document, so a listing can show what is in one
        // rather than only what it is called.
        preview: text.get(d.docId)?.preview ?? '',
        ...d,
        bytes: sizes.get(d.docId) ?? 0,
        // How many tabs, so the listing can say so. `tabsFor` reports one for
        // a document that has never been split, which is the truth rather
        // than a default.
        tabs: (await store.tabsFor(d.docId)).length,
        // Everyone in the document, wherever they are in it. Counting only the
        // first tab's room would show "nobody here" while three people work in
        // tab two.
        online: familyRooms(d.docId)
          .reduce((n, room) => n + room.clients.size, 0),
        // Needed to say "shared by Ada". The id alone cannot be shown to a
        // person, and the client has no way to look it up -- there is no
        // endpoint that turns an arbitrary user id into a name, deliberately.
        owner: await ownerOf(d.ownerId),
      })));
      return json(res, 200, { engine: config.engine, port: config.port, user, docs });
    }

    /**
     * Create a document. A SESSION IS NOT REQUIRED.
     *
     * Writing something down is not an action that needs to know who you are.
     * Signed out you get a real document with a real slug id and a real title
     * -- it is simply unowned, which this system already has a precise meaning
     * for: no access list, so anyone with the link may edit (`store.roleFor`).
     *
     * The account is asked for one step later, at the point where it becomes
     * unavoidable: sharing needs somebody to share *from*, and being shared
     * *with* needs an address to grant to. See the claim route below.
     *
     * `requireOwner` turns anonymous creation off, and then this is a 401 for
     * everyone without a session.
     */
    if (path === '/api/docs' && method === 'POST') {
      const user = await userFor(req);
      if (!user && config.requireOwner) {
        return json(res, 401, { error: 'sign in to create a document' });
      }
      const body = await readBody(req);
      const docId = slugId(body.title);
      const doc = await store.createDoc({ docId, title: body.title, ownerId: user?.id ?? null });
      return json(res, 201, {
        doc: { ...doc, role: user ? 'owner' : 'editor', unowned: !user },
      });
    }

    /**
     * Search the documents this person has a role on (ADR-017).
     *
     * Above `docMatch`, for the same reason the trash is: a literal segment
     * that collides with an id pattern resolves as a document called
     * "search".
     *
     * A session is required, and that is not a policy bolted on -- the result
     * set IS the access list. There is no such thing as searching documents
     * in general here, only searching yours, so without a session there is no
     * set to search rather than a set we decline to show.
     *
     * Note what does NOT reach this route: the query never touches an engine,
     * a room, or a byte of an update log. Search reads the projection and
     * nothing else, which is why it costs the same under both engines and why
     * it works on documents nobody currently has open.
     */
    if (path === '/api/docs/search' && method === 'GET') {
      const user = await userFor(req);
      if (!user) return json(res, 401, { error: 'sign in to search your documents' });
      const q = url.searchParams.get('q') ?? '';
      return json(res, 200, { query: q, results: await store.searchDocs(user.id, q) });
    }

    /**
     * The trash.
     *
     * MUST stay above `docMatch` below, which is `/^\/api\/docs\/([^/]+)$/`
     * and would otherwise match this path and go looking for a document
     * called "trash". A literal segment that collides with an id pattern is
     * the standard way to get a 404 that looks like a storage bug.
     *
     * Session required and owner-scoped: a listing of deleted documents is a
     * listing of documents, and the rule everywhere else on this route is
     * that we never hand one person another person's.
     */
    if (path === '/api/docs/trash' && method === 'GET') {
      const user = await userFor(req);
      if (!user) return json(res, 401, { error: 'sign in to see deleted documents' });
      return json(res, 200, { docs: await store.listDeletedForUser(user.id) });
    }

    /**
     * Put a deleted document back.
     *
     * `undelete`, NOT `restore`, and the distinction is not pedantry: this
     * server already has `POST /api/docs/:id/restore`, which rolls a LIVE
     * document back to an earlier version (ADR-008). Two different operations,
     * two different subjects -- one takes a document you cannot open and makes
     * it openable, the other takes one you are reading and changes what it
     * says. Naming this one `restore` would shadow the version route
     * entirely, because `docRoutes` is consulted before `historyRoutes`.
     *
     * Owner only, and checked against the `docs` row directly rather than
     * through `store.roleFor`. `roleFor` answers null for a deleted document
     * -- correctly, because nobody may OPEN one -- so asking it here would
     * make every undelete a 403. This is the one operation whose whole subject
     * is a document you are not currently allowed to open.
     */
    const undeleteMatch = /^\/api\/docs\/([^/]+)\/undelete$/.exec(path);
    if (undeleteMatch && method === 'POST') {
      const docId = decodeURIComponent(undeleteMatch[1]);
      const user = await userFor(req);
      if (!user) return json(res, 401, { error: 'sign in to restore this document' });

      const doc = await store.getDoc(docId);
      if (!doc) return json(res, 404, { error: 'no such document' });
      if (doc.ownerId !== user.id) {
        return json(res, 403, { error: 'only the owner can restore' });
      }
      // Not deleted: a no-op rather than an error, matching `claimDoc`. Two
      // tabs open on the trash and both clicking Restore is an ordinary race,
      // not a mistake either of them made.
      if (!doc.deletedAt) return json(res, 200, { doc: { ...doc, role: 'owner' } });

      return json(res, 200,
        { doc: { ...(await store.restoreDeletedDoc(docId)), role: 'owner' } });
    }

    /**
     * Take ownership of an unowned document. This one DOES require a session,
     * because ownership is a statement about a person.
     */
    const claimMatch = /^\/api\/docs\/([^/]+)\/claim$/.exec(path);
    if (claimMatch && method === 'POST') {
      const docId = decodeURIComponent(claimMatch[1]);
      const user = await userFor(req);
      if (!user) return json(res, 401, { error: 'sign in to claim this document' });

      const result = await store.claimDoc(docId, user.id);
      // 409, not 403: the request was legitimate and would have succeeded a
      // moment earlier. The client's answer is "reload and see who owns it",
      // which is a different answer from "you are not allowed".
      if (!result.ok) return json(res, result.error === 'no such document' ? 404 : 409, result);

      // Everyone in the room learns their role changed. For the claimer that
      // is a promotion to owner; for any other anonymous editor it is an
      // eviction, because the document just stopped being open to the world.
      await rooms.get(docId)?.recheckAccess();
      return json(res, 200, { doc: { ...result.doc, role: 'owner' } });
    }

    /**
     * Fill an EMPTY document with imported content (ADR-021).
     *
     * THE RULE AT THE TOP OF THIS FILE SAYS CONTENT DOES NOT GO OVER HTTP, AND
     * THIS ROUTE CARRIES CONTENT. Worth being straight about rather than
     * quietly making an exception.
     *
     * The rule's actual purpose is that content must reach the document
     * THROUGH THE ENGINE, so it can be ordered and transformed against
     * concurrent edits instead of clobbering them -- which is why version
     * restore, further down, is not an exception either: it hands the engine a
     * document and lets the engine produce an ordinary edit. This does exactly
     * the same thing with `replaceWith`, and the only difference is where the
     * document came from. Restore's comes from the log; this one's comes from
     * a file the caller picked out of their Drive.
     *
     * The alternative was to have the browser type it in over the socket after
     * connecting. That is purer and worse: `EditorSync` has no rich-insert
     * primitive, so a real imported document becomes one text insertion
     * followed by hundreds of separate `format` calls, each its own operation
     * in the log and each individually visible to anybody else in the room.
     *
     * EMPTY ONLY. `replaceWith` is a replace, so pointing this at a document
     * with anything in it would destroy it. Restore may do that because
     * restoring IS overwriting and it checkpoints first; importing is supposed
     * to be additive, so a non-empty target is refused outright rather than
     * merged, overwritten, or silently appended.
     *
     * No session required, deliberately: creating a document needs no account
     * (ADR-010), so neither does filling the one you just created. The role
     * check is the same one every edit passes.
     *
     * The attribute VALUES in these runs are not checked here, and that is the
     * existing rule rather than an omission: sanitising happens at the render
     * boundary, because the input path is the one an attacker need not use
     * (ADR-011). A `javascript:` link posted straight to this route is dropped
     * by `attribute-values.js` in every browser that later renders it -- the
     * same place it is dropped when it arrives over the socket.
     */
    const importMatch = /^\/api\/docs\/([^/]+)\/import$/.exec(path);
    if (importMatch && method === 'POST') {
      const docId = decodeURIComponent(importMatch[1]);
      const user = await userFor(req);
      const role = await store.roleFor(docId, user?.id,
        { requireOwner: config.requireOwner });
      if (!canEdit(role)) return json(res, 403, { error: 'no access' });

      const body = await readBody(req);
      if (!Array.isArray(body.runs)) return json(res, 400, { error: 'runs required' });

      // An empty log is what "never been written to" means here. Cheaper than
      // reading the document back through an engine, and exact for the case
      // this guards: the client creates a document and imports into it before
      // anyone has opened a socket on it.
      if (await store.currentSeq(docId) > 0) {
        return json(res, 409, { error: 'this document already has content' });
      }

      let imported;
      try {
        imported = RichText.fromJSON(body.runs);
      } catch {
        return json(res, 400, { error: 'runs are not a document' });
      }
      if (!imported.length) return json(res, 400, { error: 'nothing to import' });

      const room = rooms.get(docId);
      if (room) {
        // Somebody already has it open -- the engine turns this into an
        // ordinary edit and the room fans it out, exactly as for a restore.
        await room.applyServerEdit(imported, user?.id);
      } else {
        // Nobody connected. Same shape as the restore route below: a
        // throwaway engine whose persist callback writes to the real log, so
        // the next client to open the document simply loads it. See there for
        // why the writes are collected rather than awaited inline.
        const writes = [];
        const engine = makeEngine(docId, (bytes) => {
          writes.push(store.appendUpdate(docId, bytes));
        });
        engine.restore(await store.load(docId));
        engine.replaceWith(imported, user?.id);
        await Promise.all(writes);
        engine.destroy();
      }
      await store.touchDoc(docId);
      return json(res, 200, { ok: true, characters: imported.length });
    }

    /**
     * Authorship for one document (ADR-018).
     *
     * Requires the same role as reading the document, because that is what it
     * is: knowing who wrote a sentence is not a lesser fact about a document
     * than knowing what the sentence says.
     *
     * `supported: false` is a real answer, not an error. An engine that cannot
     * attribute says so, and the UI tells the reader that rather than showing
     * an empty document as though nobody had written any of it.
     */
    const authorsMatch = /^\/api\/docs\/([^/]+)\/authorship$/.exec(path);
    if (authorsMatch && method === 'GET') {
      const docId = decodeURIComponent(authorsMatch[1]);
      const user = await userFor(req);
      const role = await store.roleFor(docId, user?.id, { requireOwner: config.requireOwner });
      if (!role) return json(res, 403, { error: 'no access' });

      const authorship = await currentAuthorship(docId);
      if (!authorship) return json(res, 200, { supported: false, engine: config.engine });
      return json(res, 200, { supported: true, engine: config.engine, ...authorship });
    }

    const docMatch = /^\/api\/docs\/([^/]+)$/.exec(path);
    if (docMatch) {
      const docId = decodeURIComponent(docMatch[1]);
      const user = await userFor(req);
      const role = await store.roleFor(docId, user?.id, { requireOwner: config.requireOwner });

      if (method === 'GET') {
        // A document with content but no metadata row can still be opened:
        // the lab creates rooms on demand, and `backfillDocs` adopts anything
        // that slipped through. Report it as unowned rather than 404, or the
        // lab breaks.
        const doc = await store.getDoc(docId);
        if (!doc) return json(res, 200, { doc: null, role: config.requireOwner ? null : 'editor' });
        if (!role) return json(res, 403, { error: 'no access' });
        return json(res, 200, { doc, role });
      }

      if (method === 'PATCH') {
        if (!canEdit(role)) return json(res, 403, { error: 'no access' });
        const body = await readBody(req);
        return json(res, 200, { doc: await store.renameDoc(docId, body.title) });
      }

      if (method === 'DELETE') {
        /*
         * An unowned document can be deleted by whoever has the link.
         *
         * That is not a loosening -- it is what unowned already means. There
         * is no access list, so anyone with the link may open and rewrite it
         * end to end; refusing to let them remove it protected nothing and
         * left a guest with no way to tidy up after themselves.
         *
         * It is PURGED rather than soft-deleted, because the trash is scoped
         * to an owner and an unowned document put in one could never be seen
         * again by anybody. A tombstone nobody can reach is not a safety net,
         * it is a leak -- so this says plainly that it does not come back, and
         * the dialog on the way in says so too.
         */
        const doc = await store.getDoc(docId);
        if (!doc) return json(res, 404, { error: 'no such document' });

        if (!doc.ownerId) {
          for (const room of familyRooms(docId)) room.evictAll('document deleted');
          await store.purgeDoc(docId);
          return json(res, 200, { ok: true, purged: true });
        }

        if (role !== 'owner') return json(res, 403, { error: 'only the owner can delete' });
        await store.deleteDoc(docId);
        // Disconnect anyone still in the room, or they would keep editing a
        // document that no longer appears anywhere. Every tab's room too:
        // deleting the document deletes all of it, and a client left in tab
        // three would otherwise keep typing into a document that is gone.
        for (const room of familyRooms(docId)) room.evictAll('document deleted');
        return json(res, 200, { ok: true });
      }
    }

    return false;
  }

  // ---- sharing ------------------------------------------------------------

  /**
   * Why the owner check here is not just `role !== 'owner'`.
   *
   * An unowned document reports `editor` for everyone, so the bare check
   * answers "only the owner can share" -- which is true and useless, because
   * there is no owner and the reader has no way to become one from that
   * sentence. Sharing is the step that requires an account, and this is where
   * the product says so, in the order a person can act on: sign in, claim,
   * then share.
   */
  async function shareGuard(docId, user) {
    const doc = await store.getDoc(docId);
    if (!doc || doc.deletedAt) return { error: 'no such document', status: 404 };
    if (!doc.ownerId) {
      return user
        ? { error: 'claim this document before sharing it', status: 409, claimable: true }
        : { error: 'sign in to share this document', status: 401, claimable: true };
    }
    if (await store.roleFor(docId, user?.id,
      { requireOwner: config.requireOwner }) !== 'owner') {
      return { error: 'only the owner can change sharing', status: 403 };
    }
    return null;
  }

  async function shareRoutes({ req, res, path, method, readBody, userFor }) {
    const match = /^\/api\/docs\/([^/]+)\/share$/.exec(path);
    if (!match) {
      const revoke = /^\/api\/docs\/([^/]+)\/share\/([^/]+)$/.exec(path);
      if (revoke && method === 'DELETE') {
        const docId = decodeURIComponent(revoke[1]);
        const user = await userFor(req);
        const denied = await shareGuard(docId, user);
        if (denied) return json(res, denied.status, denied);
        await store.revoke(docId, decodeURIComponent(revoke[2]));
        await rooms.get(docId)?.recheckAccess();
        return json(res, 200, { ok: true });
      }
      return false;
    }

    const docId = decodeURIComponent(match[1]);
    const user = await userFor(req);

    if (method === 'GET') {
      // Reading the list is not an owner-only action -- a collaborator may see
      // who else is on the document. An unowned document has an empty ACL and
      // returns an empty list rather than an error: "nobody has been given
      // access" is the true answer, and the dialog explains the rest.
      if (!await store.roleFor(docId, user?.id, { requireOwner: config.requireOwner })) {
        return json(res, 403, { error: 'no access' });
      }
      const people = (await Promise.all(
        (await store.collaborators(docId))
          .map(async (c) => ({ ...c, user: await accounts.getUser(c.userId) }))))
        .filter((c) => c.user);
      return json(res, 200, { collaborators: people });
    }

    if (method === 'POST') {
      const denied = await shareGuard(docId, user);
      if (denied) return json(res, denied.status, denied);
      const body = await readBody(req);
      const target = (await accounts.searchByEmail(body.email)).find(
        (u) => u.email.toLowerCase() === String(body.email ?? '').trim().toLowerCase());
      if (!target) return json(res, 404, { error: 'no account with that email' });
      const role = body.role === 'viewer' ? 'viewer' : 'editor';
      await store.grant(docId, target.id, role);
      // Someone downgraded to viewer must stop being able to write NOW, not at
      // their next reconnect -- the room caches roles per connection.
      await rooms.get(docId)?.recheckAccess();
      return json(res, 200, { collaborator: { userId: target.id, role, user: target } });
    }

    return false;
  }

  // ---- version history ----------------------------------------------------

  async function historyRoutes({ req, res, url, path, method, readBody, userFor }) {
    const base = /^\/api\/docs\/([^/]+)\/(history|versions|restore|checkpoints)$/.exec(path);
    if (!base) return false;

    const docId = decodeURIComponent(base[1]);
    const what = base[2];
    const user = await userFor(req);
    const role = await store.roleFor(docId, user?.id, { requireOwner: config.requireOwner });
    if (!role) return json(res, 403, { error: 'no access' });

    // The version list: named checkpoints and the automatic ones compaction
    // leaves behind, newest first.
    if (what === 'history' && method === 'GET') {
      const checkpoints = await Promise.all(
        (await store.listCheckpoints(docId)).map(async (c) => ({
          ...c,
          author: c.authorId ? await accounts.getUser(c.authorId) : null,
        })));
      return json(res, 200, {
        docId,
        currentSeq: await store.currentSeq(docId),
        checkpoints,
        activity: await store.activity(docId),
      });
    }

    // What the document said at a point in the past. Read-only, and computed
    // on a throwaway engine so the live document is untouched.
    if (what === 'versions' && method === 'GET') {
      const seq = Number(url.searchParams.get('seq'));
      if (!Number.isFinite(seq) || seq < 0) return json(res, 400, { error: 'seq required' });
      const doc = await documentAt(docId, seq);
      return json(res, 200, { seq, text: doc.toString(), runs: doc.toJSON() });
    }

    // Name the current state.
    if (what === 'checkpoints' && method === 'POST') {
      if (!canEdit(role)) return json(res, 403, { error: 'no access' });
      const body = await readBody(req);
      const label = String(body.label ?? '').trim().slice(0, 120);
      if (!label) return json(res, 400, { error: 'a label is required' });
      const id = await store.createCheckpoint(docId, {
        seq: await store.currentSeq(docId),
        label,
        authorId: user?.id ?? null,
        data: await currentSnapshot(docId),
      });
      return json(res, 201, { id });
    }

    if (what === 'restore' && method === 'POST') {
      if (!canEdit(role)) return json(res, 403, { error: 'no access' });
      const body = await readBody(req);
      const seq = Number(body.seq);
      if (!Number.isFinite(seq) || seq < 0) return json(res, 400, { error: 'seq required' });

      const past = await documentAt(docId, seq);

      // Take a checkpoint of where we are BEFORE overwriting it. Restore is
      // the one operation people perform by accident, and the state they
      // destroy is the one they were last looking at.
      await store.createCheckpoint(docId, {
        seq: await store.currentSeq(docId),
        label: `before restoring to #${seq}`,
        authorId: user?.id ?? null,
        data: await currentSnapshot(docId),
      });

      const room = rooms.get(docId);
      if (room) {
        // Live document: the engine turns it into an ordinary edit and the
        // room fans it out, so everyone currently typing sees it arrive the
        // same way a peer's edit would.
        await room.applyServerEdit(past, user?.id);
      } else {
        // Nobody is connected. Apply to a temporary engine whose persist
        // callback writes to the real log, so the change is durable and the
        // next client to open the document simply loads it.
        // The persist callback stays synchronous -- the engine calls it that
        // way -- so the promise it returns is collected rather than awaited
        // inline, and awaited before the compaction that supersedes it.
        // `compactAtomically` would drain these anyway, but collecting them
        // is what surfaces a write failure here instead of losing the
        // restore silently.
        const writes = [];
        const engine = makeEngine(docId, (bytes) => {
          writes.push(store.appendUpdate(docId, bytes));
        });
        engine.restore(await store.load(docId));
        engine.replaceWith(past, user?.id);
        await Promise.all(writes);
        // Not `compact(docId, engine.snapshot(), await currentSeq(docId))`:
        // that evaluates the snapshot before the round trip that reads the
        // seq, so anything landing in between is inside `throughSeq` and
        // outside the snapshot, and compaction deletes exactly that range.
        await store.compactAtomically(docId, () => engine.snapshot());
        engine.destroy();
      }
      await store.touchDoc(docId);
      return json(res, 200, { ok: true, restoredTo: seq, text: past.toString() });
    }

    return false;
  }

  // ---- everything else ----------------------------------------------------

  async function miscRoutes({ req, res, url, path, method, userFor }) {
    if (path === '/api/users' && method === 'GET') {
      // Requires a session: an open email-prefix search is a user directory.
      if (!await userFor(req)) return json(res, 401, { error: 'not signed in' });
      return json(res, 200,
        { users: await accounts.searchByEmail(url.searchParams.get('q')) });
    }

    /**
     * What this node is doing right now.
     *
     * TWO CHECKS, AND THE DEFAULT IS THE CHEAP ONE.
     *
     * The shallow answer reads memory only and never touches Postgres. It is
     * what `healthCheckPath` points at in render.yaml and what the keep-alive
     * cron hits -- both of them unattended, both of them forever. A database
     * query on that path is billed to a quota nobody is watching, which is
     * exactly how this project spent a month of Neon compute on an idle site.
     * See .github/workflows/keepalive.yml.
     *
     * `?deep=1` adds the storage aggregates and answers a different question:
     * whether this process can actually REACH Postgres. The two fail
     * independently -- a healthy Node with an unreachable database passes the
     * shallow check and is useless to a visitor -- so the deep one is the one
     * to call by hand when the site loads but documents do not appear.
     *
     * Deliberately NOT wired to `healthCheckPath`: if Render checked the deep
     * route, a Neon blip would read as an unhealthy instance and Render would
     * restart it. Restarting cannot fix an upstream database; it only adds a
     * cold start on the way back. It is also rate-limited where the shallow
     * one is exempt -- see the limiter above.
     *
     * Aggregates only -- counts, totals and a timestamp. No titles, no ids, no
     * owners: this route has no session and must not become a way to enumerate
     * other people's documents by asking politely.
     *
     * `docs` counts documents, not logs. A tab has a content log of its own
     * (ADR-014), so counting rows would report a five-tab document as five.
     * `bytes` deliberately does sum the whole family, because that IS what the
     * document costs on disk.
     */
    if (path === '/api/health' && method === 'GET') {
      // Everyone attached to any room on this node. Rooms outnumber documents
      // whenever tabs are open, which is why this is summed rather than
      // reported as `rooms.size`.
      let clients = 0;
      for (const room of rooms.values()) clients += room.clients.size;

      const body = {
        ok: true,
        engine: config.engine,
        port: config.port,
        rooms: rooms.size,
        clients,
        uptimeMs: Date.now() - startedAt,
        // Cumulative work since boot. Room stats die with the room, so these
        // come from the process-wide counters in metrics.js.
        ...readMetrics(),
        batchWindowMs: config.broadcastWindowMs,
      };

      // The only branch in this file that reaches storage on a health check,
      // and it is opt-in for the reasons above.
      if (url.searchParams.get('deep') === '1') {
        const parents = new Set();
        let bytes = 0;
        let lastWrite = 0;
        for (const d of await store.listDocs(1000)) {
          parents.add(Store.tabOf(d.docId).docId);
          bytes += d.bytes;
          if (d.updatedAt > lastWrite) lastWrite = d.updatedAt;
        }
        body.deep = true;
        body.docs = parents.size;
        body.bytes = bytes;
        body.lastWrite = lastWrite || null;
      }

      return json(res, 200, body);
    }

    return false;
  }

  // ---- comments -----------------------------------------------------------
  //
  // Bodies over HTTP, anchors minted by the engine. This is the same rule as
  // everywhere else in this file -- nothing that changes a document's CONTENT
  // goes over HTTP -- and a comment is not content. See ADR-012.

  async function commentRoutes({ req, res, path, method, readBody, userFor }) {
    const base = /^\/api\/docs\/([^/]+)\/comments(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(path);
    if (!base) return false;

    const docId = decodeURIComponent(base[1]);
    const threadId = base[2] ? decodeURIComponent(base[2]) : null;
    const tail = base[3] ? decodeURIComponent(base[3]) : null;

    const user = await userFor(req);
    const { role, exists } = await roleForRequest(docId, user);

    if (!role) {
      // A document that does not exist has no comments. Saying so is a true
      // answer about content, not a decision about access, and it grants
      // nothing: `requireOwner` still refuses, and writing still needs a role.
      // See roleForRequest for why existence is decided there and not by a
      // second read here.
      if (method === 'GET' && !threadId && !config.requireOwner && !exists) {
        return json(res, 200, { threads: [] });
      }
      return json(res, 403, { error: 'no access' });
    }

    // Reading is open to anyone who can open the document, including viewers.
    if (!threadId && method === 'GET') {
      return json(res, 200, { threads: await store.listThreads(docId) });
    }

    // Writing needs edit rights. There is no separate 'commenter' role in this
    // project (Store.ROLES is owner/editor/viewer), and inventing a fourth one
    // here -- without the share dialog, the ACL and the socket check knowing
    // about it -- would be a permission that looks enforced and is not.
    if (!canEdit(role)) return json(res, 403, { error: 'read-only access' });

    /*
     * The thread has to be IN this document, and a thread id alone does not say
     * that.
     *
     * Every branch below is reached with a thread id out of the path, and the
     * role above was decided from the DOCUMENT id in the path -- so without
     * this, an id you have edit rights on (an unowned scratch document will do,
     * and anyone can make one) authorises replying to, resolving, or deleting a
     * thread that belongs to somebody else's private document. The tab routes
     * guard the identical hole for the identical reason; comments were missing
     * it.
     *
     * The thread is loaded once here and reused, so this costs no extra round
     * trip on the paths that were going to read it anyway.
     */
    let thread = null;
    if (threadId) {
      thread = await store.getThread(threadId);
      // 404 rather than 403: a thread in a document the caller cannot see is
      // one they must not be able to confirm the existence of either.
      if (!thread || thread.docId !== docId) {
        return json(res, 404, { error: 'no such thread' });
      }
    }

    // Guest documents have no account behind them, so an author is a name we
    // were given rather than a user we looked up (ADR-010). The name is only
    // trusted when there is no session; a signed-in user cannot rename
    // themselves per-comment.
    const authorFrom = (body) => (user
      ? { id: user.id, name: user.name, color: user.color }
      : { id: null, name: String(body.authorName || 'Guest').slice(0, 60),
          color: typeof body.authorColor === 'string' ? body.authorColor.slice(0, 32) : null });

    const room = rooms.get(docId);

    if (!threadId && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.body ?? '').trim();
      if (!text) return json(res, 400, { error: 'a comment needs a body' });
      if (!body.anchor || typeof body.anchor !== 'object') {
        return json(res, 400, { error: 'a comment needs an anchor' });
      }

      // Only a live room holds the engine state an OT anchor must be caught up
      // through. With no room open nothing has been sequenced since the client
      // read the document, so its anchor is already current.
      const anchor = room ? room.mintAnchor(body.anchor) : body.anchor;
      if (!anchor) {
        return json(res, 409, { error: 'the commented text no longer exists' });
      }

      const thread = await store.createThread({
        docId, anchor, quote: String(body.quote ?? '').slice(0, 300),
        body: text.slice(0, 4000), author: authorFrom(body),
      });
      room?.commentsChanged({ threadId: thread.id });
      return json(res, 201, { thread });
    }

    if (threadId && !tail && method === 'POST') {
      const body = await readBody(req);
      const text = String(body.body ?? '').trim();
      if (!text) return json(res, 400, { error: 'a comment needs a body' });
      const updated = await store.addComment({
        threadId, body: text.slice(0, 4000), author: authorFrom(body),
      });
      if (!updated) return json(res, 404, { error: 'no such thread' });
      room?.commentsChanged({ threadId });
      return json(res, 201, { thread: updated });
    }

    if (threadId && tail === 'resolve' && method === 'POST') {
      const body = await readBody(req);
      const updated = await store.resolveThread(threadId, body.resolved !== false);
      if (!updated) return json(res, 404, { error: 'no such thread' });
      room?.commentsChanged({ threadId });
      return json(res, 200, { thread: updated });
    }

    if (threadId && !tail && method === 'DELETE') {
      await store.deleteThread(threadId);
      room?.commentsChanged({ threadId, deleted: true });
      return json(res, 200, { ok: true });
    }

    // A single comment inside a thread. Deleting the last one takes the thread
    // with it -- see Store.deleteComment.
    if (threadId && tail && method === 'DELETE') {
      // The same containment check one level down. `deleteComment` takes a
      // comment id and finds its own thread, so without this a comment in
      // another document's thread would be deleted by a caller who only proved
      // rights over this one.
      if (!thread.comments.some((c) => c.id === tail)) {
        return json(res, 404, { error: 'no such comment' });
      }
      const result = await store.deleteComment(tail);
      if (!result) return json(res, 404, { error: 'no such comment' });
      room?.commentsChanged({ threadId, ...result });
      return json(res, 200, result);
    }

    return false;
  }

  // ---- tabs ---------------------------------------------------------------

  /**
   * The tab list. Not content -- a tab's CONTENT is a document with a room of
   * its own, reached over the socket exactly like any other (ADR-014). What is
   * served here is which tabs exist, what they are called and in what order,
   * which is metadata in precisely the sense this file's opening rule means.
   *
   * Addressed by the document, and a tab id normalises to its document, so
   * `/api/docs/notes-a1b2~7fq2/tabs` and `/api/docs/notes-a1b2/tabs` are the
   * same list. The editor is holding a tab id and should not have to take it
   * apart to ask a question about the document it is in.
   */
  async function tabRoutes({ req, res, path, method, readBody, userFor }) {
    const base = /^\/api\/docs\/([^/]+)\/tabs(?:\/([^/]+))?$/.exec(path);
    if (!base) return false;

    const docId = Store.tabOf(decodeURIComponent(base[1])).docId;
    const tabId = base[2] ? decodeURIComponent(base[2]) : null;
    const user = await userFor(req);
    const { role, exists } = await roleForRequest(docId, user);

    if (!role) {
      // A document that does not exist yet has one tab -- itself -- and saying
      // so grants nothing. See roleForRequest.
      if (method === 'GET' && !config.requireOwner && !exists) {
        return json(res, 200, { tabs: await store.tabsFor(docId) });
      }
      return json(res, 403, { error: 'no access' });
    }

    if (method === 'GET' && !tabId) {
      return json(res, 200, { tabs: await store.tabsFor(docId) });
    }

    if (!canEdit(role)) return json(res, 403, { error: 'read-only access' });

    const announce = () => {
      for (const room of familyRooms(docId)) room.tabsChanged();
    };

    if (method === 'POST' && !tabId) {
      const body = await readBody(req);
      const tab = await store.createTab(docId, body.title);
      announce();
      return json(res, 201, { tab, tabs: await store.tabsFor(docId) });
    }

    // A tab id that is not in this document would let one document's editor
    // rename another's, since the role check above was made against the id in
    // the path. Cheap to check, and the alternative is a real hole.
    if (tabId && Store.tabOf(tabId).docId !== docId) {
      return json(res, 400, { error: 'that tab belongs to another document' });
    }

    if (method === 'PATCH' && tabId) {
      const body = await readBody(req);
      // Renaming the implicit first tab has to write it down first, or the
      // UPDATE silently matches no rows and the name is lost on reload.
      if (!(await store.getTab(tabId)) && tabId === docId) await store.ensureFirstTab(docId);
      let tab = await store.getTab(tabId);
      if (!tab) return json(res, 404, { error: 'no such tab' });
      if (typeof body.title === 'string') tab = await store.renameTab(tabId, body.title);
      if (Number.isInteger(body.index)) {
        const moved = await store.moveTab(tabId, body.index);
        if (!moved.ok) return json(res, 400, moved);
        tab = await store.getTab(tabId);
      }
      announce();
      return json(res, 200, { tab, tabs: await store.tabsFor(docId) });
    }

    if (method === 'DELETE' && tabId) {
      const result = await store.deleteTab(tabId);
      // 409 rather than 403: deleting the last tab is refused because of what
      // the document would become, not because of who asked.
      if (!result.ok) return json(res, result.error === 'no such tab' ? 404 : 409, result);
      announce();
      return json(res, 200, { ok: true, tabs: await store.tabsFor(docId) });
    }

    return false;
  }

  // ---- tasks --------------------------------------------------------------

  /**
   * The shared checklist (ADR-015).
   *
   * Scoped to the document, so it is the same list from every tab. Anyone who
   * can edit the document can add a task, tick one, or untick it -- that is
   * the feature, not an oversight: a checklist whose items can only be
   * completed by whoever wrote them is a personal to-do list that happens to
   * be visible to other people.
   */
  async function taskRoutes({ req, res, path, method, readBody, userFor }) {
    const base = /^\/api\/docs\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(path);
    if (!base) return false;

    const docId = Store.tabOf(decodeURIComponent(base[1])).docId;
    const taskId = base[2] ? decodeURIComponent(base[2]) : null;
    const user = await userFor(req);
    const { role, exists } = await roleForRequest(docId, user);

    if (!role) {
      if (method === 'GET' && !taskId && !config.requireOwner && !exists) {
        return json(res, 200, { tasks: [] });
      }
      return json(res, 403, { error: 'no access' });
    }

    if (method === 'GET' && !taskId) {
      return json(res, 200, { tasks: await store.listTasks(docId) });
    }

    if (!canEdit(role)) return json(res, 403, { error: 'read-only access' });

    const announce = () => {
      for (const room of familyRooms(docId)) room.tasksChanged();
    };

    // Guest documents again (ADR-010): a name we were given rather than a user
    // we looked up, and only trusted when there is no session.
    const personFrom = (body) => (user
      ? { id: user.id, name: user.name, color: user.color }
      : { id: null, name: String(body?.authorName || 'Guest').slice(0, 60),
          color: typeof body?.authorColor === 'string' ? body.authorColor.slice(0, 32) : null });

    if (method === 'POST' && !taskId) {
      const body = await readBody(req);
      const text = String(body.body ?? '').trim();
      if (!text) return json(res, 400, { error: 'a task needs something to do' });
      const task = await store.createTask({
        docId, body: text.slice(0, 500), author: personFrom(body),
      });
      announce();
      return json(res, 201, { task });
    }

    if (method === 'PATCH' && taskId) {
      const body = await readBody(req);
      const existing = await store.getTask(taskId);
      if (!existing || existing.docId !== docId) {
        return json(res, 404, { error: 'no such task' });
      }
      let task = existing;
      if (typeof body.body === 'string') {
        const text = body.body.trim();
        if (!text) return json(res, 400, { error: 'a task needs something to do' });
        task = await store.editTask(taskId, text.slice(0, 500));
      }
      if (typeof body.done === 'boolean') {
        task = await store.setTaskDone(taskId, body.done, personFrom(body));
      }
      announce();
      return json(res, 200, { task });
    }

    if (method === 'DELETE' && taskId) {
      const existing = await store.getTask(taskId);
      if (!existing || existing.docId !== docId) {
        return json(res, 404, { error: 'no such task' });
      }
      await store.deleteTask(taskId);
      announce();
      return json(res, 200, { ok: true });
    }

    return false;
  }
}

// ---- helpers ---------------------------------------------------------------

/** Roles that may change a document. Viewers may open and watch, nothing more. */
export function canEdit(role) {
  return role === 'owner' || role === 'editor';
}

/**
 * A readable, unique document id.
 *
 * Readable because it ends up in the URL and in the room log, unique because
 * two people naming a document "Notes" must not collide into one document --
 * which, given the room is keyed by this id, would silently merge them.
 */
function slugId(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'untitled'}-${randomUUID().slice(0, 8)}`;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
  return true;
}
