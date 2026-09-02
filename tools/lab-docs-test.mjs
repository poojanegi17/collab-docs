/**
 * The lab pointed at a real document, and the framing that says what it is.
 *
 * Two things are being checked, and the second is the one that keeps coming
 * back as a misunderstanding rather than a bug:
 *
 *   1. A signed-in person can load one of THEIR documents into the lab. That
 *      needs the lab to authenticate: without a token it could only open
 *      unowned documents, which is exactly the set nobody wants to watch
 *      converge.
 *
 *   2. The panes are replicas of ONE document, not several documents. Every
 *      pane is built with the same docId, but a header reading only "alice"
 *      and "bob" would look like two files -- so this asserts the interface
 *      says what the code does.
 *
 *   node tools/lab-docs-test.mjs [--headful]
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

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

const stamp = Date.now();
const WHO = { email: `lab-${stamp}@example.com`, name: 'Ada', password: 'lovelace1' };
const TITLE = `Lab subject ${stamp}`;
const CONTENT = `written before the lab opened ${stamp}`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: HEADFUL ? false : 'new', args: ['--no-sandbox'],
});
const errors = [];
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
await page.setViewport({ width: 1400, height: 900 });

console.log('\nThe lab, on a real document\n');

// ---- sign up and write a document -------------------------------------------
await page.goto(BASE + '/docs', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.account-btn', { timeout: 15000 });
await page.click('.account-btn');
await page.waitForSelector('.account-form');
await page.$$eval('.account-tabs button',
  (els) => els.find((e) => e.textContent.includes('Create account'))?.click());
await sleep(200);
const inputs = await page.$$('.account-form input');
await inputs[0].type(WHO.email);
await inputs[1].type(WHO.name);
await inputs[2].type(WHO.password);
await page.$eval('.account-form button[type=submit]', (b) => b.click());
await page.waitForSelector('.account-chip', { timeout: 15000 });
await sleep(600);

await page.click('.docs-search input');
await page.type('.docs-search input', TITLE);
await sleep(250);
await page.evaluate(() => document.querySelector('.docs-section-head .primary-btn').click());
await page.waitForSelector('.cm-content', { timeout: 20000 });
// Synced, not merely mounted. Admitting a socket is four Postgres round trips
// plus the room's load, so `.cm-content` appears well before the connection is
// live -- and text typed into that gap never leaves the browser, which leaves
// the document with no indexed text and therefore absent from every listing.
await until(() => page.$eval('.status', (e) => e.innerText).catch(() => ''),
  (t) => t.includes('synced'), { timeout: 25_000 });
const docId = new URL(page.url()).searchParams.get('doc');
await page.click('.cm-content');
await page.keyboard.type(CONTENT, { delay: 6 });
await until(() => page.$eval('.status', (e) => e.innerText).catch(() => ''),
  (t) => t.includes('synced'), { timeout: 25_000 });
await sleep(900);

// ---- the picker offers it ----------------------------------------------------
await page.goto(BASE + '/lab', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lab-select', { timeout: 15000 });
// The picker lists documents that have indexed text (see listable.js), and
// indexing is debounced two seconds behind the last keystroke and then a round
// trip away. Reload until the document shows up rather than assuming 1.5s
// covers it -- the page fetches once, so waiting in place re-reads the same
// stale answer.
for (let attempt = 1; attempt <= 5; attempt++) {
  // Wait for the fetch this page load kicked off to land BEFORE deciding to
  // reload. Checking the options the instant `.lab-select` exists reads the
  // picker before its documents have arrived, and reloading on that answer
  // just starts the same race again -- the previous version of this loop also
  // never re-checked after its final reload, so it could only ever fail.
  const found = await until(
    () => page.$$eval('.nav-doc .lab-select option',
      (els, t) => els.some((e) => e.textContent.trim() === t), TITLE).catch(() => false),
    (v) => v === true, { timeout: 5000 });
  if (found) break;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lab-select', { timeout: 15000 }).catch(() => {});
}

// Scoped to the DOCUMENT picker. The lab has a second `.lab-select` for
// scripted runs, and an unscoped selector counted its options too -- which
// quietly turned the "not the unowned pile" ceiling below into a number that
// was measuring the wrong list.
const options = await page.$$eval('.nav-doc .lab-select option', (els) =>
  els.map((e) => ({ value: e.value, label: e.textContent.trim() })));
// Report what the picker is fed as well as what it shows. "scratch document"
// alone can mean the fetch returned nothing, that the session was not sent, or
// that the document is genuinely absent, and those have different causes.
const picker = await page.evaluate(async () => {
  const token = localStorage.getItem('collab.token');
  const res = await fetch('http://localhost:8080/api/docs',
    { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => ({}));
  return {
    token: !!token,
    status: res.status,
    owned: (body.docs ?? []).filter((d) => !d.unowned).map((d) => d.title),
  };
});
check('1. the lab offers your documents', options.some((o) => o.label === TITLE),
  `${options.slice(0, 4).map((o) => o.label).join(', ')}`
  + `  [token=${picker.token} api=${picker.status} owned=${JSON.stringify(picker.owned)}]`);
check('1b. and not the unowned harness pile',
  options.length < 12, `${options.length} options`);

// ---- opening one loads it into EVERY replica --------------------------------
await page.goto(`${BASE}/lab?doc=${encodeURIComponent(docId)}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane .cm-content', { timeout: 20000 });
await sleep(2800);

const paneTexts = await page.$$eval('.pane .cm-content', (els) => els.map((e) => {
  const clone = e.cloneNode(true);
  for (const c of clone.querySelectorAll('.cm-peer-caret')) c.remove();
  return clone.innerText.replace(/\u200b/g, '').trim();
}));
check('2. every replica loads the chosen document', paneTexts.length === 2
  && paneTexts.every((t) => t.includes(CONTENT)), JSON.stringify(paneTexts));
check('2b. the replicas agree', paneTexts[0] === paneTexts[1]);

// ---- the page says what it is -----------------------------------------------
// The lab reads the title from the same place the editor does, so it arrives
// with the document rather than with the page.
const title = (await until(
  () => page.$eval('.doc-title', (e) => e.textContent.trim()).catch(() => ''),
  (t) => t && t !== docId, { timeout: 20_000 }));
check('3. the header names the document, not its id', title === TITLE, title);

const subject = await page.$eval('.lab-subject', (e) => e.textContent.trim());
check('3b. and says it is one document in several replicas',
  /one document/.test(subject) && /replica/.test(subject), subject);

const kinds = await page.$$eval('.pane-kind', (els) => els.map((e) => e.textContent.trim()));
check('3c. each pane is labelled a replica', kinds.length === 2
  && kinds.every((k) => k.toLowerCase() === 'replica'), kinds.join(', '));

// ---- one account, several distinct replicas ---------------------------------
//
// Every pane authenticates as the same person. If the server collapsed them
// into one presence identity the panes would stop seeing each other as peers,
// and the whole page would show a single cursor.
const peers = await page.$$eval('.pane-meta', (els) =>
  els.map((e) => e.innerText.match(/(\d+) peers?/)?.[1] ?? '0'));
check('4. replicas of one account still see each other as peers',
  peers.every((n) => Number(n) >= 1), `peers per pane: ${peers.join(', ')}`);

await page.evaluate(() => document.querySelector('.pane .cm-content')?.focus());
await page.click('.pane .cm-content');
await page.keyboard.type(' plus a live edit', { delay: 8 });
await sleep(1600);
const after = await page.$$eval('.pane .cm-content', (els) => els.map((e) => {
  const clone = e.cloneNode(true);
  for (const c of clone.querySelectorAll('.cm-peer-caret')) c.remove();
  return clone.innerText.replace(/\u200b/g, '').trim();
}));
check('4b. an edit in one replica reaches the other',
  after[1].includes('plus a live edit'), JSON.stringify(after[1].slice(-40)));

check('5. no page errors', errors.length === 0, errors.slice(0, 3).join(' ;; '));

if (HEADFUL) { console.log('\n  (headful: 20s)'); await sleep(20000); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
