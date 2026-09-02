/**
 * Responsive checks for the landing mosaic, across real device viewports.
 *
 *   node tools/responsive-test.mjs [--headful]
 *
 * The mosaic scales one fixed composition with a root font-size knob, which
 * means a layout that "fits" can still be unreadable. So this asserts three
 * separate things per viewport: nothing overflows sideways, nothing is clipped
 * by its own card, and body text stays above a legibility floor.
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every rendered character on the landing page must clear this.
 *
 * No exception list. Every entry on one would be a small licence to ship type
 * nobody can read, so labels that fall under the floor are sized up instead
 * and the assertion below is the whole policy.
 */
const MIN_BODY_PX = 8;

const VIEWPORTS = [
  { name: 'iphone-se', w: 375, h: 667, mobile: true, layout: 'stacked' },
  { name: 'iphone-14', w: 390, h: 844, mobile: true, layout: 'stacked' },
  { name: 'pixel-7', w: 412, h: 915, mobile: true, layout: 'stacked' },
  { name: 'phone-landscape', w: 844, h: 390, mobile: true, layout: 'stacked' },
  { name: 'ipad-mini', w: 744, h: 1133, mobile: true, layout: 'tablet' },
  { name: 'ipad-pro', w: 1024, h: 1366, mobile: true, layout: 'tablet' },
  { name: 'laptop', w: 1280, h: 720, mobile: false, layout: 'desktop' },
  { name: 'desktop', w: 1512, h: 820, mobile: false, layout: 'desktop' },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 150_000);
guard.unref?.();

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

console.log('\nResponsive landing\n');

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({
    width: vp.w, height: vp.h, deviceScaleFactor: 1,
    isMobile: vp.mobile, hasTouch: vp.mobile,
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stage', { timeout: 15_000 });
  await page.waitForFunction(() => {
    const c = document.documentElement.classList;
    return !c.contains('motion-pending') && !c.contains('entrance-run');
  }, { timeout: 10_000 }).catch(() => {});

  /*
   * Sample the page in its WORST state, deterministically.
   *
   * The hero's live demo runs a ~10.4s loop and the "offline" badge exists only
   * between the partition and the heal -- a bit under half of it. The smallest
   * type on the page therefore depended on where the animation happened to be
   * when the harness looked, so a legibility regression failed on three
   * viewports one run and five the next. Waiting for the badge makes every run
   * measure the same page.
   */
  await page.waitForSelector('.demo-badge', { timeout: 12_000 })
    .catch(() => console.log('  (note: the demo badge never appeared)'));
  await sleep(250);

  const m = await page.evaluate((minPx) => {
    const doc = document.documentElement;
    const stage = document.querySelector('.stage').getBoundingClientRect();

    // Horizontally clipped by its own card. Bottom overflow is excluded:
    // panels are allowed to bleed off the card edge vertically by design.
    const clipped = [];
    for (const card of document.querySelectorAll('.card')) {
      const cb = card.getBoundingClientRect();
      for (const el of card.querySelectorAll('.tag,.bar-search,.hood-proof b,.feat b,.feat-note,.demo-cut,.demo-verdict,h2,.sub,.go,.chart')) {
        const r = el.getBoundingClientRect();
        if (r.right > cb.right + 1 || r.left < cb.left - 1) {
          clipped.push(`${el.className.split(' ')[0] || el.tagName}"${(el.innerText || '').trim().slice(0, 14)}"`);
        }
      }
    }

    // Smallest rendered text anywhere on the page. No exemptions.
    let smallest = { px: Infinity, what: '' };
    for (const el of document.querySelectorAll('.mosaic-page *')) {
      if (!el.textContent.trim() || el.children.length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < smallest.px) smallest = { px, what: el.textContent.trim().slice(0, 16) };
    }

    // Does the placeholder fit the field it is in?
    const input = document.querySelector('.bar-search input');
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
    probe.style.font = getComputedStyle(input).font;
    probe.textContent = input.placeholder;
    document.body.appendChild(probe);
    const phOverflow = Math.round(probe.getBoundingClientRect().width - input.getBoundingClientRect().width);
    probe.remove();

    return {
      hOverflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
      cards: document.querySelectorAll('.card').length,
      stacked: stage.width < stage.height,
      clipped: [...new Set(clipped)],
      smallest,
      phOverflow,
      placeholder: input.placeholder,
      minPx,
    };
  }, MIN_BODY_PX);

  console.log(`\n  ${vp.name}  ${vp.w}x${vp.h}  (${vp.layout})`);
  check(`${vp.name}: no horizontal page overflow`, m.hOverflow === 0, `${m.hOverflow}px`);
  check(`${vp.name}: all five panels render`, m.cards === 5, `${m.cards}`);
  check(`${vp.name}: nothing clipped by its card`, m.clipped.length === 0, m.clipped.join(', '));
  check(`${vp.name}: body text stays legible`, m.smallest.px >= MIN_BODY_PX,
    `${m.smallest.px.toFixed(1)}px on "${m.smallest.what}"`);
  check(`${vp.name}: placeholder fits the field`, m.phOverflow <= 0,
    `"${m.placeholder}" ${m.phOverflow}px`);
  if (vp.layout === 'stacked') {
    check(`${vp.name}: uses the stacked layout`, m.stacked, `stage ${m.stacked ? 'tall' : 'wide'}`);
  }
  check(`${vp.name}: no page errors`, errors.length === 0, errors.slice(0, 1).join(''));

  if (process.env.OUT_DIR) {
    await page.screenshot({ path: `${process.env.OUT_DIR}/vp-${vp.name}.png`, fullPage: true });
  }
  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
