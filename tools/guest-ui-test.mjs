/**
 * The guest journey, driven through the real UI.
 *
 * `guest-flow-test.mjs` proves the server implements "anyone may write, only an
 * account may share". This proves a person can walk it: arrive with no account,
 * make a document, format it, and then hit the sign-in wall at exactly one
 * place -- Share -- with the way through offered in the dialog itself rather
 * than as a redirect to a login page.
 *
 * Needs the dev servers up (`npm run dev`), like the other browser harnesses.
 *
 *   node tools/guest-ui-test.mjs [--headful]
 */
import puppeteer from 'puppeteer-core';
import { present, until, textUntil, titleAfterHello } from './ui-wait.mjs';

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

const editorText = (page) => page.$eval('.cm-content', (el) => {
  const clone = el.cloneNode(true);
  for (const caret of clone.querySelectorAll('.cm-peer-caret')) caret.remove();
  return clone.innerText.replace(/\u200b/g, '').trim();
});

const modalText = (page) => page.$eval('.modal', (el) => el.innerText);

/** The dialog's explanatory paragraph -- what the reader is actually told. */
const modalNote = (page) =>
  page.$eval('.modal .history-note', (el) => el.innerText.replace(/\s+/g, ' ').trim())
    .catch(() => '(no note)');

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

const stamp = Date.now();
const CARY = { email: `cary-${stamp}@example.com`, name: 'Cary', password: 'password1' };

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADFUL ? false : 'new',
  args: ['--no-sandbox'],
});

const errors = [];
// A fresh context, so localStorage is empty: this really is somebody who has
// never been here and is not signed in to anything.
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });
page.on('pageerror', (e) => errors.push(e.message));

console.log('\nThe guest journey, through the UI\n');

// ---- 1. create a document with no account -----------------------------------

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.bar-search input', { timeout: 20000 });
await sleep(600);

check('1. signed out, the landing page shows a Sign in button (not a chip)',
  (await page.$('.account-btn')) !== null && (await page.$('.account-chip')) === null);

const newBtn = await page.$('.intro-new');
check('1b. and offers + New document WITHOUT asking to sign in first', newBtn !== null);

await page.type('.bar-search input', 'Guest notes');
await sleep(300);
await newBtn.click();
await page.waitForSelector('.cm-content', { timeout: 20000 });
await sleep(1500);

const url = new URL(page.url());
const docId = url.searchParams.get('doc');
check('1c. it opens a real document with a slug id, not the raw typed string',
  /^guest-notes-[0-9a-f]{8}$/.test(docId ?? ''), docId);
const guestTitle = await titleAfterHello(page, docId);
check('1d. carrying the title that was typed', guestTitle === 'Guest notes', guestTitle);

// ---- 2. a guest gets the full editor ----------------------------------------

await page.click('.cm-content');
await page.keyboard.type('groceries and thoughts', { delay: 12 });
await sleep(800);
check('2. a guest can type in it', (await editorText(page)).includes('groceries and thoughts'));

check('2b. the toolbar is present for a guest', (await page.$('.toolbar')) !== null);
check('2c. including the paragraph-style dropdown', (await page.$('.fmt-select')) !== null);

// Bold via the KEYBOARD, which is the half a toolbar-only test never covers.
await page.keyboard.down('Control');
await page.keyboard.press('Home');
await page.keyboard.up('Control');
await page.keyboard.down('Shift');
for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
await page.keyboard.up('Shift');
await page.keyboard.down('Control');
await page.keyboard.press('KeyB');
await page.keyboard.up('Control');
await sleep(900);
const bold = await page.$$eval('.cm-fmt-bold', (els) => els.map((e) => e.textContent).join('|'));
check('2d. Ctrl+B bolds the selection', bold.includes('groceries'), JSON.stringify(bold));

// Heading through the new dropdown.
await page.select('.fmt-select', '2');
await sleep(900);
check('2e. the style dropdown applies a heading',
  (await page.$$eval('.cm-fmt-header-2', (els) => els.length)) > 0);

// Undo is the CRDT's own (Y.UndoManager), not CodeMirror's history -- the
// editor mounts one or the other, never both, or the button and the shortcut
// walk two different stacks. Both are exercised here for that reason.
const undoTitle = await page.$$eval('.fmt-btn',
  (els) => els.map((e) => e.getAttribute('title')).filter((t) => t?.startsWith('Undo')));
check('2f. the toolbar offers Undo under the CRDT', undoTitle.length === 1, undoTitle.join());

await page.click('.cm-content');
await page.keyboard.down('Control');
await page.keyboard.press('End');
await page.keyboard.up('Control');
await page.keyboard.type(' REGRETTABLE', { delay: 12 });
await sleep(900);
check('2g. the typed text is there before undoing',
  (await editorText(page)).includes('REGRETTABLE'));

await page.keyboard.down('Control');
await page.keyboard.press('KeyZ');
await page.keyboard.up('Control');
await sleep(1000);
check('2h. Ctrl+Z undoes it',
  !(await editorText(page)).includes('REGRETTABLE'), await editorText(page));

await page.$$eval('.fmt-btn', (els) => {
  els.find((e) => e.getAttribute('title')?.startsWith('Redo'))?.click();
});
await sleep(1000);
check('2i. and the toolbar Redo button walks the SAME stack, not a second one',
  (await editorText(page)).includes('REGRETTABLE'), await editorText(page));

// Leave the document as it was, so the later assertions read cleanly.
await page.$$eval('.fmt-btn', (els) => {
  els.find((e) => e.getAttribute('title')?.startsWith('Undo'))?.click();
});
await sleep(800);

// ---- 3. the sign-in wall is at Share, and nowhere else ----------------------

const shareBtn = await page.$$eval('.header-btn',
  (els) => els.some((e) => e.textContent.trim() === 'Share'));
check('3. the editor header offers Share to a guest', shareBtn);
check('3b. and a way to sign in without leaving the document',
  (await page.$('.header-account .account-btn')) !== null);

await page.$$eval('.header-btn', (els) => {
  els.find((e) => e.textContent.trim() === 'Share')?.click();
});
await page.waitForSelector('.modal', { timeout: 10000 });
await sleep(400);

const gate = await modalText(page);
check('3c. Share explains that sharing needs an account', /sign in/i.test(gate),
  (await modalNote(page)).slice(0, 80));
check('3d. and offers the sign-in form in place, not a redirect',
  (await page.$('.share-gate .account-form')) !== null);
check('3e. the share-by-email form is NOT offered yet',
  (await page.$('.share-add')) === null);

// ---- 4. sign in inside the dialog, claim, then share ------------------------

await page.$$eval('.account-tabs button', (els) => {
  els.find((e) => e.textContent.includes('Create account'))?.click();
});
await sleep(250);
const inputs = await page.$$('.share-gate .account-form input');
await inputs[0].type(CARY.email);
await inputs[1].type(CARY.name);
await inputs[2].type(CARY.password);
await page.$eval('.share-gate .account-form button[type=submit]', (b) => b.click());

// Creating the account, starting the session and re-reading what the dialog
// should now say are all round trips. Wait for the copy to become the claim
// offer rather than assuming 2.5s covers it.
const claimText = await until(() => modalText(page), (t) => /claim/i.test(t),
  { timeout: 20_000 });
check('4. signing in turns the dialog into a claim offer', /claim/i.test(claimText),
  (await modalNote(page)).slice(0, 80));

await page.$$eval('.modal .primary-btn', (els) => {
  els.find((e) => e.textContent.toLowerCase().includes('claim'))?.click();
});
// Claiming writes the owner row and re-reads every connected client's role,
// which is several Postgres round trips now. Wait for the dialog to become
// the share form rather than assuming 2.5s covers it.
await present(page, '.share-add', { timeout: 20_000 });

check('4b. after claiming, the share-by-email form appears',
  (await page.$('.share-add')) !== null);
check('4c. and the document still says what the guest wrote',
  (await editorText(page)).includes('groceries and thoughts'), await editorText(page));

// Share it with somebody who does not exist: the point is that the form is now
// live and the server is answering the real question, not a permissions one.
await page.type('.share-add input', `nobody-${stamp}@example.com`);
await page.$eval('.share-add button[type=submit]', (b) => b.click());
const shareErr = await textUntil(page, '.account-error', (t) => !!t);
check('4d. sharing now fails on the RECIPIENT, not on permission',
  /no account with that email/i.test(shareErr), shareErr);

await page.$eval('.modal .icon-btn', (b) => b.click());
await sleep(400);

// ---- 5. the claimed document is now listed as theirs ------------------------

await page.goto(BASE + '/docs', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.docs-section', { timeout: 20000 });
await sleep(1200);

/*
 * The documents page is one list with a scope selector, not a stack of
 * panels, so "what is under Your documents" means "pick that scope and read
 * the list". Returns null when the scope is not offered at all -- `On this
 * device` is dropped once it is empty, which is itself the thing 5b is about.
 */
const inScope = async (label) => {
  const picked = await page.evaluate((l) => {
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
  if (!picked) return null;
  // The rows are fetched, not rendered from memory. 300ms was a local read.
  await until(() => page.$$eval('.docs-row', (els) => els.length).catch(() => 0),
    (n) => n > 0, { timeout: 15_000 });
  return page.evaluate(() => [...document.querySelectorAll('.docs-row')]
    .map((r) => r.innerText.replace(/\n/g, ' | ')));
};

const yours = await inScope('Your documents');
check('5. the claimed document is listed under Your documents',
  (yours ?? []).some((r) => r.includes('Guest notes')),
  (yours ?? []).slice(0, 3).join(' ;; ') || '(none)');

// Claiming moves a document from "unowned, opened on this device" to "yours".
// Both are in the All scope, so if the claim left the on-device entry behind
// the document would appear in it twice. Once, exactly.
const all = await inScope('All');
const mine = (all ?? []).filter((r) => r.includes('Guest notes'));
check('5b. and appears exactly once under All',
  mine.length === 1, `${mine.length} row(s): ${mine.join(' ;; ') || '(none)'}`);

check('6. no page errors', errors.length === 0, errors.slice(0, 3).join(' ;; '));

if (HEADFUL) { console.log('\n  (headful: leaving the browser open for 20s)'); await sleep(20_000); }
await browser.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
