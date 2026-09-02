/**
 * The comment journey, through the real UI in real Chrome.
 *
 * The headless harnesses in `comments-test.mjs` prove the protocol: anchors
 * move, orphan and converge. None of that touches the editor binding, the
 * decoration layer or the sidebar -- which is the same gap `browser-test.mjs`
 * exists to close for the document itself.
 *
 * What is actually worth driving a browser for:
 *
 *   - selecting text and pressing Comment produces a highlight in the DOM
 *   - typing before the highlight leaves it on the same word
 *   - a SECOND tab sees the thread and highlights the same characters
 *   - deleting the commented text marks the thread orphaned in the sidebar
 *
 *   node tools/comments-ui-test.mjs            (needs: npm run dev)
 *   node tools/comments-ui-test.mjs --headful  (watch it happen)
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { until, present } from './ui-wait.mjs';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  // Written synchronously, like the other harnesses: stdout is fully buffered
  // when it is a pipe or a file, so a run that hangs or is killed loses
  // precisely the lines that say how far it got.
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const docId = 'comments-ui-' + Date.now();
const errors = [];

async function openTab(client) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 860 });
  page.on('pageerror', (e) => errors.push(`[${client}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${client}] console: ${m.text()}`);
  });
  await page.goto(`${BASE}/doc?doc=${docId}&client=${client}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  // Synced, not merely mounted. `.cm-content` renders before the socket is
  // admitted -- which is now four Postgres round trips plus the room's load --
  // and text typed into that gap is reconciled against the server's state when
  // it finally arrives. The visible symptom was a comment quoting "The quick"
  // where "brown" had been selected: the selection was computed against a
  // document that changed underneath it.
  await until(() => page.$eval('.status', (e) => e.innerText).catch(() => ''),
    (t) => t.includes('synced'), { timeout: 25_000 });
  return page;
}

/** Select `word` in the editor by dragging across its glyphs. */
async function selectWord(page, word) {
  const box = await page.evaluate((w) => {
    const view = window.__sync && document.querySelector('.cm-content');
    const text = view.textContent;
    const at = text.indexOf(w);
    if (at < 0) return null;
    // Walk the DOM to find the text node holding it, then measure a range.
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let seen = 0, node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (seen + len > at) {
        const range = document.createRange();
        range.setStart(node, at - seen);
        range.setEnd(node, Math.min(at - seen + w.length, len));
        const r = range.getBoundingClientRect();
        /*
         * Asymmetric on purpose, and the asymmetry was measured rather than
         * reasoned about.
         *
         * The right end used to sit at `right - 1`: one pixel INSIDE the last
         * glyph, which leaves the boundary to however a fractional pixel
         * rounded. Under the load of the full suite it rounded short often
         * enough to select "brow" instead of "brown" -- a failure that reads
         * as a product bug and is not one. A pixel past the right edge lands
         * in the following space, well short of its midpoint, and resolves to
         * the end of the word with room to spare.
         *
         * The left end stays INSIDE. Pulling it a pixel left was tried and
         * selects " brown": the leading space resolves to the boundary before
         * itself, not after.
         */
        return { x1: r.left + 1, y: r.top + r.height / 2, x2: r.right + 1 };
      }
      seen += len;
    }
    return null;
  }, word);
  if (!box) throw new Error(`could not locate "${word}" in the editor`);
  await page.mouse.move(box.x1, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y, { steps: 6 });
  await page.mouse.up();
  await sleep(150);
}

/**
 * Click the element whose text is exactly `text`.
 *
 * Dispatched inside the page rather than through the mouse. Puppeteer's own
 * click scrolls the node into view first, and a sidebar button that has just
 * re-rendered underneath it can leave that scroll waiting on a node the React
 * tree has already replaced -- which hangs rather than failing, and is a much
 * worse thing for a test to do than report a missing button.
 */
const clickByText = async (page, selector, text) => {
  const found = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t);
    if (!el) return false;
    el.click();
    return true;
  }, selector, text);
  if (!found) throw new Error(`no ${selector} with text "${text}"`);
  await sleep(150);
};

const highlighted = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.cm-comment-range')].map((e) => e.textContent).join(''));

console.log('\nComments through the UI\n');

// ---- 1. open a thread -------------------------------------------------------
const alice = await openTab('alice');
// Focused directly rather than clicked: `page.click` scrolls to an element's
// centre point, and the editor's tall bottom padding puts that far below the
// fold, where the scroll can wait indefinitely.
await alice.evaluate(() => document.querySelector('.cm-content').focus());
await alice.keyboard.type('The quick brown fox jumps over the lazy dog');
await sleep(400);

await selectWord(alice, 'brown');
await clickByText(alice, 'button.fmt-btn', 'Comment');
await alice.waitForSelector('.comment-new textarea', { timeout: 5_000 });
check('1. Comment opens a draft thread on the selection', true);

const draftQuote = await alice.$eval('.comment-new .comment-quote', (e) => e.textContent.trim());
check('1b. the draft quotes the selected text', draftQuote === 'brown', JSON.stringify(draftQuote));

await alice.type('.comment-new textarea', 'is it though?');
await clickByText(alice, '.comment-new button', 'Comment');
await alice.waitForSelector('.comment-thread:not(.comment-new)', { timeout: 8_000 });
await sleep(500);

check('2. the commented text is highlighted', (await highlighted(alice)) === 'brown',
  JSON.stringify(await highlighted(alice)));
check('2b. the thread body is shown',
  (await alice.$eval('.comment-body', (e) => e.textContent.trim())) === 'is it though?');

// ---- 2. the anchor tracks the text -----------------------------------------
await alice.evaluate(() => document.querySelector('.cm-content').focus());
await alice.keyboard.down('Control'); await alice.keyboard.press('Home');
await alice.keyboard.up('Control');
await alice.keyboard.type('>>> ');
await sleep(600);

check('3. typing before the comment leaves it on the same word',
  (await highlighted(alice)) === 'brown', JSON.stringify(await highlighted(alice)));

// ---- 3. a second tab agrees -------------------------------------------------
const bob = await openTab('bob');
// Wait for the highlight rather than sleeping at it: the thread list arrives
// over HTTP and the anchors resolve after that, so a fixed delay is a race
// that passes on a fast machine and fails on a loaded one.
await bob.waitForSelector('.cm-comment-range', { timeout: 10_000 });
const bobHighlight = await highlighted(bob);
// The sidebar does not open itself. A second reader gets the highlights and a
// count on the Comments button; opening the pane is their decision, the same
// way History is.
check('4a. the header offers a comment count without the pane being open',
  (await bob.$eval('.header-badge', (e) => e.textContent.trim())) === '1');
await clickByText(bob, 'button.header-btn', 'Comments1');
await bob.waitForSelector('.comments-pane', { timeout: 5_000 });
check('4. a second client highlights the same characters', bobHighlight === 'brown',
  JSON.stringify(bobHighlight));
check('4b. and sees the thread in its sidebar',
  (await bob.$$eval('.comment-body', (els) => els.map((e) => e.textContent.trim())))
    .includes('is it though?'));

// ---- 4. replies -------------------------------------------------------------
await clickByText(bob, '.comment-thread .btn-quiet', 'Reply');
await bob.type('.comment-reply textarea', 'yes, quite brown');
await clickByText(bob, '.comment-reply button', 'Reply');
// Posting a reply is a write followed by a re-read, and the other client is
// told over the socket and then re-reads too. Both are round trips now.
const bobComments = await until(
  () => bob.$$eval('.comment-body', (e) => e.length).catch(() => 0),
  (n) => n === 2, { timeout: 15_000 });
check('5. a reply is added to the thread', bobComments === 2, `${bobComments} comments`);

const aliceComments = await until(
  () => alice.$$eval('.comment-body', (e) => e.length).catch(() => 0),
  (n) => n === 2, { timeout: 15_000 });
check('5b. the first client sees the reply too', aliceComments === 2,
  `${aliceComments} comments`);

// ---- 5. deleting the text orphans the thread --------------------------------
await selectWord(alice, 'brown');
await alice.keyboard.press('Backspace');
await sleep(1200);

check('6. deleting the commented text removes the highlight',
  (await highlighted(alice)) === '', JSON.stringify(await highlighted(alice)));
check('6b. and the thread says so rather than moving',
  await alice.$('.comment-thread.is-orphaned') !== null);

// ---- 6. resolve -------------------------------------------------------------
await clickByText(alice, '.comment-thread .btn-quiet', 'Resolve');
check('7. resolving moves the thread out of the open list',
  await present(alice, '.comments-resolved', { timeout: 15_000 }));

check('8. no page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
