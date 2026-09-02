/**
 * Which documents belong in a listing.
 *
 * One rule, in one place, because there are two listings -- the documents page
 * and the landing page's search field -- and a document that is not worth
 * showing on one is not worth showing on the other. Split the rule in two and
 * they drift: every empty `Untitled` and every harness scratch pad one of them
 * filters out reappears on the other.
 *
 * Two conditions, and they exclude different things:
 *
 *   has text     a document with nothing written in it is a name and a row.
 *                `chars` comes from the search projection (ADR-017), not from
 *                the update log's size: merely OPENING a document persists
 *                engine state, so a byte count answers "has this ever been
 *                connected to", which is a different question.
 *
 *   is yours     an unowned document belongs to whoever has the link. If this
 *                browser has never opened one, it is somebody else's -- the
 *                lab's scratch pads and the test harnesses live here -- and
 *                there is no relationship to it worth listing.
 *
 * @param {{ chars?: number, unowned?: boolean, docId: string }} doc
 * @param {Set<string>} localIds ids from local-docs.js
 */
export function listable(doc, localIds) {
  if ((doc.chars ?? 0) <= 0) return false;
  if (doc.unowned && !localIds.has(doc.docId)) return false;
  return true;
}
