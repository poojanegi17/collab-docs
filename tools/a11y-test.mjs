/**
 * Accessibility, in real Chrome, across every route.
 *
 * This repository had thirty-odd harnesses and not one of them checked whether
 * the product could be used without a mouse or read without perfect eyesight.
 * ARIA attributes were scattered through fifteen components and
 * `prefers-reduced-motion` was respected, so the work was half done and
 * entirely unverified -- which by this project's own standard means it was
 * rotting. For a WORD PROCESSOR in particular, "can you reach every toolbar
 * control from the keyboard and find out what it does" is not a nice-to-have.
 *
 * No axe, no dependency. Everything here is computed from the live DOM and
 * CSSOM in the page, which is the same arrangement every other harness uses:
 * drive the real thing, assert on what it actually produced. It also means the
 * checks are readable -- when one fails you get the element that failed it,
 * not a rule id to go and look up.
 *
 * What it checks, and why each one earns its place:
 *
 *   names       a control with no accessible name is announced as "button",
 *               which is the screen-reader equivalent of an unlabelled key
 *   keyboard    every control must be reachable by Tab, and the toolbar is
 *               the hard case: it is a long row of icon buttons
 *   focus       reachable is useless if you cannot see where you are
 *   toggles     a button that has an on state must SAY it has an on state
 *   structure   one h1, no skipped heading levels, a main landmark
 *   contrast    4.5:1 for body text, 3:1 for large -- WCAG AA
 *
 *   node tools/a11y-test.mjs            (needs: npm run dev)
 *   node tools/a11y-test.mjs --headful
 */
import fs from 'node:fs';
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

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 240_000);
guard.unref?.();

/**
 * Everything that runs inside the page.
 *
 * One string injected once per page rather than a dozen `page.evaluate`
 * closures, so the helpers below can call each other -- `contrast` needs
 * `effectiveBackground`, which needs `visible`.
 */
const HELPERS = `
window.__a11y = (() => {
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const describe = (el) => {
    const id = el.id ? '#' + el.id : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + id + cls;
  };

  /**
   * The accessible name, near enough.
   *
   * Not a full AccName implementation -- that walks label elements, ARIA
   * inheritance and content generation. It covers the ways this codebase
   * actually names things, and the failure mode of getting it slightly wrong
   * is a false FAIL, which someone then reads. That is the safe direction.
   */
  const accessibleName = (el) => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '');
      if (parts.join(' ').trim()) return parts.join(' ').trim();
    }
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label.trim();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.labels && el.labels.length) {
        const t = [...el.labels].map((l) => l.textContent.trim()).join(' ').trim();
        if (t) return t;
      }
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
    }
    const text = (el.innerText || el.textContent || '').trim();
    if (text) return text;
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const img = el.querySelector('img[alt]');
    if (img && img.getAttribute('alt').trim()) return img.getAttribute('alt').trim();
    return '';
  };

  const parseColor = (s) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };

  /**
   * Source-over compositing, with the resulting alpha computed rather than
   * asserted.
   *
   * This used to hardcode \`a: 1\`, which is only correct when the lower layer
   * is already opaque. Two translucent layers -- a 6% code chip inside a 2%
   * panel, say -- composited to something the caller then believed was solid,
   * so \`effectiveBackground\` stopped walking and reported a near-black
   * backdrop for an element sitting on a light grey page. The result was a
   * confident 1.04:1 for text that is actually about 14:1.
   */
  const over = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };

  /**
   * Composite the backgrounds up the ancestor chain.
   *
   * Returns null when a gradient is involved. The landing mosaic's panels are
   * pastel gradients, and there is no single background colour to measure
   * against -- guessing one would produce confident numbers about a colour
   * that is not on screen anywhere. Reporting "cannot measure" is the honest
   * answer, and those elements are counted separately rather than silently
   * skipped.
   */
  const effectiveBackground = (el) => {
    let acc = null;
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parseColor(s.backgroundColor);
      if (!c || c.a === 0) continue;
      acc = acc ? over(acc, c) : c;
      if (acc.a >= 1) return acc;
    }
    // Ran out of ancestors still translucent: the canvas underneath is white.
    const white = { r: 255, g: 255, b: 255, a: 1 };
    return acc ? over(acc, white) : white;
  };

  const luminance = ({ r, g, b }) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };

  const contrast = (el) => {
    const s = getComputedStyle(el);
    const fg = parseColor(s.color);
    const bg = effectiveBackground(el);
    if (!fg || !bg) return null;
    const solid = fg.a < 1 ? over(fg, bg) : fg;
    const l1 = luminance(solid), l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;
    // WCAG "large text": 18.66px bold, or 24px at any weight.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    return { ratio, required: large ? 3 : 4.5, size, weight };
  };

  return { visible, describe, accessibleName, contrast, effectiveBackground };
})();
`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function open(url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(900);
  await page.evaluate(HELPERS);
  return page;
}

// ---- 1. every control is named ----------------------------------------------

console.log('\nAccessibility\n');

const docId = 'a11y-' + Date.now();
const ROUTES = [
  ['/', 'landing'],
  ['/docs', 'documents'],
  [`/doc?doc=${docId}&client=ada`, 'editor'],
  ['/lab', 'lab'],
  ['/decisions', 'decisions'],
  ['/engines', 'engines'],
];

for (const [route, label] of ROUTES) {
  const page = await open(BASE + route);
  if (label === 'editor') await page.waitForSelector('.cm-content', { timeout: 15_000 });

  const unnamed = await page.evaluate(() => {
    const out = [];
    const controls = document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [role=button]');
    for (const el of controls) {
      if (!window.__a11y.visible(el)) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (!window.__a11y.accessibleName(el)) out.push(window.__a11y.describe(el));
    }
    return out;
  });
  check(`1. ${label}: every visible control has an accessible name`,
    unnamed.length === 0, unnamed.slice(0, 6).join(', '));

  // ---- 2. structure ---------------------------------------------------------

  const structure = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter((h) => window.__a11y.visible(h))
      .map((h) => Number(h.tagName[1]));
    const skips = [];
    for (let i = 1; i < heads.length; i++) {
      if (heads[i] > heads[i - 1] + 1) skips.push(`h${heads[i - 1]} -> h${heads[i]}`);
    }
    return {
      h1: heads.filter((n) => n === 1).length,
      skips,
      landmarks: document.querySelectorAll('main, [role=main]').length,
      lang: document.documentElement.getAttribute('lang') || '',
    };
  });
  check(`2. ${label}: exactly one h1`, structure.h1 === 1, `found ${structure.h1}`);
  check(`2b. ${label}: heading levels are not skipped`,
    structure.skips.length === 0, structure.skips.join(', '));
  check(`2c. ${label}: has a main landmark`, structure.landmarks >= 1);

  // ---- 3. images ------------------------------------------------------------

  const noAlt = await page.evaluate(() => [...document.querySelectorAll('img')]
    .filter((i) => window.__a11y.visible(i) && i.getAttribute('alt') === null)
    .map((i) => i.getAttribute('src')?.slice(0, 40) ?? '?'));
  check(`3. ${label}: every image has an alt attribute`,
    noAlt.length === 0, noAlt.join(', '));

  // ---- 4. contrast ----------------------------------------------------------
  //
  // Text nodes only, and only where a background can actually be determined.

  const contrast = await page.evaluate(() => {
    const bad = [];
    let measured = 0, unmeasurable = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || !window.__a11y.visible(el)) continue;
      seen.add(el);
      const c = window.__a11y.contrast(el);
      if (!c) { unmeasurable++; continue; }
      measured++;
      if (c.ratio < c.required) {
        bad.push(`${window.__a11y.describe(el)} ${c.ratio.toFixed(2)}:1 `
          + `(needs ${c.required}) "${n.textContent.trim().slice(0, 24)}"`);
      }
    }
    return { bad, measured, unmeasurable };
  });
  check(`4. ${label}: text meets WCAG AA contrast`,
    contrast.bad.length === 0,
    contrast.bad.length
      ? contrast.bad.slice(0, 4).join(' | ')
      : `${contrast.measured} elements measured, ${contrast.unmeasurable} over gradients`);

  await page.close();
}

// ---- 5. the toolbar, from the keyboard --------------------------------------
//
// The hard case, and the reason this file exists. The toolbar is a long row of
// icon buttons; if any of them is a div with an onClick, it is invisible to
// Tab and unreachable without a mouse.

{
  const page = await open(`${BASE}/doc?doc=${docId}&client=ada`);
  await page.waitForSelector('.cm-content', { timeout: 15_000 });

  const toolbarCount = await page.evaluate(() =>
    document.querySelectorAll('.toolbar button, .toolbar select').length);
  check('5. the toolbar has controls to reach', toolbarCount > 10, `${toolbarCount} controls`);

  // Tab from the top of the document and collect what receives focus.
  await page.evaluate(() => {
    document.body.focus();
    if (document.activeElement !== document.body) document.activeElement.blur();
  });

  const reached = new Set();
  for (let i = 0; i < 90; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      return {
        inToolbar: !!el.closest('.toolbar'),
        name: window.__a11y.accessibleName(el),
        tag: el.tagName.toLowerCase(),
      };
    });
    if (info?.inToolbar && info.name) reached.add(info.name);
    // Stop once we are into the editor surface, which is past the toolbar.
    const inEditor = await page.evaluate(() =>
      !!document.activeElement?.closest?.('.cm-editor'));
    if (inEditor && reached.size) break;
  }

  check('5b. Tab reaches the toolbar controls',
    reached.size >= Math.min(10, toolbarCount),
    `${reached.size} of ${toolbarCount} reached`);

  // ---- 6. focus is visible --------------------------------------------------

  const focusVisible = await page.evaluate(() => {
    const bad = [];
    const buttons = [...document.querySelectorAll('.toolbar button')]
      .filter((b) => window.__a11y.visible(b)).slice(0, 12);
    for (const b of buttons) {
      const before = getComputedStyle(b);
      const base = [before.outlineWidth, before.outlineStyle, before.boxShadow,
        before.backgroundColor, before.borderColor].join('|');
      b.focus();
      const after = getComputedStyle(b);
      const focused = [after.outlineWidth, after.outlineStyle, after.boxShadow,
        after.backgroundColor, after.borderColor].join('|');
      if (base === focused) bad.push(window.__a11y.describe(b));
      b.blur();
    }
    return bad;
  });
  check('6. a focused toolbar button looks different from an unfocused one',
    focusVisible.length === 0, focusVisible.slice(0, 4).join(', '));

  // ---- 7. toggles announce their state --------------------------------------
  //
  // Header buttons that turn a panel on and off. Without aria-pressed a screen
  // reader announces "Comments, button" whether the pane is open or shut --
  // the button works and there is no way to know what it did.

  const toggles = await page.evaluate(() => {
    const out = { withState: [], without: [] };
    for (const b of document.querySelectorAll('.header-btn, .icon-btn')) {
      if (!window.__a11y.visible(b)) continue;
      const name = window.__a11y.accessibleName(b);
      // A toggle is a button this app gives an "on" class to. Anything that
      // can be on must be able to say so.
      const togglable = b.className.includes('on') || b.hasAttribute('aria-pressed');
      if (!togglable) continue;
      (b.hasAttribute('aria-pressed') ? out.withState : out.without).push(name);
    }
    return out;
  });
  check('7. every toggle button exposes aria-pressed',
    toggles.without.length === 0,
    toggles.without.length ? toggles.without.join(', ')
      : `${toggles.withState.length} toggles checked`);

  // ---- 8. the editor surface itself -----------------------------------------

  const editor = await page.evaluate(() => {
    const cm = document.querySelector('.cm-content');
    return {
      role: cm?.getAttribute('role') ?? '',
      label: cm ? window.__a11y.accessibleName(cm) : '',
      tabindex: cm?.getAttribute('tabindex') ?? '',
    };
  });
  check('8. the editing surface is reachable and announced as a textbox',
    editor.role === 'textbox' && editor.tabindex !== '-1',
    JSON.stringify(editor));

  await page.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
