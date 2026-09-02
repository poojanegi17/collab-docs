/**
 * Photographs of the real editor, for the landing page's feature panel.
 *
 *   node tools/capture-shots.mjs            (needs: npm run dev)
 *   node tools/capture-shots.mjs --headful  watch it being driven
 *
 * Writes frontend/public/shots/*.webp.
 *
 * The panel these feed shows the surfaces rather than describing them. A spec
 * sheet is the wrong shape for an editor whose whole appeal is visual:
 * a description of a comments pane does not sell a comments pane.
 *
 * Every shot is the ACTUAL application, driven the way the UI harnesses drive
 * it: a real document over a real socket, real formatting applied through the
 * real toolbar, a real comment anchored to a real range. Nothing is mocked up,
 * for the same reason the page deleted a hardcoded "Converged." toast years of
 * commits ago -- a picture of a UI that does not exist is the most expensive
 * kind of decoration, because the one person who checks will be the one you
 * were trying to impress.
 *
 * WebP rather than PNG: these are screenshots of text, so JPEG artefacts show
 * up as fuzz around glyphs, and a PNG of the same crop is four times the size.
 * They are fetched by one route and they are the reason that route is worth
 * loading, but they are still 200 KB that the front page did not use to spend.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const OUT = join(root, 'frontend', 'public', 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Twice the size they render at, so they stay sharp on a 2x display. The panel
 * is ~299 design units wide, which is ~265 CSS px on a 1280 laptop.
 *
 * That number is also why the crops below are tight. The first pass framed
 * whole surfaces -- an 872px-wide toolbar scaled into a 265px box, where the
 * icons are three pixels across and the whole thing reads as grey noise. A
 * screenshot nobody can read is decoration with a file size.
 */
const SCALE = 2;

const docId = `shots-${Date.now()}`;

const BODY = [
  'Weekly sync — engineering',
  'Two people can hold this document open at the same time and neither waits.',
  'Every keystroke merges as it lands, so there is no locking and no save button.',
  'Comments anchor to the words rather than to an offset.',
  'They survive the edits around them.',
];

/** The last two lines become a bulleted list, so the shot shows more than prose. */
const BULLETS = 2;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
/*
 * A wide window, zoomed in.
 *
 * The panel renders these ~265px across, so what decides whether anybody can
 * read one is how much application is inside the crop -- not how many pixels
 * the crop has. Zooming the app makes every control physically larger, so a
 * 510px-wide crop holds proportionally less of it. The window is widened to
 * match, because the editor's own responsive layout collapses its side panes
 * into overlays below ~1100 effective pixels, and 1500/1.25 clears that.
 */
await page.setViewport({ width: 1500, height: 900, deviceScaleFactor: SCALE });
await page.goto(`${BASE}/doc?doc=${docId}&client=ada`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.cm-content', { timeout: 20_000 });
await sleep(900);

/** Type into the editor, one line per array entry. */
await page.click('.cm-content');
for (const [i, line] of BODY.entries()) {
  await page.keyboard.type(line, { delay: 4 });
  if (i < BODY.length - 1) await page.keyboard.press('Enter');
}
await sleep(400);

/**
 * Select a run of text: click at its first character, then extend with the
 * keyboard.
 *
 * Dragging from the left of the range's bounding box to its right is what the
 * comment harness does, and it is only correct while the phrase sits on one
 * line. Here it did not: the wider capture window re-wrapped the paragraph, a
 * multi-line range reports a box spanning the whole column, and the drag
 * selected three characters in the middle of it -- which the comment thread
 * then quoted, on the front page, as "anc".
 *
 * One click plus N keystrokes selects N characters wherever the line happens
 * to break.
 */
const selectText = async (needle) => {
  const at = await page.evaluate((w) => {
    const view = document.querySelector('.cm-content');
    const idx = view.textContent.indexOf(w);
    if (idx < 0) return null;
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let seen = 0, node;
    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (seen + len > idx) {
        const range = document.createRange();
        range.setStart(node, idx - seen);
        range.setEnd(node, idx - seen + 1);
        const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
        return { x: r.left + 1, y: r.top + r.height / 2 };
      }
      seen += len;
    }
    return null;
  }, needle);
  if (!at) throw new Error(`could not find "${needle}"`);

  await page.mouse.click(at.x, at.y);
  await sleep(120);
  await page.keyboard.down('Shift');
  for (let i = 0; i < needle.length; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await sleep(200);
};

/* Titles carry their keyboard shortcut -- "Bold  (Ctrl+B)" -- so this matches
   on the prefix rather than the whole string. */
const clickTitled = async (title) => {
  const ok = await page.evaluate((t) => {
    const el = document.querySelector(`[title^="${t}"]`);
    if (!el) return false;
    el.click();
    return true;
  }, title);
  if (!ok) throw new Error(`no control titled "${title}"`);
  await sleep(500);
};

/**
 * Crop to a union of elements plus a margin, in CSS pixels.
 *
 * Framed on what the shot is OF rather than on a fixed rectangle: the panel
 * shows these at about 300px wide, so a full 1280px window scaled down is a
 * grey smear with a hint of text in it.
 *
 * `height` caps it, because every one of these surfaces is a tall column in a
 * 860px window and none of them is interesting all the way down -- an
 * uncapped crop of the comments pane is a thread at the top and 600px of
 * empty sidebar under it. `focus` picks what stays in frame when the cap
 * bites: the crop is centred on that element rather than anchored to the top,
 * so a highlighted range does not fall out of its own screenshot.
 */
const ZOOM = 1.25;

const shot = async (name, selectors, { pad = 10, height = 300, focus = null, aspect = 0, widen = 'centre' } = {}) => {
  /*
   * Zoom for the photograph, then put it back.
   *
   * Applied for the whole session first, and that broke every mouse-driven
   * selection in the script: `getBoundingClientRect` reports zoomed layout
   * pixels while `page.mouse` moves in viewport pixels, so a drag across a
   * phrase grabbed the first three characters of it and the comment thread
   * ended up quoting "anc". Interactions run at 1; only the capture is zoomed.
   */
  await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, ZOOM);
  await sleep(260);

  const clip = await page.evaluate((sels, p, cap, focusSel, ratio, side) => {
    const boxes = sels.map((s) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`missing ${s}`);
      return el.getBoundingClientRect();
    });
    const x = Math.max(0, Math.min(...boxes.map((b) => b.left)) - p);
    const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - p);
    const right = Math.min(window.innerWidth, Math.max(...boxes.map((b) => b.right)) + p);
    const bottom = Math.min(window.innerHeight, Math.max(...boxes.map((b) => b.bottom)) + p);

    const full = bottom - top;
    let y = top;
    if (full > cap) {
      const f = focusSel && document.querySelector(focusSel);
      if (f) {
        const fb = f.getBoundingClientRect();
        y = Math.round(fb.top + fb.height / 2 - cap / 2);
      }
      y = Math.max(top, Math.min(y, bottom - cap));
    }

    const h = Math.min(cap, full);
    let left = x, width = right - x;

    /*
     * Widen a narrow crop until it matches the frame it will be shown in.
     *
     * The side panels are portrait -- the tab rail is 224px wide against 300
     * tall -- and the panel renders every shot in the same landscape box. Left
     * to `object-fit: cover` that becomes a 2x magnification of the rail's
     * top-left corner. Widening here instead pulls in the document beside the
     * panel, which is the context that makes the panel legible anyway.
     */
    if (ratio) {
      const want = h * ratio;
      if (width < want) {
        /*
         * Which way to grow matters. The comments and history panes sit on the
         * right of the window with the debug inspector beyond them, so a
         * centred widening photographs the inspector; the tab rail is on the
         * left with the document to its right. Growing toward the document is
         * what puts the panel in context instead of next to furniture.
         */
        const grow = want - width;
        if (side === 'left') left = Math.max(0, left - grow);
        else if (side === 'right') left = left;
        else left = Math.max(0, Math.min(left + width / 2 - want / 2, window.innerWidth - want));
        width = Math.min(want, window.innerWidth - left);
      } else if (width > want) {
        /*
         * And narrow one that is too wide, from the left edge. The toolbar is
         * 872px across; at the frame's ratio that is a 4:1 strip, and the
         * panel would letterbox it into a band with more card than picture in
         * it. Anchored left rather than centred because that is where the
         * controls anybody recognises live -- undo, style, bold.
         */
        width = want;
      }
    }

    return {
      x: Math.round(left),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(h),
    };
  }, selectors, pad, height, focus, aspect, widen);

  await page.screenshot({
    path: join(OUT, `${name}.webp`),
    type: 'webp',
    quality: 90,
    clip,
    captureBeyondViewport: false,
  });
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await sleep(200);
  console.log(`  ${name}.webp  ${clip.width}x${clip.height} css px @${SCALE}x, zoom ${ZOOM}`);
};

mkdirSync(OUT, { recursive: true });
console.log(`\nCapturing the editor at ${BASE}\n`);

// ---- 1. writing: the toolbar over formatted text ---------------------------
await selectText('Weekly sync');
await clickTitled('Bold');
await page.evaluate(() => {
  const h = [...document.querySelectorAll('.toolbar select')]
    .find((s) => [...s.options].some((o) => /heading/i.test(o.textContent)));
  if (!h) return;
  const opt = [...h.options].find((o) => /heading 1|heading/i.test(o.textContent));
  h.value = opt.value;
  h.dispatchEvent(new Event('change', { bubbles: true }));
});
await sleep(400);
await selectText('merges as it lands');
await clickTitled('Italic');
await sleep(500);
/* The last lines, as a list. Four lines of prose under a toolbar is a picture
   of a text box; a heading, an italic run and a bulleted list is a picture of
   a rich-text editor, which is what the caption claims. */
await page.evaluate((n) => {
  const view = document.querySelector('.cm-content');
  const lines = [...view.querySelectorAll('.cm-line')];
  const first = lines[lines.length - n];
  const last = lines[lines.length - 1];
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.childNodes.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}, BULLETS);
await sleep(250);
await clickTitled('Bulleted list');
await sleep(400);

/*
 * Scroll the heading clear of the toolbar, and no further.
 *
 * The document opens a page-margin below the toolbar, so an unscrolled crop is
 * a third white space. 120px closed the gap and then some -- it slid the
 * heading UNDER the floating toolbar, and the shot showed a title cut in half
 * by a control bar. This scrolls until the heading's top clears the toolbar's
 * bottom with a margin, measured rather than guessed.
 */
await page.evaluate(() => {
  const sc = document.querySelector('.cm-scroller');
  const bar = document.querySelector('.toolbar').getBoundingClientRect();
  const head = document.querySelector('.cm-content .cm-line').getBoundingClientRect();
  if (sc) sc.scrollTop += Math.max(0, head.top - bar.bottom - 18);
});
await sleep(300);
/*
 * `pad: 0`, because 10px above the toolbar is the application header -- the
 * first version of this shot opened with a sliced avatar and half a "synced"
 * pill, which reads as a broken screenshot rather than as a crop.
 */
await shot('editing', ['.toolbar', '.cm-content'], { pad: 0, height: 230, aspect: 2.2 });

// ---- 2. comments: a thread anchored to a range -----------------------------
await selectText('anchor to the words');
await sleep(200);
const commented = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')]
    .find((e) => /^comment$/i.test(e.textContent.trim()));
  if (!b) return false;
  b.click();
  return true;
});
if (commented) {
  await sleep(400);
  await page.keyboard.type('Does this survive someone editing inside the range?', { delay: 4 });
  /* Scoped to the pane. Unscoped, this finds the TOOLBAR's "Comment" button
     first -- the draft stays open, the thread is never posted, and the
     screenshot advertises an empty sidebar reading "0 open". */
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.comments-pane button')]
      .find((e) => /^(comment|post|add)$/i.test(e.textContent.trim()));
    b?.click();
  });
  await page.waitForSelector('.cm-comment-range', { timeout: 8_000 }).catch(() => {});
  await sleep(900);
}
/*
 * The pane, widened into the document beside it, rather than the whole span
 * from the highlighted phrase to the thread. Those two are 450px apart with
 * empty document in between, and a crop that holds both is 774px of content
 * shown 265px wide -- a picture of a comment nobody can read the comment in.
 * The thread quotes the phrase it is anchored to in its own header, so the
 * "pinned to the words" claim survives the tighter frame.
 */
await shot('comments', ['.comments-pane'], { pad: 8, height: 232, aspect: 2.2, widen: 'left' });

// ---- 3. tabs and the outline ------------------------------------------------
/* The rail remembers its collapsed state across documents, so this opens it
   only when it is shut -- clicking the toggle unconditionally is how the first
   run produced a 42px-wide photograph of a closed hairline. */
await page.evaluate(() => {
  if (document.querySelector('.tab-index.is-collapsed')) {
    document.querySelector('.tab-index-toggle')?.click();
  }
});
await sleep(600);
await page.evaluate(() => document.querySelector('.tab-index-add')?.click());
await sleep(1800);
/* Back to the first tab before shooting. A freshly added tab is empty, so the
   outline under it reads "No headings yet" -- a true thing to say and a poor
   advertisement for an outline. */
await page.evaluate(() => {
  const first = document.querySelector('.tab-index-list .index-tab .index-tab-row');
  first?.querySelector('button, a')?.click() ?? first?.click();
});
await sleep(2000);
await shot('tabs', ['.tab-index'], { pad: 8, height: 232, aspect: 2.2, widen: 'right' });

// ---- 4. version history -----------------------------------------------------
/*
 * Checkpoints are created through the API rather than through the pane's own
 * "Name this version" control, which opens a `prompt()`. A modal dialog blocks
 * the page, and a blocked page cannot be screenshotted -- it cannot be told to
 * do anything at all.
 */
await page.evaluate(async (id) => {
  const post = (label) => fetch(`http://localhost:8080/api/docs/${id}/checkpoints`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  await post('First draft');
  await post('After the review');
}, docId);
await sleep(600);
await clickTitled('Version history');
await sleep(1200);
await shot('history', ['.history-pane'], { pad: 8, height: 232, aspect: 2.2, widen: 'left' });

// ---- 5. import ---------------------------------------------------------------
/*
 * Driven from /docs, which is where the Import button lives.
 *
 * The dialog is a modal but not a native one: it is ordinary DOM behind a
 * backdrop, so unlike the prompt() in the history pane it can be screenshot
 * while it is open.
 *
 * Found by its label rather than by class, because the button shares
 * `.account-btn` with the sign-in control beside it and clicking the wrong one
 * would photograph a login form.
 */
await page.goto(`${BASE}/docs`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.account-btn', { timeout: 10_000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')]
    .find((el) => el.textContent.trim() === 'Import');
  if (!b) throw new Error('no Import button on /docs');
  b.click();
});
await page.waitForSelector('.import-modal', { timeout: 10_000 });
// The paste box takes focus on open and draws a focus ring; blurring it keeps
// the shot from advertising a caret nobody put there.
await page.evaluate(() => document.activeElement?.blur());
await sleep(500);
/*
 * PAD 54, and the number is solved rather than picked.
 *
 * Drive-only left the modal 650x238 at this zoom -- aspect 2.73, WIDER than
 * the panel's 2.2. shot() only widens a crop that is too narrow; one that is
 * too wide it trims from the right, which cut the lede mid-word twice. The
 * padding is what buys height for the frame to be wide enough to hold the
 * whole modal:
 *
 *     (238 + 2p) * 2.2 >= 650 + 2p   ->   p >= 53
 *
 * so 54, and the crop comes out 761x346 with the dialog centred in it. The
 * cap is above the resulting height on purpose, so the padding governs.
 */
await shot('import', ['.import-modal'], { pad: 54, height: 400, aspect: 2.2 });

await browser.close();
console.log(`\nwrote 5 shots to ${OUT}\n`);
