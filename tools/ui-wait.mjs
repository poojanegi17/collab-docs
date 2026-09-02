/**
 * Wait for a condition in a browser harness, instead of sleeping and hoping.
 *
 * WHY EVERY BROWSER HARNESS NEEDS THIS
 *
 * The things these harnesses wait for are network round trips. Admitting a
 * socket is four of them (session, tab, document, permission) plus the room's
 * own load; the HELLO frame that carries a document's title arrives at the end
 * of that. Measured from a development machine to a database in another
 * region, HELLO lands 2.9s after the editor mounts. Deployed in the same
 * region it is a few milliseconds — so a fixed sleep is not wrong about the
 * system, it is wrong about the network between this machine and the database.
 *
 * Lengthening every sleep would work and is the wrong fix twice over: it makes
 * every run slower whether or not it needs to be, and it leaves the same flake
 * in place on any link slower than the one it was tuned against. Waiting for
 * the CONDITION asserts what the check is actually about — the title does
 * arrive, the client does reach synced — and returns as soon as it is true.
 *
 * These are only for assertions that expect something to HAPPEN. A check that
 * something does NOT happen has nothing to poll for and must keep using a
 * fixed wait; the ones in this codebase are marked where they occur.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `read` until `want` accepts it, or the deadline passes. Returns the last value. */
export async function until(read, want, { timeout = 20_000, every = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!want(value) && Date.now() < deadline) {
    await sleep(every);
    value = await read();
  }
  return value;
}

/** The text of a selector once it satisfies `want`. Missing element reads as ''. */
export function textUntil(page, selector, want, opts) {
  return until(
    () => page.$eval(selector, (e) => e.value ?? e.textContent ?? '').catch(() => ''),
    want, opts);
}

/** Wait for an element to exist. Returns whether it turned up. */
export async function present(page, selector, opts) {
  return (await until(async () => !!(await page.$(selector)), (v) => v, opts)) === true;
}

/**
 * The document title the editor is showing, once the server has sent it.
 *
 * `.doc-title` starts out as the document id — see the session defaults in
 * App.jsx — and is replaced when HELLO arrives. Waiting for `.cm-content` is
 * not enough to have seen that: the editor mounts while the socket is still
 * being admitted.
 */
export function titleAfterHello(page, docId, opts) {
  return textUntil(page, '.doc-title', (t) => t && t !== docId, opts);
}

/** Wait for the joined text of a selector to contain `needle`. */
export function allTextUntil(page, selector, needle, opts) {
  return until(
    () => page.$$eval(selector, (els) => els.map((e) => e.textContent).join(' | ')).catch(() => ''),
    (t) => t.includes(needle), opts);
}
