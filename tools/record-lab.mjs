/**
 * The lab, recorded: four replicas of one document under a lossy network.
 *
 *   node tools/record-lab.mjs              (drives the DEPLOYED site)
 *   node tools/record-lab.mjs --local      (needs: npm run dev)
 *   node tools/record-lab.mjs --headful    watch it being recorded
 *
 * Writes docs/media/lab-four-replicas.gif.
 *
 * WHY THIS IS A SECOND RECORDER AND NOT A FLAG ON THE FIRST
 *
 * `record-demo.mjs` answers one question -- what do the two engines do with a
 * partition -- and to answer it, it drives two pages in lockstep and clips
 * away everything below the replicas, including the frame timeline. That clip
 * is the right call there and the wrong one here: this recording exists to
 * show the timeline FILLING, which is the part of the lab that makes the
 * transport visible rather than merely working.
 *
 * So the subject is different, the layout is different (one engine, four
 * replicas, a 2x2 grid) and the clip is different (panes AND the bottom row).
 * Two scripts, not one with a mode switch.
 *
 * WHY IT DEFAULTS TO THE DEPLOYED SITE
 *
 * The lab needs a server, the server needs Postgres, and requiring a database
 * to regenerate a README asset means the asset stops being regenerated. The
 * deployed CRDT service is the same code and is kept warm by the keep-alive
 * cron, so the default path needs nothing installed but Chrome. `--local`
 * points it back at `npm run dev` for anyone changing the lab itself.
 *
 * It creates one unowned scratch document on whatever backend it drives --
 * which is exactly what every visitor to /lab does, and is the arrangement
 * ADR-010 describes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
// gifenc ships CommonJS, so the named exports come off the default.
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH
  ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LOCAL = process.argv.includes('--local');
const BASE = process.env.BASE_URL
  ?? (LOCAL ? 'http://localhost:5173' : 'https://collab-client-kvn5.onrender.com');
const HEADFUL = process.argv.includes('--headful');

/**
 * Tall viewport, because the subject is the whole column.
 *
 * 1280 wide for the same reason record-demo.mjs is: below ~900 the lab folds
 * the editors into overlays. 1400 tall is what it takes to hold a 2x2 replica
 * grid AND the timeline underneath it without scrolling -- and scrolling is
 * not an option, because the clip below is in page coordinates.
 */
const W = 1280;
const H = 1400;

/** Downscale before encoding. A 1280-wide GIF in a README column is waste. */
const SCALE = 0.52;

/** A throttle, not a target. See the note in record-demo.mjs. */
const FRAME_MS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = join(root, 'docs', 'media', 'lab-four-replicas.gif');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });

console.log(`driving ${BASE}/lab`);
// The deployed backend may be cold. A spun-down container takes tens of
// seconds to schedule, and that wait is the normal case rather than a fault.
await page.goto(`${BASE}/lab`, { waitUntil: 'domcontentloaded', timeout: 120_000 });

/*
 * Hide the headline for the recording only. Same reasoning as record-demo:
 * the clip is a fixed rectangle in page coordinates, and a display-weight
 * hero alone is taller than the replicas are.
 */
await page.addStyleTag({ content: '.lab-hero { display: none !important; }' });

await page.waitForSelector('.pane .cm-content', { timeout: 60_000 });
await page.waitForFunction(
  () => document.querySelectorAll('.pane .cm-content').length >= 2, { timeout: 60_000 });

/* ---- set the scene -------------------------------------------------------- */

/** Click a control by its visible label, within a named group. */
async function clickByText(selector, text) {
  const handle = await page.evaluateHandle((sel, want) => {
    const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    return [...document.querySelectorAll(sel)].find((el) => norm(el.textContent) === want);
  }, selector, text.toLowerCase());
  const el = handle.asElement();
  if (!el) throw new Error(`no ${selector} labelled "${text}"`);
  await el.click();
}

// Two more replicas, for four in a 2x2 grid. Four is the smallest number that
// makes fan-out look like fan-out: with two, an edit has one destination and
// the timeline reads as a conversation rather than as a broadcast.
await clickByText('.lab-btn', '+ replica');
await clickByText('.lab-btn', '+ replica');
await page.waitForFunction(
  () => document.querySelectorAll('.pane .cm-content').length >= 4, { timeout: 30_000 });
await sleep(1500);

// A lossy network on every replica at once. Without this the frames arrive
// faster than the eye resolves and the timeline fills in one jump -- correct,
// and completely uninformative.
await clickByText('.lab-btn', 'slow everyone');
await sleep(600);

const panes = () => page.$$('.pane .cm-content');

async function typeInPane(idx, text) {
  const el = (await panes())[idx];
  if (!el) throw new Error(`no replica ${idx}`);
  await el.click();
  await page.keyboard.type(text, { delay: 55 });
}

/* ---- work out what to record ---------------------------------------------- */

/*
 * The clip is measured, not hard-coded.
 *
 * The lab's height depends on the replica count, and a constant tuned against
 * a 2x2 grid silently crops the wrong thing the first time anyone changes
 * MAX_CLIENTS or the pane aspect. So: from the top of the replica grid to the
 * bottom of the timeline row, whatever those happen to be today.
 */
const clip = await page.evaluate(() => {
  const top = document.querySelector('.panes-head').getBoundingClientRect();
  const bottom = document.querySelector('.lab-bottom').getBoundingClientRect();
  const y = Math.max(0, Math.floor(top.top + window.scrollY) - 8);
  return {
    x: 0,
    y,
    width: document.documentElement.clientWidth,
    height: Math.ceil(bottom.bottom + window.scrollY) - y + 8,
  };
});
if (clip.height > H) {
  console.warn(`  clip is ${clip.height}px tall in a ${H}px viewport -- raise H`);
  clip.height = H;
}
console.log(`  clip ${clip.width}x${clip.height} at y=${clip.y}`);

/* ---- frame capture -------------------------------------------------------- */

const frames = [];
let capturing = true;

// A CDP session of its own, so screenshots do not queue behind the typing.
const cdp = await page.createCDPSession();

const ticker = (async () => {
  while (capturing) {
    const t0 = Date.now();
    try {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: { ...clip, scale: 1 },
      });
      frames.push({ at: Date.now(), shot: Buffer.from(data, 'base64') });
    } catch { /* a page mid-update; skip the frame */ }
    await sleep(Math.max(0, FRAME_MS - (Date.now() - t0)));
  }
})();

/* ---- the run -------------------------------------------------------------- */

console.log('recording...');

// 1. One replica types; three receive. The timeline starts filling, and every
//    frame in it is one of the four sockets.
await typeInPane(0, 'One document. ');
await sleep(1400);

// 2. A second replica types into the same line. Concurrent, under latency --
//    which is the case the whole project is about.
await typeInPane(1, 'Four replicas. ');
await sleep(1400);

// 3. Cut one replica off. Not a disconnect: the socket stays up and the frames
//    go nowhere, which is the harder case and the one the lab exists for.
const partitionButtons = await page.$$('.net-partition');
await partitionButtons[2].click();
await sleep(500);

// 4. The partitioned replica works on regardless, and so does the rest of the
//    room. Neither knows.
await typeInPane(2, 'Cut off, still typing. ');
await sleep(700);
await typeInPane(0, 'Meanwhile, elsewhere. ');
await sleep(1200);

// 5. Heal. The moment the recording exists for: the isolated replica's work
//    arrives, and everyone else's arrives at it.
await clickByText('.lab-btn', 'reconnect all');
await sleep(4000);

capturing = false;
await ticker;
console.log(`captured ${frames.length} frames`);

/* ---- scale and encode ----------------------------------------------------- */

/** Box-filter downscale. Nearest-neighbour turns 12px UI text into noise. */
function downscale(png, scale) {
  const w = Math.round(png.width * scale);
  const h = Math.round(png.height * scale);
  const out = Buffer.alloc(w * h * 4);
  const bx = png.width / w;
  const by = png.height / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * by);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * by));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * bx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * bx));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * png.width + sx) * 4;
          r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

console.log('encoding...');

const gif = GIFEncoder();
for (let i = 0; i < frames.length; i++) {
  const small = downscale(PNG.sync.read(frames[i].shot), SCALE);

  // Real elapsed time between captures, so a stutter in the capture does not
  // play back as smooth motion at the wrong speed. The last frame holds, which
  // gives a reader a moment to see the converged state.
  const delay = i + 1 < frames.length
    ? Math.max(20, frames[i + 1].at - frames[i].at)
    : 1800;

  // A palette per frame: a pane going partitioned changes the page's colours,
  // and one global palette muddies the amber warning state.
  const palette = quantize(small.data, 128, { format: 'rgb565' });
  const index = applyPalette(small.data, palette, 'rgb565');
  gif.writeFrame(index, small.width, small.height, { palette, delay });
}
gif.finish();

mkdirSync(dirname(OUT), { recursive: true });
const bytes = gif.bytes();
writeFileSync(OUT, bytes);

console.log(`wrote ${OUT}`);
console.log(`  ${frames.length} frames, ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
if (bytes.length > 5 * 1024 * 1024) {
  console.warn('  (over 5 MB -- lower SCALE or raise FRAME_MS)');
}

await browser.close();
