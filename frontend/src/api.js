/**
 * Client for the JSON API, plus the session token.
 *
 * The token lives in localStorage rather than an HttpOnly cookie, for the
 * reason spelled out in backend/src/transport/api.js: in development the app
 * is on :5173 and the API on :8080, and a cross-origin cookie needs
 * SameSite=None + Secure + HTTPS. The cost is that any script running on the
 * page can read it. A single-origin deployment should move to the cookie; the
 * server already accepts one.
 *
 * Two servers run, one per engine, and a document created on the CRDT server
 * does not exist on the OT server -- its update log is bytes only that engine
 * can read. Accounts are shared; documents are not.
 *
 * SITE DOCUMENTS ARE CRDT-ONLY. Every real document, everywhere in the
 * product, lives on the CRDT server. The OT server is still running and still
 * fully implemented, but only the lab talks to it, where the engine is a
 * toggle you flip to watch the two resolve the same conflict differently.
 * See ADR-009.
 *
 * The engine argument therefore stays on every call rather than being dropped:
 * removing it would bake the choice into fifty call sites, and the lab still
 * needs the other one.
 */

/** The engine every document on the site uses. The lab overrides it. */
export const DOCUMENT_ENGINE = 'yjs';

const TOKEN_KEY = 'collab.token';

export const ENGINE_PORTS = { yjs: 8080, ot: 8081 };

/**
 * Where each engine's server lives, when it is not next door on localhost.
 *
 * In development the two servers are on fixed ports on the same host and the
 * ports below are the whole answer. Deployed, they are separate services on
 * their own hostnames, and the two assumptions baked into that answer both
 * break: the port is not reachable, and `ws://` from a page served over
 * HTTPS is blocked as mixed content before it leaves the browser.
 *
 * So a deployment sets these at BUILD time. They are ordinary public URLs,
 * not secrets -- `VITE_`-prefixed values are compiled into the bundle and
 * readable by anyone, which is exactly why DATABASE_URL is not among them and
 * must never be. Unset, everything below behaves as it always has.
 */
// Trimmed for the same reason the Google ids are: pasted by hand into a
// dashboard field. `apiBase` strips a trailing slash but a newline is not a
// slash, and it would ride through into every request URL and every
// `ws://` handshake -- which fails as a malformed URL, naming neither the
// variable nor the whitespace.
const ENGINE_URLS = {
  yjs: import.meta.env?.VITE_API_URL_YJS?.trim(),
  ot: import.meta.env?.VITE_API_URL_OT?.trim(),
};

/** HTTP base for an engine's server. */
export function apiBase(engine) {
  const configured = ENGINE_URLS[engine];
  if (configured) return configured.replace(/\/+$/, '');
  return `http://${location.hostname}:${ENGINE_PORTS[engine] ?? ENGINE_PORTS.yjs}`;
}

/**
 * WebSocket base for an engine's server.
 *
 * Derived from the HTTP base rather than built separately, so the scheme can
 * never disagree with it: https implies wss, and a page on https that opens a
 * ws:// socket fails in the browser with a mixed-content error that names
 * neither the port nor the scheme.
 */
export function wsBase(engine) {
  return apiBase(engine).replace(/^http/, 'ws');
}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode; the session just will not persist */ }
}

/**
 * One request. Throws an Error carrying `status` on failure, so callers can
 * tell "not signed in" from "no access" from "the server is down" -- which
 * matter to a user and would be indistinguishable from a null return.
 */
export async function request(engine, path, { method = 'GET', body, token } = {}) {
  const auth = token ?? getToken();
  let res;
  try {
    res = await fetch(apiBase(engine) + path, {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    const err = new Error(`cannot reach the ${engine.toUpperCase()} server`);
    err.status = 0;
    err.cause = cause;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- accounts --------------------------------------------------------------

export async function signUp(engine, { email, name, password }) {
  const data = await request(engine, '/api/auth/signup', {
    method: 'POST', body: { email, name, password },
  });
  setToken(data.token);
  return data.user;
}

export async function signIn(engine, { email, password }) {
  const data = await request(engine, '/api/auth/login', {
    method: 'POST', body: { email, password },
  });
  setToken(data.token);
  return data.user;
}

/**
 * Exchange a Google ID token for one of our own sessions.
 *
 * The credential goes over the wire unread. It is a signed assertion from
 * Google and its payload is trivially readable here, but reading it would
 * prove nothing -- only the signature does, and only the server can check
 * that. What comes back is an ordinary session token, indistinguishable from
 * a password sign-in's from this point on (ADR-020).
 */
export async function signInWithGoogle(engine, credential) {
  const data = await request(engine, '/api/auth/google', {
    method: 'POST', body: { credential },
  });
  setToken(data.token);
  return data.user;
}

export async function signOut(engine) {
  try { await request(engine, '/api/auth/logout', { method: 'POST' }); }
  finally { setToken(null); }
}

/** @returns {object|null} the signed-in user, or null. Never throws on 401. */
export async function whoami(engine) {
  if (!getToken()) return null;
  try {
    return (await request(engine, '/api/me')).user;
  } catch (err) {
    // A token the server no longer honours is worse than no token: every
    // later call fails in a way that looks like a bug rather than a logout.
    if (err.status === 401) setToken(null);
    return null;
  }
}

/*
   `health(engine)` lived here, wrapping /api/health. Its only two callers were
   the landing page's crash-safety and convergence panels, and the left column
   is what the site is and does now rather than what the node is doing. The
   route itself stays: it is the ops endpoint, and tools/landing-test.mjs
   still asserts that it serves aggregates and leaks no document identity.
*/

// ---- documents -------------------------------------------------------------

export const listDocs = (engine) => request(engine, '/api/docs');

export const createDoc = (engine, title) =>
  request(engine, '/api/docs', { method: 'POST', body: { title } });

export const renameDoc = (engine, docId, title) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}`, { method: 'PATCH', body: { title } });

export const deleteDoc = (engine, docId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });

export const getDoc = (engine, docId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}`);

/**
 * Documents you deleted, and putting one back.
 *
 * Deleting has always been soft in the storage layer -- the update log and
 * every version survive it -- but nothing reached that state, so a delete was
 * soft on disk and permanent to the person who clicked it. These two are what
 * make the storage layer's promise true from the outside.
 *
 * Not `/api/docs?deleted=true`: the trash is a different question with a
 * different answer shape (owner only, no roles, no presence counts), and
 * folding it into the main listing would have every caller filtering a list
 * it did not ask for.
 */
export const listTrash = (engine) => request(engine, '/api/docs/trash');

/**
 * Search your documents by CONTENT, not just by title (ADR-017).
 *
 * The documents page has always filtered the listing it already had, which
 * can only ever match titles -- the text was in engine-specific bytes on the
 * server and nothing in the browser had ever seen it. This asks the server,
 * which maintains a plaintext projection for exactly this question.
 *
 * Snippets come back with the matched run delimited by U+0002/U+0003 rather
 * than by markup, so the client decides what a highlight looks like and no
 * HTML from anyone's document is ever handed to a renderer. See `Snippet`.
 */
export const searchDocs = (engine, q) =>
  request(engine, `/api/docs/search?q=${encodeURIComponent(q)}`);

/** The delimiters `searchDocs` wraps a match in. */
export const MATCH_START = String.fromCharCode(2);
export const MATCH_END = String.fromCharCode(3);

/**
 * `undelete`, not `restore`: `restoreVersion` below already owns that word on
 * this API, and it means something else entirely -- rolling a live document
 * back to an earlier version rather than bringing a deleted one back at all.
 */
export const undeleteDoc = (engine, docId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/undelete`, { method: 'POST' });

/**
 * Take ownership of a document nobody owns.
 *
 * The bridge between the two halves of the product's rule: anyone may write,
 * only an account may share. A guest writes first and claims at the moment
 * sharing is asked for, which is the first moment ownership means anything.
 *
 * Throws with `status === 409` if somebody else claimed it first -- a real
 * outcome when two people are in the same unowned document, and one the caller
 * has to tell apart from a permissions error.
 */
/**
 * Who wrote each character (ADR-018).
 *
 * Answers `{ supported: false }` for an engine that cannot attribute, which is
 * a real answer and not an error -- the UI says so rather than showing an
 * unattributed document as though nobody had written any of it.
 */
export const getAuthorship = (engine, docId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/authorship`);

/**
 * Fill a newly created, still-empty document with imported content (ADR-021).
 *
 * The one call in this client that sends document CONTENT over HTTP. It is
 * accepted only for an empty document, and the server hands it to the engine
 * as an ordinary edit rather than writing state -- see the route for why that
 * is the same bargain version restore makes.
 */
export const importIntoDoc = (engine, docId, runs) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/import`, {
    method: 'POST', body: { runs },
  });

export const claimDoc = (engine, docId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/claim`, { method: 'POST' });

// ---- sharing ---------------------------------------------------------------

export const listCollaborators = (engine, docId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/share`);

export const share = (engine, docId, email, role) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/share`, {
    method: 'POST', body: { email, role },
  });

export const unshare = (engine, docId, userId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/share/${encodeURIComponent(userId)}`,
    { method: 'DELETE' });

// ---- version history -------------------------------------------------------

export const getHistory = (engine, docId) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/history`);

export const getVersion = (engine, docId, seq) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/versions?seq=${seq}`);

export const createCheckpoint = (engine, docId, label) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/checkpoints`, {
    method: 'POST', body: { label },
  });

export const restoreVersion = (engine, docId, seq) =>
  request(engine, `/api/docs/${encodeURIComponent(docId)}/restore`, {
    method: 'POST', body: { seq },
  });

// ---- comments --------------------------------------------------------------
//
// Bodies travel over HTTP; anchors are minted by the sync layer and passed
// through untouched, because only the engine knows what a position means.
// See ADR-012.

const commentsUrl = (docId, ...rest) =>
  `/api/docs/${encodeURIComponent(docId)}/comments` +
  rest.map((r) => '/' + encodeURIComponent(r)).join('');

export const listComments = (engine, docId) =>
  request(engine, commentsUrl(docId));

/**
 * Open a thread on a range.
 *
 * `authorName` and `authorColor` are only consulted for guest documents -- a
 * signed-in request is attributed to its session, and the server ignores what
 * the body claims (ADR-010).
 */
export const createThread = (engine, docId, { anchor, quote, body, authorName, authorColor }) =>
  request(engine, commentsUrl(docId), {
    method: 'POST', body: { anchor, quote, body, authorName, authorColor },
  });

export const replyToThread = (engine, docId, threadId, { body, authorName, authorColor }) =>
  request(engine, commentsUrl(docId, threadId), {
    method: 'POST', body: { body, authorName, authorColor },
  });

export const resolveThread = (engine, docId, threadId, resolved = true) =>
  request(engine, commentsUrl(docId, threadId, 'resolve'), {
    method: 'POST', body: { resolved },
  });

export const deleteThread = (engine, docId, threadId) =>
  request(engine, commentsUrl(docId, threadId), { method: 'DELETE' });

export const deleteComment = (engine, docId, threadId, commentId) =>
  request(engine, commentsUrl(docId, threadId, commentId), { method: 'DELETE' });

// ---- tabs ------------------------------------------------------------------
//
// A tab is a document: `tabId` is the id its content lives under, and opening
// a tab means opening a socket to that id. Nothing here transports content --
// this is the list, which is metadata about the document (ADR-014).
//
// Every call takes the DOCUMENT id, and a tab id normalises to its document
// server-side, so the editor can pass whichever it is holding.

const tabsUrl = (docId, ...rest) =>
  `/api/docs/${encodeURIComponent(docId)}/tabs` +
  rest.map((r) => '/' + encodeURIComponent(r)).join('');

export const listTabs = (engine, docId) => request(engine, tabsUrl(docId));

export const createTab = (engine, docId, title) =>
  request(engine, tabsUrl(docId), { method: 'POST', body: { title } });

/** Rename, reorder, or both. `index` is an absolute position in the strip. */
export const updateTab = (engine, docId, tabId, { title, index } = {}) =>
  request(engine, tabsUrl(docId, tabId), { method: 'PATCH', body: { title, index } });

/** Throws with `status === 409` when it is the only tab left. */
export const deleteTab = (engine, docId, tabId) =>
  request(engine, tabsUrl(docId, tabId), { method: 'DELETE' });

// ---- tasks -----------------------------------------------------------------
//
// The shared checklist (ADR-015). One list per document, the same from every
// tab, and anyone who can edit the document can tick anything on it.

const tasksUrl = (docId, ...rest) =>
  `/api/docs/${encodeURIComponent(docId)}/tasks` +
  rest.map((r) => '/' + encodeURIComponent(r)).join('');

export const listTasks = (engine, docId) => request(engine, tasksUrl(docId));

export const createTask = (engine, docId, { body, authorName, authorColor }) =>
  request(engine, tasksUrl(docId), {
    method: 'POST', body: { body, authorName, authorColor },
  });

/**
 * Tick, untick, or reword a task.
 *
 * `authorName` is only consulted on a guest document, and only to record who
 * ticked it -- a signed-in request is attributed to its session (ADR-010).
 */
export const updateTask = (engine, docId, taskId, { body, done, authorName, authorColor } = {}) =>
  request(engine, tasksUrl(docId, taskId), {
    method: 'PATCH', body: { body, done, authorName, authorColor },
  });

export const deleteTask = (engine, docId, taskId) =>
  request(engine, tasksUrl(docId, taskId), { method: 'DELETE' });
