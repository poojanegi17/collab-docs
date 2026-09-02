/**
 * Tabs and the task list, through the real UI in real Chrome.
 *
 * `tabs-tasks-test.mjs` proves the protocol and the storage: a tab is a
 * document, sharing is inherited, the checklist is one list per document. None
 * of that touches the index panel, the pane, or the thing that makes tabs
 * different
 * from every other feature in this app -- switching one REPLACES THE SOCKET,
 * so the editor is torn down and rebuilt around a different document while the
 * page stays where it is.
 *
 * What is worth driving a browser for:
 *
 *   - clicking a tab in the index swaps the text, and swaps it back
 *   - the open tab lists its own headings, and clicking one moves the caret
 *   - a second person in tab two sees what the first types there, and does not
 *     see what they type in tab one
 *   - renaming a tab reaches the other browser
 *   - a task added by one person can be ticked by the other, from a different
 *     tab, with their name recorded
 *
 *   node tools/tabs-tasks-ui-test.mjs            (needs: npm run dev)
 *   node tools/tabs-tasks-ui-test.mjs --headful  (watch it happen)
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { until } from './ui-wait.mjs';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
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

const docId = 'tabs-ui-' + Date.now();
const errors = [];

async function openTab(client, query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 900 });
  page.on('pageerror', (e) => errors.push(`[${client}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${client}] console: ${m.text()}`);
  });
  await page.goto(`${BASE}/doc?doc=${docId}&client=${client}${query}`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  return page;
}

/** Type into the editor. Focused rather than clicked -- see comments-ui-test. */
const typeInDoc = async (page, text) => {
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.type(text);
  await sleep(400);
};

const docText = (page) => page.evaluate(() => window.__sync.getText());

const tabNames = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.doc-tab-btn')].map((e) => e.textContent.trim()));

const clickTab = async (page, name) => {
  const found = await page.evaluate((n) => {
    const el = [...document.querySelectorAll('.doc-tab-btn')]
      .find((e) => e.textContent.trim() === n);
    if (!el) return false;
    el.click();
    return true;
  }, name);
  if (!found) throw new Error(`no tab called "${name}"`);
  // Switching a tab replaces the socket. Wait for the new one to sync rather
  // than for a fixed delay, or this test measures the network.
  await page.waitForFunction(() => window.__sync?.synced === true, { timeout: 10_000 })
    .catch(() => {});
  await sleep(600);
};

// Matches on the START of the text, not the whole of it: a header button
// carries a count badge inside it, so "Tasks" is "Tasks3" by the time there is
// anything to count.
const clickByText = async (page, selector, text) => {
  const found = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)]
      .find((e) => e.textContent.trim().startsWith(t));
    if (!el) return false;
    el.click();
    return true;
  }, selector, text);
  if (!found) throw new Error(`no ${selector} with text "${text}"`);
  await sleep(200);
};

console.log('\nTabs and tasks through the UI\n');

// ---- 1. one tab, then two ---------------------------------------------------

const alice = await openTab('alice');
await alice.waitForSelector('.tab-index', { timeout: 10_000 });
check('1. a new document shows one tab', (await tabNames(alice)).length === 1,
  JSON.stringify(await tabNames(alice)));

await typeInDoc(alice, 'first tab text');
check('1b. and it holds the document text', (await docText(alice)) === 'first tab text',
  JSON.stringify(await docText(alice)));

await alice.click('.tab-index-add');
await alice.waitForFunction(
  () => document.querySelectorAll('.doc-tab-btn').length === 2, { timeout: 10_000 });
await sleep(800);
check('2. adding a tab opens it', (await docText(alice)) === '',
  JSON.stringify(await docText(alice)));
check('2b. and the first tab is still listed',
  (await tabNames(alice)).length === 2, JSON.stringify(await tabNames(alice)));

await typeInDoc(alice, 'second tab text');
check('3. the new tab holds its own text', (await docText(alice)) === 'second tab text',
  JSON.stringify(await docText(alice)));

// The URL names the tab, so a reload comes back to it rather than to tab one.
const urlHasTab = await alice.evaluate(() => new URL(location.href).searchParams.has('tab'));
check('3b. the address bar names the open tab', urlHasTab);

// ---- 2. switching back ------------------------------------------------------

const names = await tabNames(alice);
await clickTab(alice, names[0]);
check('4. switching back shows the first tab text',
  (await docText(alice)) === 'first tab text', JSON.stringify(await docText(alice)));

await clickTab(alice, names[1]);
check('4b. and forward again shows the second',
  (await docText(alice)) === 'second tab text', JSON.stringify(await docText(alice)));

// ---- 3. a second person -----------------------------------------------------

const bob = await openTab('bob');
await bob.waitForSelector('.tab-index', { timeout: 10_000 });
await sleep(600);
check('5. a second browser sees both tabs',
  (await tabNames(bob)).length === 2, JSON.stringify(await tabNames(bob)));
check('5b. and lands in the first one',
  (await docText(bob)) === 'first tab text', JSON.stringify(await docText(bob)));

await clickTab(bob, names[1]);
check('6. it can open the second tab', (await docText(bob)) === 'second tab text',
  JSON.stringify(await docText(bob)));

// Both are now in tab two. Typing there must reach the other browser.
await typeInDoc(bob, ' + bob was here');
await sleep(700);
check('7. edits in a tab reach everyone in that tab',
  (await docText(alice)).includes('bob was here'), JSON.stringify(await docText(alice)));

// And must not reach tab one.
await clickTab(bob, names[0]);
check('7b. and not the other tab', !(await docText(bob)).includes('bob was here'),
  JSON.stringify(await docText(bob)));

// ---- 4. renaming ------------------------------------------------------------

await alice.evaluate(() => {
  const wrap = [...document.querySelectorAll('.index-tab')]
    .find((e) => e.classList.contains('is-active'));
  wrap.querySelector('.doc-tab-more').click();
});
await sleep(200);
await clickByText(alice, '.doc-tab-menu button', 'Rename');
await alice.waitForSelector('.doc-tab-rename', { timeout: 5_000 });
await alice.evaluate(() => { document.querySelector('.doc-tab-rename').value = ''; });
await alice.type('.doc-tab-rename', 'Research');
await alice.keyboard.press('Enter');
// The rename is a PATCH, then the tab rail re-reads. Both are round trips.
await until(() => tabNames(alice), (names) => names.includes('Research'),
  { timeout: 15_000 });
check('8. a tab can be renamed', (await tabNames(alice)).includes('Research'),
  JSON.stringify(await tabNames(alice)));

await bob.waitForFunction(
  () => [...document.querySelectorAll('.doc-tab-btn')].some((e) => e.textContent.trim() === 'Research'),
  { timeout: 10_000 }).catch(() => {});
check('8b. and the rename reaches the other browser',
  (await tabNames(bob)).includes('Research'), JSON.stringify(await tabNames(bob)));

// ---- 4b. the index is an outline too ---------------------------------------

// Alice is in tab one ("Research" is tab two after the rename above); give it
// headings and check they show up under the tab that is open.
await clickTab(alice, 'Research');
await alice.evaluate(() => document.querySelector('.cm-content').focus());
await alice.keyboard.down('Control'); await alice.keyboard.press('End');
await alice.keyboard.up('Control');
await alice.keyboard.type(
  ['', 'Findings', 'some prose here', 'Open questions', 'and more', ''].join('\n'));
await sleep(500);

// Style the two heading lines. Selecting the line and using the style dropdown
// is what a person does; the dropdown is the toolbar's `.fmt-select`.
const styleLine = async (page, word, value) => {
  await page.evaluate((w) => {
    const view = window.__view;
    const at = view.state.doc.toString().indexOf(w);
    const line = view.state.doc.lineAt(at);
    view.dispatch({ selection: { anchor: line.from, head: line.to } });
    view.focus();
  }, word);
  // The first `.fmt-select` is the paragraph style; its values are the heading
  // levels themselves ('1'..'3'), which is what the attribute stores.
  await page.select('.fmt-select', value);
  await sleep(500);
};
await styleLine(alice, 'Findings', '1');
await styleLine(alice, 'Open questions', '2');
await sleep(600);

const outline = await alice.evaluate(() =>
  [...document.querySelectorAll('.outline-item')].map((e) => e.textContent.trim()));
check('9. the open tab lists its headings, in document order',
  outline.join('|') === 'Findings|Open questions', JSON.stringify(outline));

check('9b. and only under the tab that is open -- the other has no outline',
  await alice.evaluate(() => {
    const tabs = [...document.querySelectorAll('.index-tab')];
    const inactive = tabs.find((t) => !t.classList.contains('is-active'));
    return inactive?.querySelectorAll('.outline-item').length === 0;
  }));

// Clicking a heading moves the caret to it, so typing lands there.
await alice.evaluate(() => {
  const item = [...document.querySelectorAll('.outline-item')]
    .find((e) => e.textContent.trim() === 'Findings');
  item.click();
});
await sleep(400);
const caretAt = await alice.evaluate(() => {
  const view = window.__view;
  const head = view.state.selection.main.head;
  return view.state.doc.lineAt(head).text;
});
// Trimmed, deliberately: Enter carries the previous line's indentation in
// CodeMirror, so these lines begin with a space that the earlier steps put
// there. The caret is at the START of the heading's line either way, which is
// what the index promises.
check('9c. clicking a heading moves the caret to it', caretAt.trim() === 'Findings',
  JSON.stringify(caretAt));

check('9d. and the index marks the section the caret is in',
  await alice.$eval('.outline-item.is-here', (e) => e.textContent.trim()) === 'Findings');

// ---- 5. the task list -------------------------------------------------------

// Deliberately with the two browsers in DIFFERENT tabs: the list belongs to the
// document, and this is the check that says so (ADR-015).
await clickByText(alice, '.header-btn', 'Tasks');
await alice.waitForSelector('.tasks-pane', { timeout: 5_000 });
await alice.type('.task-new input', 'check the anchors');
await clickByText(alice, '.task-new button', 'Add');
await alice.waitForSelector('.task', { timeout: 5_000 });
check('10. a task can be added', await alice.$eval('.task-text', (e) => e.textContent.trim())
  === 'check the anchors');

await clickByText(bob, '.header-btn', 'Tasks');
await bob.waitForSelector('.tasks-pane', { timeout: 5_000 });
await bob.waitForSelector('.task', { timeout: 10_000 }).catch(() => {});
check('10b. the other browser sees it from a different tab',
  await bob.$eval('.task-text', (e) => e.textContent.trim()).catch(() => null)
    === 'check the anchors');

// The point of the feature: somebody who did not write the task completes it.
await bob.click('.task-check input');
check('11. anyone can tick it off',
  await until(() => bob.$eval('.task input', (e) => e.checked).catch(() => false),
    (v) => v === true, { timeout: 15_000 }));
// "done by" is written by the server and read back, so it lands after the
// checkbox does -- the box is ticked optimistically, the attribution is not.
const meta = await until(
  () => bob.$eval('.task-meta', (e) => e.textContent).catch(() => ''),
  (t) => t.includes('done by'), { timeout: 15_000 });
check('11b. and it says who did', meta.includes('done by'), meta);

await alice.waitForFunction(
  () => document.querySelector('.task input')?.checked === true,
  { timeout: 10_000 }).catch(() => {});
check('11c. and the author is told',
  await alice.$eval('.task input', (e) => e.checked));

const badge = await alice.evaluate(() => {
  const btn = [...document.querySelectorAll('.header-btn')]
    .find((e) => e.textContent.trim().startsWith('Tasks'));
  return btn?.querySelector('.header-badge')?.textContent ?? null;
});
check('11d. the header count is what is LEFT to do, so it clears', badge === null,
  JSON.stringify(badge));

// ---- 6. deleting a tab ------------------------------------------------------

// Bob is in tab one; Alice deletes it out from under him and he must land
// somewhere real rather than on a socket the server now refuses.
alice.on('dialog', (d) => d.accept());
await clickTab(alice, names[0]);
await alice.evaluate(() => {
  const wrap = [...document.querySelectorAll('.index-tab')]
    .find((e) => e.classList.contains('is-active'));
  wrap.querySelector('.doc-tab-more').click();
});
await sleep(200);
await clickByText(alice, '.doc-tab-menu button', 'Delete tab');
// Deleting soft-deletes the row, the rail re-reads, and the client is moved
// into the surviving tab -- which means loading that tab's document.
await until(() => tabNames(alice), (names) => names.length === 1, { timeout: 20_000 });
check('12. a deleted tab leaves one behind', (await tabNames(alice)).length === 1,
  JSON.stringify(await tabNames(alice)));
const movedInto = await until(() => docText(alice),
  (t) => t.includes('bob was here'), { timeout: 20_000 });
check('12b. and the deleter is moved into it',
  movedInto.includes('bob was here'), JSON.stringify(movedInto));

await bob.waitForFunction(
  () => document.querySelectorAll('.doc-tab-btn').length === 1, { timeout: 10_000 }).catch(() => {});
await sleep(1200);
check('12c. the person who was IN it is moved too, not stranded',
  (await docText(bob)).includes('bob was here'), JSON.stringify(await docText(bob)));

check('13. no page errors anywhere', errors.length === 0, errors.join(' | '));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await browser.close();
clearTimeout(guard);
process.exit(fail ? 1 : 0);
