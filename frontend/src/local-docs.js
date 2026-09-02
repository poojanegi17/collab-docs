/**
 * Unowned documents this browser has opened.
 *
 * Written when the editor connects rather than when a document is created, so
 * it also catches an unowned document someone sent you a link to. That is the
 * right behaviour and not a slip: an unowned document is open to whoever has
 * the link, so "you were here" is exactly the relationship this list records.
 *
 * A guest document is unowned, and unowned means the server has nobody to file
 * it under -- `GET /api/docs` can only return it in the capped pile of unowned
 * documents, mixed in with the lab's scratch pads. So a guest who closes the tab has
 * genuinely lost their document unless they kept the URL. That is the cost of
 * not asking for an email, and it is worth paying, but it is not worth paying
 * silently.
 *
 * This is the cheapest honest fix: the ids live in localStorage, on the device,
 * and the documents page lists them alongside the documents you own. It is a
 * convenience list, NOT an access-control record -- the server neither reads
 * nor trusts it, and clearing site data loses it. Anyone with the link still
 * has exactly the same access, because that is what unowned means.
 *
 * Entries are dropped once the document is owned: after you sign in and claim
 * it, the server lists it as yours and a second copy here would show the same
 * document twice.
 */

const KEY = 'collab.localDocs';
const LIMIT = 50;

/** @returns {Array<{docId: string, title: string, at: number}>} newest first */
export function listLocalDocs() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((d) => d && typeof d.docId === 'string')
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  } catch {
    // Private mode, or something else wrote junk to the key. An unreadable
    // convenience list is not worth breaking the page over.
    return [];
  }
}

export function rememberLocalDoc({ docId, title }) {
  if (!docId) return;
  const next = [
    { docId, title: title || docId, at: Date.now() },
    ...listLocalDocs().filter((d) => d.docId !== docId),
  ].slice(0, LIMIT);
  write(next);
}

export function forgetLocalDoc(docId) {
  write(listLocalDocs().filter((d) => d.docId !== docId));
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); }
  catch { /* private mode; the list just will not persist */ }
}
