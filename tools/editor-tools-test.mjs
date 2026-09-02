/**
 * Word count, find & replace, and export -- through the real UI.
 *
 * The one worth driving a browser for is REPLACE ALL. It dispatches ordinary
 * CodeMirror changes, which means they travel out through the sync layer like
 * any other edit; if that binding were wrong, a replace would change the local
 * document and reach nobody. So the check is not "the text changed here", it is
 * "the text changed in the OTHER tab".
 *
 *   node tools/editor-tools-test.mjs            (needs: npm run dev)
 *   node tools/editor-tools-test.mjs --headful
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

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

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 150_000);
guard.unref?.();

const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-export-'));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const docId = 'tools-ui-' + Date.now();
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
  return page;
}

const status = (page) => page.$eval('.statusbar-main', (e) => e.textContent.replace(/\s+/g, ' ').trim());
const text = (page) => page.evaluate(() => window.__sync.getText());

console.log('\nWord count, find & replace, export\n');

const alice = await openTab('alice');
await alice.click('.cm-content');
await alice.keyboard.type('one two three four five');
await sleep(500);

// ---- word count -------------------------------------------------------------
check('1. words are counted', (await status(alice)).startsWith('5 words'), await status(alice));
check('1b. characters too', (await status(alice)).includes('23 characters'), await status(alice));

await alice.keyboard.down('Control');
await alice.keyboard.press('a');
await alice.keyboard.up('Control');
await sleep(250);
check('2. a selection is counted separately',
  (await status(alice)).includes('of 5 words selected'), await status(alice));

// An empty document must say 0, not 1 -- the classic split() bug.
await alice.keyboard.press('Backspace');
await sleep(400);
check('3. an empty document has no words',
  (await status(alice)).startsWith('0 words'), await status(alice));

await alice.keyboard.type('alpha beta alpha gamma alpha');
await sleep(500);

// ---- find & replace ---------------------------------------------------------
const bob = await openTab('bob');
await sleep(900);

// `page.click` computes a clickable point and scrolls to it; on a tall
// document whose centre sits under a panel that can wait indefinitely.
// Focusing the contenteditable directly is what the keystroke actually needs.
await alice.evaluate(() => document.querySelector('.cm-content').focus());
await alice.keyboard.down('Control');
await alice.keyboard.press('f');
await alice.keyboard.up('Control');
await alice.waitForSelector('.cm-search', { timeout: 5_000 });
check('4. Ctrl+F opens the search panel', true);

await alice.type('.cm-search input[name="search"]', 'alpha');
await sleep(400);
const matches = await alice.$$eval('.cm-searchMatch', (els) => els.length);
check('4b. matches are highlighted', matches >= 2, `${matches} highlighted`);

await alice.type('.cm-search input[name="replace"]', 'delta');
await alice.evaluate(() => [...document.querySelectorAll('.cm-search button')]
  .find((b) => /replace all/i.test(b.textContent))?.click());
await sleep(900);

check('5. replace all rewrites the document',
  (await text(alice)) === 'delta beta delta gamma delta', JSON.stringify(await text(alice)));

// The real assertion: it went over the wire like any other edit.
check('5b. and the other client receives it',
  (await text(bob)) === 'delta beta delta gamma delta', JSON.stringify(await text(bob)));

await alice.keyboard.press('Escape');

// ---- export -----------------------------------------------------------------
const client = await alice.createCDPSession();
await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

await alice.evaluate(() => [...document.querySelectorAll('.header-btn')]
  .find((b) => b.textContent.trim() === 'Export')?.click());
await sleep(1200);

const files = fs.readdirSync(downloads).filter((f) => f.endsWith('.md'));
check('6. Export writes a .md file', files.length === 1, files.join(', '));
if (files.length) {
  const body = fs.readFileSync(path.join(downloads, files[0]), 'utf8');
  check('6b. and it contains the document',
    body.includes('delta beta delta gamma delta'), JSON.stringify(body.slice(0, 80)));
}

// A document with formatting Markdown cannot carry must SAY so.
await alice.evaluate(() => document.querySelector('.cm-content').focus());
await alice.evaluate(() => window.__sync.format(0, window.__sync.getText().length, { size: 36 }));
await sleep(600);
await alice.evaluate(() => [...document.querySelectorAll('.header-btn')]
  .find((b) => b.textContent.trim() === 'Export')?.click());
await alice.waitForSelector('.toast-note', { timeout: 5_000 });
const note = await alice.$eval('.toast-note', (e) => e.textContent);
check('7. lossy formatting is reported rather than dropped silently',
  note.includes('size'), JSON.stringify(note));

check('8. no page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await browser.close();
fs.rmSync(downloads, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
