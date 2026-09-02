/**
 * Pages -- through the real UI.
 *
 * `pagination.js` decides where the text breaks by MEASURING the rendered
 * document, so there is nothing to unit test: the whole feature is geometry
 * that only exists once a browser has laid the text out. That makes this the
 * only place its two claims can be checked at all.
 *
 * The claims, and why each one is here rather than eyeballed:
 *
 *   whole pages    the document ends on a sheet edge. The first version ended
 *                  at the bottom of the last page's TEXT area, one margin
 *                  short, and the final sheet lost its bottom border -- which
 *                  looks like the page is still loading.
 *
 *   nothing straddles
 *                  no line sits across a page boundary. This is the entire
 *                  point of inserting breaks rather than only drawing sheets,
 *                  so if it regresses the feature is decoration.
 *
 *   it converges   the same document measured twice is the same height. The
 *                  measurement feeds back into the thing it measures -- a
 *                  break is a block in the height map -- and an early version
 *                  grew the document by a few pixels every time it was
 *                  measured. Scrolling to the bottom and back is what exposed
 *                  it, so that is what this does.
 *
 *   no dead scroll the scroll stops at the last sheet. A tall pad below it
 *                  would be empty desk that says "there is more" when there
 *                  is not.
 *
 *   not the lab    the lab tiles replicas of one document in one screen; a
 *                  Letter sheet inside a 300px pane would break every second
 *                  line. Pagination is the full-page editor only.
 *
 *   node tools/pagination-test.mjs            (needs: npm run dev)
 *   node tools/pagination-test.mjs --headful
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The page grid, restated from pagination.js.
 *
 * Deliberately NOT imported. The module is the thing under test, so taking its
 * numbers would make the test agree with it by construction -- a page height
 * changed by accident would move the sheets and the assertions together and
 * nothing would fail. These are the numbers the design calls for; if the two
 * ever disagree, that is the finding.
 */
const PAGE_HEIGHT = 1056;
const PAGE_GAP = 26;
const PAGE_MARGIN = 96;
const PERIOD = PAGE_HEIGHT + PAGE_GAP;
const TEXT_HEIGHT = PAGE_HEIGHT - PAGE_MARGIN * 2;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 150_000);
guard.unref?.();

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

const docId = 'pagination-' + Date.now();
await page.goto(`${BASE}/doc?doc=${docId}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.cm-content', { timeout: 15_000 });
await sleep(1200);

const height = () => page.evaluate(() => Math.round(window.__view.contentHeight));

// ---- 1. an empty document is exactly one sheet ------------------------------
await page.evaluate(() => {
  const v = window.__view;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: 'A short document that fits on one page.' } });
});
await sleep(2000);
const one = await height();
check('1. a short document is exactly one page', one === PAGE_HEIGHT, `${one}px, want ${PAGE_HEIGHT}`);

const oneScroll = await page.evaluate(() => {
  const sc = document.querySelector('.cm-scroller');
  return { scrollH: sc.scrollHeight, clientH: sc.clientHeight };
});
check('1b. and it scrolls no further than that page',
  oneScroll.scrollH <= PAGE_HEIGHT + PAGE_GAP + 2,
  `${oneScroll.scrollH}px of scroll for a ${PAGE_HEIGHT}px sheet`);

// ---- 2. a long document lands on the page grid ------------------------------
await page.evaluate(() => {
  const v = window.__view;
  const para = 'A paragraph of ordinary prose that wraps a few times so the pages fill up the way a real document would. ';
  const text = Array.from({ length: 30 }, (_, i) => `Section ${i + 1}. ` + para).join('\n\n');
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
});
await sleep(3000);

const tall = await height();
check('2. a long document ends on a sheet edge', tall % PERIOD === PAGE_HEIGHT,
  `${tall}px is ${tall % PERIOD} into the ${PERIOD}px period, want ${PAGE_HEIGHT}`);
check('2b. and it is more than one page', tall > PERIOD, `${Math.round(tall / PERIOD)} pages`);

// ---- 3. no line straddles a page boundary -----------------------------------
// Scrolled in steps, because CodeMirror only renders the viewport: a line that
// has never been drawn cannot be measured, and checking only the first screen
// would pass a document that breaks badly on page four.
const scrollH = await page.evaluate(() => document.querySelector('.cm-scroller').scrollHeight);
const seen = new Set();
let straddling = 0;
for (let top = 0; top < scrollH; top += 600) {
  await page.evaluate((y) => { document.querySelector('.cm-scroller').scrollTop = y; }, top);
  await sleep(220);
  const rows = await page.evaluate((geo) => {
    const { PERIOD, PAGE_MARGIN, TEXT_HEIGHT } = geo;
    const content = document.querySelector('.cm-content');
    const contentTop = content.getBoundingClientRect().top;
    const out = [];
    for (const line of content.querySelectorAll('.cm-line')) {
      const r = line.getBoundingClientRect();
      if (!r.height || !line.textContent.trim()) continue;
      const top = r.top - contentTop;
      const bottom = r.bottom - contentTop;
      const band = Math.floor(top / PERIOD) * PERIOD + PAGE_MARGIN;
      out.push({
        key: Math.round(top),
        ok: top >= band - 1 && bottom <= band + TEXT_HEIGHT + 1,
        text: line.textContent.slice(0, 30),
      });
    }
    return out;
  }, { PERIOD, PAGE_MARGIN, TEXT_HEIGHT });
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    if (!r.ok) straddling++;
  }
}
check('3. no line sits across a page edge', straddling === 0,
  `${seen.size} lines checked, ${straddling} straddling`);

// ---- 4. measuring does not move the pages -----------------------------------
// The regression this exists for: the trailing pad was attributed to the wrong
// block, so every measurement made the document a little taller.
await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; });
await sleep(900);
const again = await height();
check('4. the height is the same after scrolling the whole document and back',
  again === tall, `${tall}px -> ${again}px`);

// ---- 5. no dead scroll below the last sheet ---------------------------------
const overshoot = await page.evaluate(() => document.querySelector('.cm-scroller').scrollHeight)
  - again;
check('5. scrolling stops at the last sheet', overshoot <= PAGE_GAP + 2,
  `${overshoot}px past it, one gap is ${PAGE_GAP}`);

// ---- 6. the lab is not paginated --------------------------------------------
const lab = await browser.newPage();
await lab.setViewport({ width: 1440, height: 900 });
lab.on('pageerror', (e) => errors.push('[lab] ' + e.message.split('\n')[0]));
await lab.goto(`${BASE}/lab`, { waitUntil: 'domcontentloaded' });
await lab.waitForSelector('.cm-content', { timeout: 15_000 });
await sleep(2500);
const labCounts = await lab.evaluate(() => ({
  compact: document.querySelectorAll('.editor-compact').length,
  paged: document.querySelectorAll('.editor-paged').length,
  breaks: document.querySelectorAll('.cm-page-break').length,
}));
check('6. the lab mounts compact editors, not paged ones',
  labCounts.compact > 0 && labCounts.paged === 0 && labCounts.breaks === 0,
  JSON.stringify(labCounts));

check('7. no page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

fs.writeSync(1, String.fromCharCode(10) + `  ${pass} passed, ${fail} failed` + String.fromCharCode(10));
await browser.close();
clearTimeout(guard);
process.exit(fail ? 1 : 0);
