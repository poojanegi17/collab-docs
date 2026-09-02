/**
 * The documents page, driven through the real UI.
 *
 * Before this page existed, documents surfaced only in the landing page's
 * search dropdown -- six at a time, visible only while focused -- and Delete
 * had an endpoint with nothing to call it. So the checks here are mostly about
 * whether a person can REACH the things the server already supports.
 *
 * Two browser contexts, not two tabs: the session token lives in localStorage,
 * which tabs share, so two tabs are always the same person and every ownership
 * assertion would pass without meaning anything.
 *
 *   node tools/docs-page-test.mjs [--headful]
 */
import puppeteer from 'puppeteer-core';
import { until } from './ui-wait.mjs';

const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}\n`);
  ok ? pass++ : fail++;
};

// 420s, not 180s. Every assertion in this file is now backed by real network
// round trips to Postgres rather than reads of a local file, and several of
// them wait for a listing to catch up across a reload. The guard exists to
// stop a hung run, not to assert a runtime, so it is set clear of the slow
// case -- at 180s it fired on an ordinary one.
const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 420_000);
guard.unref?.();

const stamp = Date.now();
const ADA = { email: `ada-d${stamp}@example.com`, name: 'Ada', password: 'lovelace1' };
const BOB = { email: `bob-d${stamp}@example.com`, name: 'Bob', password: 'password1' };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: HEADFUL ? false : 'new', args: ['--no-sandbox'],
});
const errors = [];

async function person(label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return page;
}

async function signUp(page, who) {
  await page.goto(BASE + '/docs', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.account-btn', { timeout: 15000 });
  await page.click('.account-btn');
  await page.waitForSelector('.account-form');
  await page.$$eval('.account-tabs button',
    (els) => els.find((e) => e.textContent.includes('Create account'))?.click());
  await sleep(200);
  const inputs = await page.$$('.account-form input');
  await inputs[0].type(who.email);
  await inputs[1].type(who.name);
  await inputs[2].type(who.password);
  await page.$eval('.account-form button[type=submit]', (b) => b.click());
  await page.waitForSelector('.account-chip', { timeout: 15000 });
  await sleep(700);
}

/**
 * Rows in a named scope, as "title | badges | when".
 *
 * The page is one list with a selector, not a stack of panels, so this picks
 * the scope and then reads the list rather than hunting for a heading.
 *
 * Returns null when the scope is not on offer. The selector is hidden entirely
 * for a signed-out visitor, and a caller asking for a scope wants to know it
 * was absent rather than get an empty array back.
 */
async function selectScope(page, label) {
  const ok = await page.evaluate((l) => {
    const sel = document.querySelector('.docs-scope-select');
    if (!sel) return false;
    const opt = [...sel.options].find((o) => o.textContent.trim().startsWith(l));
    if (!opt) return false;
    const set = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, 'value').set;
    set.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, label);
  if (ok) await sleep(250);
  return ok;
}

/**
 * Rows in a scope, retried across a reload while the listing is empty.
 *
 * A document only appears in a listing once the SEARCH PROJECTION has text for
 * it -- `listable()` hides anything with `chars <= 0`, deliberately, so that an
 * empty Untitled is not a row. Indexing is debounced by
 * `searchIndexWindowMs` (2s) and the write behind it is now a Postgres round
 * trip, so a document typed into a moment ago is genuinely absent from the
 * listing for a short while after the page has already fetched.
 *
 * Waiting in the page does not help: the documents page fetches when it loads
 * and when the scope changes, so polling the DOM re-reads the same stale
 * answer forever. The refetch has to be forced, which is what the reload is
 * for.
 *
 * Bounded, and only while EMPTY: a scope that legitimately has no rows is a
 * real answer the tests assert on, so this gives up after a few attempts and
 * lets the assertion see the empty list.
 */
const rowsIn = async (page, heading, attempts = 4) => {
  for (let attempt = 1; ; attempt++) {
    // The scope itself can be missing for the same reason a row can: the page
    // only offers a scope it has documents for, so an unindexed document means
    // there is no "Your documents" option at all rather than an empty one.
    // Retry that too, instead of returning null, which the assertions cannot
    // tell apart from a genuine failure.
    const picked = await selectScope(page, heading);
    const rows = picked
      ? await page.evaluate(() => [...document.querySelectorAll('.docs-row')]
        .map((r) => r.innerText.replace(/\n/g, ' | ')))
      : null;
    if ((rows && rows.length) || attempt >= attempts) return rows;
    await sleep(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.docs-list', { timeout: 15000 }).catch(() => {});
  }
};

/**
 * The empty-state line of one named scope.
 *
 * By scope, never by position. A positional selector such as
 * `.docs-section:last-child .docs-empty` names whichever set happens to be
 * rendered last, so it starts testing something else the moment the order
 * changes -- silently, because it still finds an element.
 */
const emptyTextIn = async (page, heading) => {
  if (!(await selectScope(page, heading))) return null;
  return page.evaluate(() =>
    document.querySelector('.docs-empty')?.textContent ?? null);
};

/** Open a row's action menu and list what it offers. */
async function menuFor(page, title, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    // Back to the widest scope first. The list shows one scope at a time now,
    // so a helper that assumes the row is on screen is a helper that depends
    // on whatever the previous assertion happened to leave selected.
    await selectScope(page, 'All');
    const opened = await page.evaluate((t) => {
      const row = [...document.querySelectorAll('.docs-row')]
        .find((r) => r.querySelector('.docs-name')?.textContent.trim() === t);
      if (!row) return false;
      row.querySelector('.docs-menu-btn')?.click();
      return true;
    }, title);
    if (opened) {
      await sleep(250);
      return page.$$eval('.docs-menu a, .docs-menu button', (els) =>
        els.map((e) => e.textContent.trim()));
    }
    // The row is not there yet -- same cause as in `rowsIn`, and the same fix:
    // the page fetched once and the listing has since changed underneath it.
    // Clicking a row that is not rendered silently opens no menu, and the next
    // `waitForSelector` then times out several lines away from the reason.
    if (attempt >= attempts) return [];
    await sleep(1200);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.docs-list', { timeout: 15000 }).catch(() => {});
  }
}

console.log('\nThe documents page\n');
const ada = await person('ada');
const bob = await person('bob');
await signUp(ada, ADA);
await signUp(bob, BOB);

// ---- 1. create ---------------------------------------------------------------
const TITLE = `Design notes ${stamp}`;
await ada.click('.docs-search input');
await ada.type('.docs-search input', TITLE);
await sleep(300);
await ada.evaluate(() => document.querySelector('.docs-section-head .primary-btn').click());
await ada.waitForSelector('.cm-content', { timeout: 20000 });
/*
 * Wait for the socket to be SYNCED before typing, not just for the editor to
 * mount. Admitting a socket is four Postgres round trips plus the room's own
 * load, so `.cm-content` appears well before the connection is live.
 *
 * Typing into the gap is not merely early, it is lost: the document ends up
 * with zero updates and zero snapshots on the server, so it has no indexed
 * text, so `listable()` correctly hides it from every listing -- and the test
 * fails reporting a missing row when the real problem was a keystroke that
 * never left the browser.
 */
await until(() => ada.$eval('.status', (e) => e.innerText).catch(() => ''),
  (t) => t.includes('synced'), { timeout: 25_000 });
await ada.click('.cm-content');
await ada.keyboard.type('first line', { delay: 8 });
// And wait for it to reach the server, so the reindex that follows has
// something to index. `rowsIn` handles the debounce after that.
await until(() => ada.$eval('.status', (e) => e.innerText).catch(() => ''),
  (t) => t.includes('synced'), { timeout: 25_000 });
await sleep(700);

await ada.goto(BASE + '/docs', { waitUntil: 'domcontentloaded' });
// Tolerated, not required. `.docs-list` is not rendered at all until there is
// something to list, and the document only becomes listable once the search
// projection has text for it -- which is debounced by two seconds and then a
// round trip away. Throwing here would fail the run before `rowsIn` got its
// chance to reload and find it, which is the thing that actually handles this.
await ada.waitForSelector('.docs-list', { timeout: 15000 }).catch(() => {});

let yours = await rowsIn(ada, 'Your documents');
check('1. a created document appears under Your documents',
  yours.some((r) => r.includes(TITLE)), yours[0] ?? '(none)');
// Inverted, deliberately. This section is `role === 'owner'` by construction,
// so an "owner" badge appeared on every row of it and distinguished nothing --
// the same argument that keeps the engine badge off the row below, and the tab
// count off a single-tab document. The role badge still has to appear where it
// VARIES, which is what 4c checks on Bob's shared copy.
check('1b. your own documents do not repeat an owner badge on every row',
  !(yours.find((r) => r.includes(TITLE)) ?? '').includes('owner'),
  yours.find((r) => r.includes(TITLE)) ?? '');
// No engine badge is expected: documents on the site are CRDT-only, so
// labelling every row "CRDT" would be noise. See ADR-009.
check('1c. no engine badge, because there is only one engine',
  !(yours.find((r) => r.includes(TITLE)) ?? '').includes('CRDT'));

// ---- 2. other people's unowned documents are not on the site ------------------
//
// The lab's scratch pads and every harness's leavings are somebody else's
// unowned documents, and a person using the site has no relationship to them
// at all -- not theirs, not shared with them, never opened by them.
//
// So this is the strong check. Not "tucked away" -- absent. From the list,
// from the selector, and from a search that names one directly.
const harnessish = (t) => /^(lab|checklist|toggle|zz-probe|search|guest|brand-new)-/.test(t.trim());

const defaultRows = await ada.evaluate(() =>
  [...document.querySelectorAll('.docs-row .docs-name')].map((e) => e.textContent));
check('2. no unowned documents from elsewhere are listed',
  !defaultRows.some(harnessish), `${defaultRows.length} rows shown`);

const offered = await ada.evaluate(() =>
  [...(document.querySelector('.docs-scope-select')?.options ?? [])]
    .map((o) => o.textContent.trim()));
// The selector offers exactly these four and nothing else -- in particular no
// scope that would put somebody else's unowned documents back on the page.
check('2b. and there is no scope that would show them',
  ['All', 'Your documents', 'Shared with you', 'Trash']
    .every((l, i) => (offered[i] ?? '').startsWith(l)) && offered.length === 4,
  offered.join(' | '));

// ---- 3. rename from the row menu ---------------------------------------------
const adaMenu = await menuFor(ada, TITLE);
check('3. an owner gets Open, Share, Rename and Delete',
  ['Open', 'Share', 'Rename', 'Delete'].every((x) => adaMenu.includes(x)), adaMenu.join(', '));

await ada.$$eval('.docs-menu button', (els) =>
  els.find((e) => e.textContent.trim() === 'Rename')?.click());
await ada.waitForSelector('.docs-rename');
const RENAMED = `Renamed ${stamp}`;
await ada.$eval('.docs-rename', (el) => { el.value = ''; });
await ada.type('.docs-rename', RENAMED);
await ada.keyboard.press('Enter');
// The rename is a PATCH followed by a refetch of the list. 1200ms covered both
// against a local file; it does not against a database in another region, and
// reading the rows early sees the OLD title -- which reads as "rename did not
// work" rather than "the list has not caught up".
await until(
  () => ada.$$eval('.docs-row .docs-name', (els) => els.map((e) => e.textContent).join(' | '))
    .catch(() => ''),
  (names) => names.includes(RENAMED), { timeout: 15_000 });
yours = await rowsIn(ada, 'Your documents');
check('3b. rename takes effect in the list',
  yours.some((r) => r.includes(RENAMED)) && !yours.some((r) => r.includes(TITLE)),
  yours.join(' ;; ').slice(0, 100));

// ---- 4. share, and what the other person sees --------------------------------
await menuFor(ada, RENAMED);
await ada.$$eval('.docs-menu button', (els) =>
  els.find((e) => e.textContent.trim() === 'Share')?.click());
await ada.waitForSelector('.share-add');
await ada.type('.share-add input', BOB.email);
await ada.select('.share-add select', 'viewer');
await ada.$eval('.share-add button[type=submit]', (b) => b.click());
await sleep(1200);
await ada.$$eval('.modal-head .icon-btn', (els) => els[0]?.click());
await sleep(600);

await bob.goto(BASE + '/docs', { waitUntil: 'domcontentloaded' });
await bob.waitForSelector('.docs-section', { timeout: 15000 });
await sleep(1000);

const bobShared = await rowsIn(bob, 'Shared with you');
const bobOwn = await rowsIn(bob, 'Your documents');
check('4. a shared document appears under Shared with you',
  bobShared.some((r) => r.includes(RENAMED)), bobShared.join(' ;; ') || '(none)');
check('4b. it names the person who shared it',
  (bobShared.find((r) => r.includes(RENAMED)) ?? '').includes('by Ada'),
  bobShared.find((r) => r.includes(RENAMED)) ?? '');
check('4c. it shows the viewer role',
  (bobShared.find((r) => r.includes(RENAMED)) ?? '').includes('viewer'));
check('4d. it does NOT appear under his own documents',
  !bobOwn.some((r) => r.includes(RENAMED)), bobOwn.join(' ;; ') || '(none)');

const bobMenu = await menuFor(bob, RENAMED);
check('4e. a non-owner is offered no Rename or Delete',
  !bobMenu.includes('Rename') && !bobMenu.includes('Delete'), bobMenu.join(', '));

// ---- 5. search reaches the unowned pile ---------------------------------------
//
// The document searched for is CREATED here rather than assumed to exist.
// Trusting that the lab's scratch documents are still in the listing does not
// work: `listUnowned` is capped at 50, newest first, and every run of this
// suite adds several unowned documents of its own, so any fixture it did not
// make ages out and the test starts failing for reasons unrelated to search.
const scratchId = `lab-search-${Date.now()}`;
await fetch(`http://localhost:8080/api/docs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  // No token: POST /api/docs without a session creates an UNOWNED document,
  // which is exactly the pile this check is about.
  body: JSON.stringify({ docId: scratchId, title: scratchId }),
});
await ada.reload({ waitUntil: 'domcontentloaded' });
await ada.waitForSelector('.docs-search input');
await sleep(600);

await ada.click('.docs-search input');
await ada.type('.docs-search input', scratchId);
await sleep(700);
/*
 * Search must NOT find this one, and the boundary is worth stating.
 *
 * Hiding results from an explicit query is how people conclude a document is
 * gone, so search reaches everything -- everything that is YOURS. It does not
 * extend to a document created by somebody else's browser that this person has
 * never opened.
 *
 * The cost is real and is accepted knowingly: a guest who loses their URL,
 * then signs in on the same browser, cannot find their document by searching
 * for its name. What finds it is `local-docs.js`, which is why that list
 * exists and why the page restores from it -- and if the browser's storage is
 * gone, so is the document, which is the price of not asking for an email.
 */
const searched = await ada.evaluate(() =>
  [...document.querySelectorAll('.docs-row .docs-name')].map((e) => e.textContent.trim()));
check("5. searching does not surface somebody else's unowned documents",
  !searched.some((t) => t.includes(scratchId)),
  `${searched.length} rows for ${scratchId}`);
await ada.$eval('.docs-search input', (el) => {
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(el, '');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(500);

// ---- 6. delete -----------------------------------------------------------------
//
// Confirmation is the app's own modal, not `confirm()`, so there is no
// `page.once('dialog')` hook here: a native dialog blocks the event loop, and
// an automated pass through this page would be one missed handler away from
// hanging rather than failing.
await menuFor(ada, RENAMED);
await ada.$$eval('.docs-menu button', (els) =>
  els.find((e) => e.textContent.trim() === 'Delete')?.click());
await ada.waitForSelector('.modal [role=alertdialog], [role=alertdialog]', { timeout: 5000 });
await ada.$$eval('.modal-actions button', (els) =>
  els.find((e) => e.textContent.trim() === 'Delete')?.click());
// Wait for the row to GO. `rowsIn` only retries while the list is empty, and
// after a delete it is not empty -- it still holds the row that is on its way
// out, so it would return stale rows immediately and the check would read them
// as "delete did nothing".
await until(
  () => ada.$$eval('.docs-row .docs-name', (els) => els.map((e) => e.textContent).join(' | '))
    .catch(() => ''),
  (names) => !names.includes(RENAMED), { timeout: 15_000 });

yours = await rowsIn(ada, 'Your documents');
check('6. delete removes it from the owner list',
  !yours.some((r) => r.includes(RENAMED)), yours.join(' ;; ') || '(empty)');

await bob.reload({ waitUntil: 'domcontentloaded' });
await bob.waitForSelector('.docs-section', { timeout: 15000 });
await sleep(1000);
const bobAfter = await rowsIn(bob, 'Shared with you');
check('6b. and from everyone it was shared with',
  !bobAfter.some((r) => r.includes(RENAMED)), bobAfter.join(' ;; ') || '(empty)');

// ---- 7. the way in from the landing page --------------------------------------
await ada.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await ada.waitForSelector('.docs-link', { timeout: 15000 });
/*
 * Wait for the entrance animation to finish before clicking.
 *
 * The landing page animates every panel in and removes `entrance-run` from
 * <html> when it is done, 1850ms in (Landing.jsx). Until then `.docs-link`
 * is mid `content-rise` -- present, hit-testable, and still moving. Clicking
 * it there is clicking a moving target, and the click can land on a node
 * React is replacing as the session resolves, in which case nothing
 * navigates and the failure reads as a broken link.
 *
 * Waiting for the page to settle is also what the assertion actually means:
 * a reader clicks this link after the page has arrived, not during.
 */
await ada.waitForFunction(
  () => !document.documentElement.classList.contains('entrance-run'),
  { timeout: 15000 });
await ada.click('.docs-link');
await ada.waitForSelector('.docs-page', { timeout: 15000 });
check('7. the landing page links to the documents page',
  new URL(ada.url()).pathname === '/docs', ada.url());

check('8. no page errors', errors.length === 0, errors.slice(0, 3).join(' ;; '));

if (HEADFUL) { console.log('\n  (headful: leaving the browser open for 20s)'); await sleep(20000); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
