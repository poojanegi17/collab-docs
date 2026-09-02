/**
 * Responsive checks for the APP surfaces, across real device viewports.
 *
 * The sibling of `responsive-test.mjs`, which covers the landing mosaic. That
 * page scales one fixed composition; these are real layouts with real content,
 * and they fail differently -- by overflowing sideways, by a pane taking half a
 * phone screen, or by a control ending up too small to hit with a thumb.
 *
 * So this asserts four things per surface:
 *
 *   1. nothing overflows horizontally (the page must never scroll sideways)
 *   2. the document keeps a usable share of a narrow screen
 *   3. an opened side pane COVERS rather than splits, below 900px
 *   4. toolbar controls stay thumb-sized on a phone
 *
 *   node tools/app-responsive-test.mjs [--headful]   (needs: npm run dev)
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Apple's and Google's guidance agree on roughly this. */
const MIN_TOUCH_PX = 32;

const VIEWPORTS = [
  { name: 'iphone-se', w: 375, h: 667, phone: true },
  { name: 'iphone-14', w: 390, h: 844, phone: true },
  { name: 'pixel-7', w: 412, h: 915, phone: true },
  { name: 'phone-landscape', w: 844, h: 390, phone: false },
  { name: 'ipad-mini', w: 744, h: 1133, phone: false },
  { name: 'laptop', w: 1280, h: 720, phone: false },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const errors = [];
const docId = 'responsive-' + Date.now();

/** Does the page scroll sideways? The single most telling responsive failure. */
const overflows = (page) => page.evaluate(() =>
  document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

async function openPage(url, { w, h }) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

console.log('\nResponsive: editor and docs\n');

// Seed one document so the editor has something to lay out.
{
  const page = await openPage(`${BASE}/doc?doc=${docId}&client=seed`, { w: 1280, h: 800 });
  await page.waitForSelector('.cm-content');
  await page.evaluate(() => document.querySelector('.cm-content').focus());
  await page.keyboard.type('Responsive layout check. '.repeat(8));
  await sleep(700);
  await page.close();
}

for (const vp of VIEWPORTS) {
  console.log(`\n  ${vp.name}  ${vp.w}x${vp.h}`);

  // ---- the editor -----------------------------------------------------------
  {
    const page = await openPage(`${BASE}/doc?doc=${docId}&client=a`, vp);
    await page.waitForSelector('.cm-content');
    await sleep(700);

    check(`${vp.name}: editor does not scroll sideways`, !(await overflows(page)));

    // Not "is the editor wide enough" but "can you SEE it". Below 900px the
    // side panes are overlays, so a pane left open by default covers the
    // document completely -- which is what the inspector used to do, and what
    // a width measurement alone happily reports as fine.
    const covered = await page.evaluate(() => {
      const ed = document.querySelector('.editor').getBoundingClientRect();
      const mid = { x: ed.left + ed.width / 2, y: ed.top + Math.min(80, ed.height / 2) };
      const top = document.elementFromPoint(mid.x, mid.y);
      return !!top?.closest('.inspector, .comments-pane, .history-pane');
    });
    check(`${vp.name}: the document is visible on load`, !covered,
      covered ? 'a pane is covering it' : '');

    const share = await page.evaluate(() => {
      const ed = document.querySelector('.editor');
      return ed ? ed.getBoundingClientRect().width / window.innerWidth : 0;
    });
    check(`${vp.name}: the document keeps the screen`, share > 0.55,
      `${Math.round(share * 100)}% of the width`);

    if (vp.phone) {
      const small = await page.evaluate((min) => [...document.querySelectorAll('.fmt-btn')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width < min || r.height < min).length, MIN_TOUCH_PX);
      check(`${vp.name}: toolbar controls are thumb-sized`, small === 0,
        `${small} below ${MIN_TOUCH_PX}px`);

      // The toolbar must scroll sideways rather than stack into several rows.
      //
      // Measured by HEIGHT, not by counting distinct child offsets: buttons in
      // one row legitimately sit at slightly different tops depending on their
      // own height and alignment, so counting tops reports three "rows" for a
      // toolbar that is plainly one.
      const toolbar = await page.evaluate(() => {
        const tb = document.querySelector('.toolbar');
        if (!tb) return null;
        const tallest = Math.max(...[...tb.children]
          .filter((c) => c.offsetParent !== null)
          .map((c) => c.getBoundingClientRect().height));
        return { height: tb.clientHeight, tallest, scrolls: tb.scrollWidth > tb.clientWidth + 1 };
      });
      check(`${vp.name}: the toolbar stays one row`,
        toolbar && toolbar.height < toolbar.tallest * 1.8,
        `${Math.round(toolbar.height)}px tall, tallest control ${Math.round(toolbar.tallest)}px`);
      check(`${vp.name}: and scrolls instead of wrapping`, toolbar && toolbar.scrolls);
    }

    // ---- an opened pane -------------------------------------------------------
    await page.evaluate(() => [...document.querySelectorAll('.header-btn')]
      .find((b) => b.textContent.trim().startsWith('Comments'))?.click());
    await page.waitForSelector('.comments-pane', { timeout: 5000 });
    await sleep(400);

    check(`${vp.name}: opening comments does not cause overflow`, !(await overflows(page)));

    const layout = await page.evaluate(() => {
      const pane = document.querySelector('.comments-pane');
      const ed = document.querySelector('.editor');
      return {
        overlay: getComputedStyle(pane).position === 'absolute',
        editorWidth: ed.getBoundingClientRect().width,
        vw: window.innerWidth,
      };
    });

    if (vp.w <= 900) {
      check(`${vp.name}: the pane covers rather than splits`, layout.overlay,
        layout.overlay ? '' : 'it is still taking a column');
      check(`${vp.name}: the document keeps its width underneath`,
        layout.editorWidth / layout.vw > 0.55,
        `${Math.round(layout.editorWidth / layout.vw * 100)}%`);
      check(`${vp.name}: and the pane can be closed from inside it`,
        (await page.$('.pane-close')) !== null);
    } else {
      check(`${vp.name}: on a wide screen the pane takes its own column`,
        !layout.overlay);
    }

    await page.close();
  }

  // ---- the documents page ---------------------------------------------------
  {
    const page = await openPage(`${BASE}/docs`, vp);
    await page.waitForSelector('.docs-main, .docs-hero');
    await sleep(400);
    check(`${vp.name}: /docs does not scroll sideways`, !(await overflows(page)));
    await page.close();
  }
}

check('no page errors at any viewport', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
