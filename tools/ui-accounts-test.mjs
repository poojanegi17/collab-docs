/**
 * The accounts, sharing and history features, driven through the real UI.
 *
 * `api-test.mjs` proves the server enforces the rules. This proves a person
 * can reach them: sign up in the browser, create a document with a title,
 * share it, and watch a viewer's tab go read-only.
 *
 * Two browser CONTEXTS, not two tabs. The session token lives in localStorage,
 * which tabs share -- so two tabs are always the same person, and every
 * sharing check would silently pass.
 *
 *   node tools/ui-accounts-test.mjs [--headful]
 */
import puppeteer from 'puppeteer-core';
import { until, present, textUntil, titleAfterHello, allTextUntil } from './ui-wait.mjs';

const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/**
 * The document's text, with remote cursor labels removed.
 *
 * Peer carets are rendered inside the content, so a raw innerText splices a
 * collaborator's name into the middle of whatever word they are standing on --
 * which fails an assertion about text that is in fact perfectly correct.
 */
const editorText = (page) => page.$eval('.cm-content', (el) => {
  const clone = el.cloneNode(true);
  for (const caret of clone.querySelectorAll('.cm-peer-caret')) caret.remove();
  return clone.innerText.replace(/​/g, '').trim();
});

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

const stamp = Date.now();
const ADA = { email: `ada-${stamp}@example.com`, name: 'Ada', password: 'lovelace1' };
const BOB = { email: `bob-${stamp}@example.com`, name: 'Bob', password: 'password1' };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  args: ['--no-sandbox'],
});

const errors = [];

/** A fresh browser context = a fresh localStorage = a different person. */
async function person(label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 820 });
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  return { ctx, page };
}

async function signUp(page, who) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.account-btn', { timeout: 15000 });
  await page.click('.account-btn');
  await page.waitForSelector('.account-form');
  await page.$$eval('.account-tabs button', (els) => {
    els.find((e) => e.textContent.includes('Create account'))?.click();
  });
  await sleep(200);
  const inputs = await page.$$('.account-form input');
  await inputs[0].type(who.email);
  await inputs[1].type(who.name);
  await inputs[2].type(who.password);
  await page.$eval('.account-form button[type=submit]', (b) => b.click());
  await page.waitForSelector('.account-chip', { timeout: 15000 });
}

console.log('\nAccounts, sharing and history through the UI\n');

const ada = await person('ada');
const bob = await person('bob');

// ---- 1. sign up -------------------------------------------------------------
await signUp(ada.page, ADA);
check('1. sign up from the landing page',
  (await ada.page.$eval('.account-chip', (e) => e.textContent.trim())).includes('Ada'));

await signUp(bob.page, BOB);
check('1b. a second browser context is a different person',
  (await bob.page.$eval('.account-chip', (e) => e.textContent.trim())).includes('Bob'));

// ---- 2. create a document with a real title --------------------------------
const TITLE = `Ada notes ${stamp}`;
await ada.page.click('.searchbox input, .search input, input[type=text]').catch(() => {});
{
  const input = await ada.page.$('input[placeholder*="Search"]');
  await input.click();
  await input.type(TITLE);
  await sleep(500);
  await ada.page.keyboard.press('Enter');
  await ada.page.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(1200);
}

const docUrl = ada.page.url();
const docId = new URL(docUrl).searchParams.get('doc');
check('2. creating from the landing page opens an owned document',
  /^ada-notes-/.test(docId ?? ''), docId);

const headerTitle = await titleAfterHello(ada.page, docId);
check('2b. the document carries its title, not its id', headerTitle === TITLE, headerTitle);

await ada.page.click('.cm-content');
await ada.page.keyboard.type('owner writing here', { delay: 10 });
await sleep(900);

// ---- 3. an unshared document is refused ------------------------------------
await bob.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
// Refusing a socket is four Postgres round trips before the server can decide
// (session, tab, document, permission). Measured from a development machine to
// a database in another region that is ~1.1s, and the dialog only appears once
// the close code comes back -- so 2.5s was close enough to the answer to fail
// intermittently. The check is that a stranger IS refused, not how quickly.
await present(bob.page, '.modal[role=alertdialog]', { timeout: 20_000 });
const refused = await bob.page.$('.modal[role=alertdialog]');
check('3. a stranger opening the link is refused, not left retrying', !!refused,
  refused ? await bob.page.$eval('.modal[role=alertdialog] .history-note', (e) => e.textContent) : 'no dialog');

// ---- 4. share as viewer -----------------------------------------------------
await ada.page.$$eval('.header-btn', (els) => els.find((e) => e.textContent.trim() === 'Share')?.click());
await ada.page.waitForSelector('.share-add');
await ada.page.type('.share-add input', BOB.email);
await ada.page.select('.share-add select', 'viewer');
await ada.page.$eval('.share-add button[type=submit]', (b) => b.click());
const listed = await allTextUntil(ada.page, '.share-list li', BOB.email);
check('4. the collaborator is listed', listed.includes(BOB.email), listed.slice(0, 120));
await ada.page.$$eval('.modal-head .icon-btn', (els) => els[0]?.click());

// ---- 5. the viewer's tab is genuinely read-only -----------------------------
await bob.page.goto(docUrl, { waitUntil: 'domcontentloaded' });
await bob.page.waitForSelector('.cm-content', { timeout: 20000 });

/*
 * Wait for the document to ARRIVE, not for a second and a half.
 *
 * `.cm-content` exists as soon as React mounts. The text and the role land
 * later, on the HELLO frame at the end of admitting the socket -- four
 * Postgres round trips plus the room's own load. A fixed sleep encodes the
 * latency of whichever link it was tuned against: 1800ms is generous locally
 * and loses the race to a database in another region, and when it loses, all
 * four assertions below report the read-only UI as broken when what actually
 * happened is that nothing had arrived yet.
 */
const bobText = await until(
  () => editorText(bob.page).catch(() => ''),
  (t) => t.includes('owner writing here'));
check('5. a viewer can read the document', bobText.includes('owner writing here'), JSON.stringify(bobText));

check('5b. the viewer sees a read-only notice', await present(bob.page, '.readonly-bar'));

/*
 * `EditorView.editable` is applied by an effect keyed on the role, so it can
 * be one tick behind the bar above rather than in the same paint -- which is
 * why this polls rather than reading once.
 */
const editable = await until(
  () => bob.page.$eval('.cm-content', (el) => el.getAttribute('contenteditable')).catch(() => null),
  (v) => v === 'false');
check('5d. the editor itself is not editable', editable === 'false', `contenteditable=${editable}`);

/*
 * Last, and with no wait of its own: an element that is ABSENT is not a
 * condition anything can poll for. It is safe here because the toolbar, the
 * bar and the editable flag all render from one `session.role`, so the two
 * waits above have already established the state this asserts.
 */
check('5c. the formatting toolbar is hidden from a viewer', !(await bob.page.$('.toolbar')));

await bob.page.click('.cm-content');
await bob.page.keyboard.type('VIEWER EDIT', { delay: 10 });
await sleep(1200);
const ownerText = await editorText(ada.page);
check('5e. nothing a viewer types reaches the owner',
  !ownerText.includes('VIEWER EDIT'), JSON.stringify(ownerText.slice(0, 60)));

// ---- 6. promote to editor ---------------------------------------------------
await ada.page.$$eval('.header-btn', (els) => els.find((e) => e.textContent.trim() === 'Share')?.click());
await ada.page.waitForSelector('.share-add');
await ada.page.$eval('.share-add input', (el) => { el.value = ''; });
await ada.page.type('.share-add input', BOB.email);
await ada.page.select('.share-add select', 'editor');
await ada.page.$eval('.share-add button[type=submit]', (b) => b.click());

/*
 * Wait for the GRANT, not for a second.
 *
 * The click fires a POST the test never awaited; a fixed sleep stood in for
 * it. That POST is now several Postgres round trips (write the ACL row, then
 * re-read every connected client's role), and it does not reliably finish in
 * the 1000ms this used to allow.
 *
 * Reloading early is not a slow test, it is a WRONG one: bob's new socket is
 * admitted against an ACL that still says viewer, so every keystroke he makes
 * is dropped by the server for lack of permission. It looks exactly like a
 * broken sync -- bob's own editor keeps the text, because it applied locally,
 * and nothing reaches the owner. The server now logs that drop (see
 * Room.handle), which is how this was found.
 *
 * Asked over the API rather than read off the share dialog, so the check does
 * not depend on how that list happens to render a role.
 */
await until(
  () => ada.page.evaluate(async (id) => {
    const res = await fetch(`http://localhost:8080/api/docs/${id}/share`, {
      headers: { authorization: `Bearer ${localStorage.getItem('collab.token')}` },
    });
    if (!res.ok) return '';
    const body = await res.json();
    return (body.collaborators ?? []).map((c) => `${c.user?.email}:${c.role}`).join(' | ');
  }, docId),
  (list) => list.includes(`${BOB.email}:editor`));

await ada.page.$$eval('.modal-head .icon-btn', (els) => els[0]?.click());

await bob.page.reload({ waitUntil: 'domcontentloaded' });
await bob.page.waitForSelector('.cm-content', { timeout: 20000 });
check('6. a promoted collaborator gets the toolbar back',
  await present(bob.page, '.toolbar'));

// The toolbar appearing means the ROLE arrived; it does not mean the document
// has. Pressing End and typing before the socket has synced appends to an
// empty replica, so wait for the owner's text to be there first.
await until(() => editorText(bob.page), (t) => t.includes('owner writing here'));
await bob.page.click('.cm-content');
await bob.page.keyboard.press('End');
await bob.page.keyboard.type(' plus bob', { delay: 12 });
const afterBob = await until(() => editorText(ada.page), (t) => t.includes('plus bob'));
// Report BOTH sides. A propagation check that only prints the receiver cannot
// distinguish "the edit did not travel" from "the edit was never made", and
// those have completely different causes.
const bobOwn = await editorText(bob.page);
check('6b. an editor edit reaches the owner live', afterBob.includes('plus bob'),
  `owner=${JSON.stringify(afterBob.slice(0, 60))} editor=${JSON.stringify(bobOwn.slice(0, 60))}`);

// ---- 7. version history -----------------------------------------------------
await ada.page.$$eval('.header-btn', (els) => els.find((e) => e.textContent.trim() === 'History')?.click());
await ada.page.waitForSelector('.history-pane');
check('7. the history pane opens', !!(await ada.page.$('.history-pane')));

// Name the current state, then change the document.
ada.page.once('dialog', async (d) => { await d.accept('before the rewrite'); });
await ada.page.$$eval('.history-head .link-btn', (els) => els[0]?.click());
const labels = await allTextUntil(ada.page, '.history-label', 'before the rewrite');
check('7b. a named version appears in the list', labels.includes('before the rewrite'), labels.slice(0, 120));

await ada.page.click('.cm-content');
await ada.page.keyboard.down('Control');
await ada.page.keyboard.press('KeyA');
await ada.page.keyboard.up('Control');
await ada.page.keyboard.type('completely different text', { delay: 10 });
await sleep(1500);

// Select the named version and preview it.
await ada.page.$$eval('.history-item-main', (els) => {
  els.find((e) => e.textContent.includes('before the rewrite'))?.click();
});
const previewed = await textUntil(ada.page, '.history-preview-body',
  (t) => t && !t.includes('Loading'));
check('7c. an old version can be previewed without changing the document',
  previewed.includes('owner writing here'), JSON.stringify(previewed.slice(0, 60)));
const liveNow = await editorText(ada.page);
check('7d. previewing left the live document alone',
  liveNow.includes('completely different text'), JSON.stringify(liveNow.slice(0, 60)));

// Restore it, and confirm the OTHER person's tab updates without reloading.
await ada.page.$eval('.history-preview-head .primary-btn', (b) => b.click());
const restored = await until(() => editorText(ada.page),
  (t) => t.includes('owner writing here'));
check('7e. restore brings the old text back', restored.includes('owner writing here'),
  JSON.stringify(restored.slice(0, 60)));
const bobSeesRestore = await until(() => editorText(bob.page),
  (t) => t.includes('owner writing here'));
check('7f. a collaborator sees the restore live, without reloading',
  bobSeesRestore.includes('owner writing here'), JSON.stringify(bobSeesRestore.slice(0, 60)));

// ---- 8. the document list ---------------------------------------------------
await ada.page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
// The listing is a read of Postgres, so it answers when the database does --
// the same reason nothing else here sleeps at a number.
const adaSees = await until(
  () => ada.page.evaluate(async () => {
    const res = await fetch('http://localhost:8080/api/docs', {
      headers: { authorization: 'Bearer ' + localStorage.getItem('collab.token') },
    });
    return (await res.json()).docs.map((d) => d.title);
  }).catch(() => []),
  (titles) => titles.includes(TITLE));
check('8. the owner sees their titled document in the list', adaSees.includes(TITLE),
  adaSees.slice(0, 4).join(', '));

check('9. no page errors', errors.length === 0, errors.slice(0, 3).join(' ;; '));

if (HEADFUL) { console.log('\n  (headful: leaving the browser open for 20s)'); await sleep(20000); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
