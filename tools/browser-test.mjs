/**
 * Real-browser test. Drives the actual UI in headless Chrome.
 *
 * Everything else in tools/ drives the sync classes directly, which proved the
 * protocol correct while the browser was still broken -- the editor binding,
 * the React wiring and the DOM were never covered. This closes that gap.
 *
 *   node tools/browser-test.mjs           (needs: npm run dev)
 *   node tools/browser-test.mjs --headful (watch it happen)
 */
import puppeteer from 'puppeteer-core';
import { until } from './ui-wait.mjs';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const ENGINE = (process.argv.find((a) => a.startsWith('--engine=')) ?? '').split('=')[1] ?? 'yjs';
const SERVER = ENGINE === 'ot' ? '&server=ws://localhost:8081' : '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const doc = 'browser-' + Date.now();
const errors = [];

async function openTab(client) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 760 });
  page.on('pageerror', (e) => errors.push(`[${client}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${client}] console: ${m.text()}`);
  });
  // Chrome's console text for a failed fetch is "Failed to load resource: the
  // server responded with a status of 403" and does not say WHICH resource.
  // Without this the failure names a status and nothing else.
  page.on('response', (r) => {
    if (r.status() >= 400) {
      errors.push(`[${client}] http ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  // Not `networkidle0`: the app holds a WebSocket open for its entire life, so
  // the page never goes network-idle and the wait burns its full timeout.
  await page.goto(`${BASE}/doc?doc=${doc}&client=${client}&engine=${ENGINE}${SERVER}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  return page;
}

/**
 * What the editor actually shows.
 *
 * Peer caret labels are real DOM nodes inside .cm-content, so a naive innerText
 * folds other people's names into the document text. Clone and strip them.
 */
const editorText = (page) => page.$eval('.cm-content', (el) => {
  const clone = el.cloneNode(true);
  for (const caret of clone.querySelectorAll('.cm-peer-caret')) caret.remove();
  return clone.innerText.replace(/\u200b/g, '').trim();
});
const statusText = (page) => page.$eval('.status', (el) => el.innerText.trim());

/**
 * Wait for a tab to report a status, rather than sleeping and hoping.
 *
 * Reaching `synced` includes the socket admission path -- the session lookup,
 * the tab check, the document read, the permission read -- and the room's own
 * load, all of which are Postgres round trips. From a development machine to a
 * database in another region that is comfortably past a second; deployed in
 * the same region it is a few milliseconds. A fixed sleep is therefore either
 * flaky or slow, depending which of the two it is tuned for.
 *
 * Polling for the condition asserts the thing the check is about (the client
 * does reach synced) instead of how long it took, and is faster than a longer
 * sleep in the normal case.
 */
const waitForStatus = async (page, want, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  let text = await statusText(page);
  while (!text.includes(want) && Date.now() < deadline) {
    await sleep(200);
    text = await statusText(page);
  }
  return text;
};

async function typeInto(page, text) {
  // Background tabs are throttled in headless Chrome, and click() waits on a
  // clickable-point computation that never resolves for one. Always focus the
  // tab first -- without this the call simply hangs.
  await page.bringToFront();
  await page.click('.cm-content');
  await page.keyboard.type(text, { delay: 12 });
}

/**
 * Press a toolbar button by the START of its tooltip.
 *
 * Not the whole tooltip: they carry their keyboard shortcut now ("Bold
 * (Ctrl+B)"), and an exact match made this harness fail on a wording change
 * that broke nothing. Throwing on a miss matters as much as the click -- the
 * previous version used `?.click()`, so a button that had been renamed or
 * removed silently did nothing and the failure surfaced as a confusing
 * assertion about formatting two steps later.
 */
async function clickFmt(page, titlePrefix) {
  const clicked = await page.$$eval('.fmt-btn', (els, prefix) => {
    const b = els.find((e) => (e.getAttribute('title') ?? '').startsWith(prefix));
    if (!b) return false;
    b.click();
    return true;
  }, titlePrefix);
  if (!clicked) throw new Error(`no toolbar button titled "${titlePrefix}..."`);
}

/** Poll until both editors show the same thing. */
async function converged(pages, timeout = 6000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeout) {
    last = await Promise.all(pages.map(editorText));
    if (last.every((t) => t === last[0]) && last[0].length > 0) return last[0];
    await sleep(150);
  }
  return null;
}

console.log(`\nBrowser end-to-end  (engine=${ENGINE}, doc=${doc})\n`);

const alice = await openTab('alice');
const bob = await openTab('bob');
await sleep(1500);

// ---- 1. both tabs actually connect -----------------------------------------
{
  const a = await waitForStatus(alice, 'synced');
  const b = await waitForStatus(bob, 'synced');
  check('1. alice reaches synced', a.includes('synced'), a);
  check('1b. bob reaches synced', b.includes('synced'), b);
}

// ---- 2. THE regression: live propagation with no refresh -------------------
await typeInto(alice, 'hello from alice');
await sleep(1200);

const bobSees = await editorText(bob);
check('2. alice types -> bob sees it WITHOUT a refresh',
  bobSees.includes('hello from alice'), JSON.stringify(bobSees));

await typeInto(bob, ' and bob replies');
const both = await converged([alice, bob]);
check('3. bidirectional live sync', both !== null,
  both === null
    ? `alice=${JSON.stringify(await editorText(alice))} bob=${JSON.stringify(await editorText(bob))}`
    : JSON.stringify(both));

// ---- 3. identity: each tab must show who IT is -----------------------------
{
  const aliceSelf = await alice.$eval('.avatar-self', (el) => el.title);
  const bobSelf = await bob.$eval('.avatar-self', (el) => el.title);
  check('4. each tab identifies itself distinctly', aliceSelf !== bobSelf,
    `alice tab: "${aliceSelf}" | bob tab: "${bobSelf}"`);
  check('4b. alice tab is identifiably alice', /alice/i.test(aliceSelf), aliceSelf);
  check('4c. bob tab is identifiably bob', /bob/i.test(bobSelf), bobSelf);
}

// ---- 4. peer presence appears in the inspector -----------------------------
{
  const peerCount = await alice.$$eval('.peer-row', (els) => els.length);
  check('5. alice sees bob as a peer', peerCount === 1, `${peerCount} peer rows`);
  const peerName = peerCount ? await alice.$eval('.peer-name', (el) => el.innerText) : '';
  check('5b. peer is identifiably bob', /bob/i.test(peerName), peerName);
}

// ---- 5. inspector is actually live -----------------------------------------
{
  // The "log N/M" row comes from the DEBUG frame, and `Room.inspect` now makes
  // two Postgres round trips to build it (the loose-update count and the
  // current seq). The rest of the inspector renders from data the client
  // already has, so sampling once shows every other row populated and this one
  // still missing -- which reads as "the inspector is not live" when it simply
  // has not answered yet.
  const readRows = () => alice.$$eval('.row', (rows) =>
    rows.map((r) => r.innerText.replace(/\s+/g, ' ')).join(' | '));
  const seq = await until(readRows, (t) => /log \d+\/\d+/.test(t), { timeout: 15_000 });
  check('6. inspector shows live server data', /log \d+\/\d+/.test(seq), seq.slice(0, 160));
}

// ---- 6. offline -> online with no refresh ----------------------------------
{
  await alice.bringToFront();
  await alice.click('.status');
  await sleep(300);
  check('7. clicking the pill goes offline', (await statusText(alice)).includes('offline'),
    await statusText(alice));

  await typeInto(alice, ' [offline edit]');
  await typeInto(bob, ' [peer edit]');
  await sleep(300);

  await alice.bringToFront();
  await alice.click('.status');

  const back = await waitForStatus(alice, 'synced');
  check('8. clicking again reconnects without a reload', back.includes('synced'), back);

  const merged = await converged([alice, bob], 8000);
  check('9. clients converge after reconnect', merged !== null,
    merged === null
      ? `alice=${JSON.stringify(await editorText(alice))} bob=${JSON.stringify(await editorText(bob))}`
      : JSON.stringify(merged));
  check('9b. edits made by the still-online peer survived',
    !!merged && merged.includes('[peer edit]'));

  // The engines genuinely differ here, and asserting the difference is more
  // useful than asserting one behaviour and calling the other a bug:
  //
  //   CRDT  offline edits merge on reconnect. This is the reason to pick one.
  //   OT    the server pushes INIT/RESYNC and pending local work is discarded,
  //         because it cannot be rebased onto revisions the client never saw.
  //         See docs/decisions/004-ot-engine.md.
  const offlineKept = !!merged && merged.includes('[offline edit]');
  if (ENGINE === 'yjs') {
    check('9c. CRDT: offline edits merge on reconnect', offlineKept, JSON.stringify(merged));
  } else {
    check('9c. OT: offline edits are discarded on resync, as designed',
      !offlineKept, JSON.stringify(merged));
  }
}

// ---- 7. two tabs sharing a clientId must still sync ------------------------
{
  // Regression: the room used to key sockets by the client-supplied id, so a
  // duplicate silently evicted the first connection and broadcasts skipped the
  // survivor. It presented as "sync is broken, I have to refresh".
  const dupDoc = 'dup-' + Date.now();
  const t1 = await openTab('same');
  const t2 = await openTab('same');
  await sleep(1200);
  await t1.goto(`${BASE}/doc?doc=${dupDoc}&client=same&engine=${ENGINE}${SERVER}`, { waitUntil: 'domcontentloaded' });
  await t2.goto(`${BASE}/doc?doc=${dupDoc}&client=same&engine=${ENGINE}${SERVER}`, { waitUntil: 'domcontentloaded' });
  await t1.waitForSelector('.cm-content');
  await t2.waitForSelector('.cm-content');
  // Both have to be synced before one types, or the edit is made against a
  // document the other has not loaded yet and the check measures the race.
  await waitForStatus(t1, 'synced');
  await waitForStatus(t2, 'synced');

  await typeInto(t1, 'duplicate ids still sync');
  let seen = await editorText(t2);
  for (const deadline = Date.now() + 15_000; !seen.includes('duplicate ids still sync')
    && Date.now() < deadline;) {
    await sleep(250);
    seen = await editorText(t2);
  }
  check('11. two tabs with the same client id still sync',
    seen.includes('duplicate ids still sync'), JSON.stringify(seen));

  await t1.close(); await t2.close();
}

// ---- 9. rich text through the real UI --------------------------------------
//
// The headless checklists drive sync.format() directly. This drives the
// TOOLBAR, in a browser, and asserts the mark shows up in the OTHER tab --
// which is the only way to catch the parts that live between the two: the
// selection the button reads, the decoration layer, and the fact that a
// format-only change moves no characters and so must repaint on its own.
{
  const fmtDoc = 'fmt-' + Date.now();
  const one = await openTab('alice');
  const two = await openTab('bob');
  await one.goto(`${BASE}/doc?doc=${fmtDoc}&client=alice&engine=${ENGINE}${SERVER}`, { waitUntil: 'domcontentloaded' });
  await two.goto(`${BASE}/doc?doc=${fmtDoc}&client=bob&engine=${ENGINE}${SERVER}`, { waitUntil: 'domcontentloaded' });
  await one.waitForSelector('.cm-content');
  await two.waitForSelector('.cm-content');
  // Both synced before either types. `.cm-content` only means the editor
  // mounted; the socket is still being admitted behind it, and a formatting
  // mark applied before the second tab has loaded the document arrives at a
  // replica that has nothing to apply it to -- which is why every check in
  // this section reported an empty string rather than unformatted text.
  await waitForStatus(one, 'synced');
  await waitForStatus(two, 'synced');

  await typeInto(one, 'format me please');
  // And the text has to have reached the other tab before it can be expected
  // to show a mark on it.
  for (const deadline = Date.now() + 15_000;
    !(await editorText(two)).includes('format me please') && Date.now() < deadline;) {
    await sleep(200);
  }

  // Select the first word, then press Bold.
  await one.bringToFront();
  await one.click('.cm-content');
  await one.keyboard.down('Control');
  await one.keyboard.press('Home');
  await one.keyboard.up('Control');
  await one.keyboard.down('Shift');
  for (let i = 0; i < 6; i++) await one.keyboard.press("ArrowRight");
  await one.keyboard.up('Shift');

  // Titles carry their keyboard shortcut now ("Bold  (Ctrl+B)"), so match on
  // the prefix rather than the whole string -- pinning the exact title made
  // this harness fail on a change to a tooltip.
  await clickFmt(one, 'Bold');
  await sleep(1200);

  const boldHere = await one.$$eval('.cm-fmt-bold', (els) => els.map((e) => e.textContent).join('|'));
  const boldThere = await two.$$eval('.cm-fmt-bold', (els) => els.map((e) => e.textContent).join('|'));

  check('12. bold applies in the tab that pressed it', boldHere.includes('format'), JSON.stringify(boldHere));
  check('12b. the mark reaches the other tab live', boldThere.includes('format'), JSON.stringify(boldThere));
  check('12c. text itself is unchanged',
    (await editorText(two)).startsWith('format me please'), JSON.stringify(await editorText(two)));

  // A heading is a LINE attribute, carried on the trailing newline. On the
  // last line of a document there is no newline to carry it, so the toolbar
  // appends one -- this is the check that that path works end to end.
  // Headings moved from a pair of toggle buttons to a paragraph-style select
  // (they are mutually exclusive; see Toolbar.jsx). Driven the way a person
  // would: pick the option and let React's onChange fire.
  await one.select('select[aria-label="Paragraph style"]', '1');
  await sleep(1200);
  const headingThere = await two.$$eval('.cm-fmt-header-1', (els) => els.length);
  check('12d. a heading set on the last line reaches the other tab', headingThere > 0, `${headingThere} heading lines`);


  // Bullets on three consecutive lines. A regression test for a trap the
  // line-attribute design invites: block formatting is stored on the newline
  // ENDING a line, so the character before a caret at the start of line N is
  // line N-1 s newline -- carrying line N-1 s bullet. The toolbar read that
  // as "this line is already bulleted" and toggled it OFF, so bulleting a
  // list left every other line unbulleted.
  await one.click('.cm-content');
  await one.keyboard.down('Control'); await one.keyboard.press('End'); await one.keyboard.up('Control');
  await one.keyboard.type(["", "alpha", "beta", "gamma"].join(String.fromCharCode(10)), { delay: 8 });
  await sleep(500);
  for (let i = 0; i < 3; i++) {
    await one.keyboard.down('Control'); await one.keyboard.press('End'); await one.keyboard.up('Control');
    for (let up = 0; up < 2 - i; up++) await one.keyboard.press('ArrowUp');
    await clickFmt(one, 'Bulleted list');
    await sleep(350);
  }
  await sleep(600);
  const bulleted = await one.$$eval('.cm-line', (els) =>
    els.filter((e) => e.className.includes("cm-fmt-list-bullet")).map((e) => e.textContent));
  check('12e. bulleting consecutive lines does not toggle the previous one off',
    bulleted.length === 3, bulleted.join(" | "));

  // ---- 13. the value-carrying attributes, over the wire --------------------
  //
  // Colour, size, alignment, indent and links are a different kind of
  // attribute from bold: they carry a VALUE, which has to survive the engine's
  // transform and arrive at the other replica intact. Checked in the SECOND
  // tab throughout -- that a value renders in the tab that set it proves only
  // that the toolbar works.

  // Select the first word again and colour it.
  await one.click('.cm-content');
  await one.keyboard.down('Control'); await one.keyboard.press('Home'); await one.keyboard.up('Control');
  await one.keyboard.down('Shift');
  for (let i = 0; i < 6; i++) await one.keyboard.press('ArrowRight');
  await one.keyboard.up('Shift');

  await clickFmt(one, 'Text colour');
  await one.waitForSelector('.fmt-popover .swatch', { timeout: 5000 });
  await one.$$eval('.fmt-popover .swatch', (els) => els[3].click());
  await sleep(1200);

  /*
   * Read the COMPUTED colour, not the style string. `#b91c1c` goes in and
   * `rgb(185, 28, 28)` comes back -- the browser normalises it, and asserting
   * on the hex made this fail while the rendering was perfectly correct.
   *
   * And concatenate the coloured spans rather than requiring ONE of them to
   * hold the whole word. CodeMirror is free to split a styled range across
   * adjacent spans, and it does: this failed about one run in three with
   * `forma` + `t`, or `form` + `at`, both carrying the right colour. The
   * product was correct every time; the assertion was reading DOM structure
   * the renderer never promised. What is being checked is that the coloured
   * text is "format", not how many elements it took to draw it.
   */
  const coloured = await two.$$eval('.cm-content span[style*="color"]', (els) => els
    .filter((e) => getComputedStyle(e).color === 'rgb(185, 28, 28)')
    .map((e) => e.textContent)
    .join(''));
  check('13. a text colour reaches the other tab as a real style',
    coloured.includes('format'), JSON.stringify(coloured).slice(0, 90));

  // Numbered list, on the three lines that are currently bulleted. The number
  // is computed from the lines above rather than stored, so this is really a
  // check that the RENDERER agrees with itself on the far side.
  for (let i = 0; i < 3; i++) {
    await one.keyboard.down('Control'); await one.keyboard.press('End'); await one.keyboard.up('Control');
    for (let up = 0; up < 2 - i; up++) await one.keyboard.press('ArrowUp');
    await clickFmt(one, 'Numbered list');
    await sleep(350);
  }
  await sleep(900);
  const numbered = await two.$$eval('.cm-line', (els) => els
    .filter((e) => e.className.includes('cm-fmt-list-number'))
    .map((e) => e.getAttribute('style') ?? ''));
  check('13b. a numbered list reaches the other tab', numbered.length === 3,
    `${numbered.length} numbered lines`);
  check('13c. and is numbered 1,2,3 there -- the count restarts per list',
    numbered.join(' ') === '--list-n: "1"; --list-n: "2"; --list-n: "3";',
    numbered.join(' '));

  // Alignment and indent are line attributes with values.
  await clickFmt(one, 'Center');
  await sleep(800);
  check('13d. alignment reaches the other tab',
    (await two.$$eval('.cm-line', (els) =>
      els.filter((e) => e.className.includes('cm-fmt-align-center')).length)) > 0);

  await clickFmt(one, 'Increase indent');
  await clickFmt(one, 'Increase indent');
  await sleep(900);
  check('13e. indent reaches the other tab, at the level it was set to',
    (await two.$$eval('.cm-line', (els) =>
      els.filter((e) => e.className.includes('cm-fmt-indent-2')).length)) > 0);

  // Links. The safe one must arrive; the hostile one must not be rendered as a
  // link ANYWHERE -- this is the check that the sanitiser is actually on the
  // render path and not merely on the input path, which is the difference
  // between a real defence and a UI-level one a peer can bypass.
  await one.click('.cm-content');
  await one.keyboard.down('Control'); await one.keyboard.press('Home'); await one.keyboard.up('Control');
  await one.keyboard.down('Shift');
  for (let i = 0; i < 6; i++) await one.keyboard.press('ArrowRight');
  await one.keyboard.up('Shift');

  await clickFmt(one, 'Insert link');
  await one.waitForSelector('.link-form input', { timeout: 5000 });
  await one.type('.link-form input', 'example.com/docs');
  await one.$eval('.link-form button[type=submit]', (b) => b.click());
  await sleep(1200);

  const linked = await two.$$eval('.cm-fmt-link',
    (els) => els.map((e) => e.getAttribute('data-href')).join('|'));
  check('13f. a link reaches the other tab with its href',
    linked.includes('https://example.com/docs'), linked);

  // Now write a javascript: url straight into the document model, bypassing
  // the toolbar entirely -- exactly what a hostile client would do.
  await one.evaluate(() => {
    window.__sync?.format?.(0, 6, { link: 'javascript:alert(1)' });
  });
  await sleep(1000);
  const hostile = await two.$$eval('[data-href]',
    (els) => els.map((e) => e.getAttribute('data-href')).join('|'));
  check('13g. a javascript: link forced into the model renders as no link at all',
    !/javascript/i.test(hostile), hostile || '(none)');

  await one.close(); await two.close();
}

// ---- 8. no uncaught errors -------------------------------------------------
check('10. no page errors', errors.length === 0, errors.slice(0, 3).join(' ;; '));

if (HEADFUL) { console.log('\n  (headful: leaving the browser open for 20s)'); await sleep(20_000); }
await browser.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
