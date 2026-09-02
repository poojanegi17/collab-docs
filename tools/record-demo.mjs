/**
 * The 20-second version of this whole project.
 *
 *   node tools/record-demo.mjs            (needs: npm run dev)
 *   node tools/record-demo.mjs --headful  watch it being recorded
 *
 * Two real labs, CRDT on the left and OT on the right, driven through the same
 * script at the same time: type, partition both replicas, keep typing on both
 * sides of the split, then heal. The engines answer differently, and that
 * difference is the argument the README spends three paragraphs on.
 *
 * Writes docs/media/partition-heal.gif.
 *
 * Why it composites rather than recording one window: the lab is one engine
 * per page, and the comparison only lands when the two are side by side and
 * SYNCHRONISED -- a reader has to be able to see that both were partitioned at
 * the same moment. So the script drives two pages in lockstep, screenshots
 * both for every frame, and pastes them into one image.
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
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');

/**
 * Viewport per lab, and how much of it to keep.
 *
 * 1280 is not negotiable: below about 900 the lab's responsive layout collapses
 * the editors into overlays, and the first version of this recorder captured
 * two 620px windows showing nothing but network sliders and a frame timeline --
 * a perfectly sharp recording of the wrong half of the page.
 *
 * CLIP_H keeps the header (which names the engine) and both replica panes, and
 * drops the frame timeline below them. The timeline is the lab's best feature
 * and it is not what this recording is about.
 */
const W = 1280;
const H = 560;
const CLIP_H = 388;

/** A hairline between the two engines. */
const SEAM_H = 2;

/**
 * Downscale before encoding.
 *
 * The two labs are stacked vertically rather than side by side: at 1280 each,
 * side by side is 2560 wide, and shrinking that to a README column leaves the
 * editor text unreadable -- which is the one thing a reader has to be able to
 * follow.
 */
const SCALE = 0.68;

/**
 * Minimum gap between captures -- a throttle, not a target.
 *
 * `page.screenshot()` was the first approach and it could not keep up: it
 * shares puppeteer's per-page command queue with the typing, so the capture
 * loop was starved down to about 1.5fps and a fifteen-second demo came out as
 * ten frames. A dedicated CDP session issuing `Page.captureScreenshot`
 * sustains ~18fps on the same page WHILE it is being typed into, which is more
 * than a GIF needs -- hence a throttle rather than a best effort.
 */
const FRAME_MS = 140;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = join(root, 'docs', 'media', 'partition-heal.gif');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});

/** One lab, booted and ready to drive. */
async function openLab(engine) {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  
  const url = engine === 'ot'
    ? `${BASE}/lab?engine=ot&server=ws://localhost:8081`
    : `${BASE}/lab`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  /*
   * Collapse the page's headline for the recording, and only for the recording.
   *
   * The capture below is a FIXED clip of the top CLIP_H pixels with no
   * scrolling, which was the whole frame back when the lab opened on a single
   * compact toolbar. The page now leads with a display-weight headline and a
   * lede, and those alone are taller than the clip -- so the frame filled up
   * with a title while the replicas, which are the entire subject of the
   * asset, sat below it unrecorded. A GIF of a heading is not a GIF of
   * divergence.
   *
   * Hiding the hero rather than scrolling, because the clip is in page
   * coordinates: scrolling moves the replicas under the viewport without
   * moving them into the clip. Nothing about the lab's behaviour changes --
   * the controls, the replicas and the network are exactly what they were.
   */
  await page.addStyleTag({ content: '.lab-hero { display: none !important; }' });

  await page.waitForSelector('.pane .cm-content', { timeout: 20_000 });
  // Both replicas have to be attached before anything is typed, or the first
  // characters land before there is a peer to disagree with.
  await page.waitForFunction(
    () => document.querySelectorAll('.pane .cm-content').length >= 2, { timeout: 20_000 });
  await sleep(1200);

  // Screenshots go over a CDP session of their own, deliberately. See FRAME_MS.
  const cdp = await page.createCDPSession();
  return { page, cdp };
}

const crdt = await openLab('yjs');
const ot = await openLab('ot');
const labs = [crdt, ot];
const pages = labs.map((l) => l.page);

/* ---- frame capture -------------------------------------------------------- */

const frames = [];
let capturing = true;

/**
 * Grab both pages and keep the PNGs encoded.
 *
 * Decoding here was the first version and it was wrong: `PNG.sync.read` on two
 * 620x440 images costs more than the frame interval, so the capture loop ran
 * at about one frame a second and a fifteen-second demo came out as thirteen
 * frames. Decoding is deferred to after the recording, where it is allowed to
 * be slow, and the loop now does nothing but ask Chrome for pixels.
 *
 * Driven by a timer alongside the script rather than once per step, so typing
 * appears as typing instead of as a jump between two finished states.
 */
async function captureFrame() {
  const shots = await Promise.all(labs.map(async ({ cdp }) => {
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: W, height: CLIP_H, scale: 1 },
    });
    return Buffer.from(data, 'base64');
  }));
  // The real clock, not the intended one. Capture jitters, and pacing the GIF
  // on the nominal interval would play a stutter back as smooth motion at the
  // wrong speed.
  frames.push({ at: Date.now(), shots });
}

const ticker = (async () => {
  while (capturing) {
    const t0 = Date.now();
    try { await captureFrame(); } catch { /* a page mid-update; skip the frame */ }
    await sleep(Math.max(0, FRAME_MS - (Date.now() - t0)));
  }
})();

/* ---- the script, run on both engines at once ------------------------------ */

const onBoth = (fn) => Promise.all(pages.map(fn));

async function typeInPane(page, idx, text) {
  const el = (await page.$$('.pane .cm-content'))[idx];
  await el.click();
  await page.keyboard.type(text, { delay: 45 });
}

console.log('recording...');

// 1. In sync: one replica types and the other receives it.
await onBoth((p) => typeInPane(p, 0, 'Shared draft. '));
await sleep(700);

// 2. Partition both replicas. A black hole rather than a disconnect: the
//    socket stays up and the frames go nowhere, which is the harder case.
await onBoth(async (p) => {
  const buttons = await p.$$('.net-partition');
  await buttons[0].click();
  await buttons[1].click();
});
await sleep(700);

// 3. Both sides keep working, unaware of each other.
await onBoth((p) => typeInPane(p, 0, 'A edits offline. '));
await onBoth((p) => typeInPane(p, 1, 'B edits offline. '));
await sleep(900);

// 4. Heal. This is the moment the whole recording exists for.
await onBoth((p) => p.click('.lab-btn-accent'));
await sleep(3200);

capturing = false;
await ticker;
console.log(`captured ${frames.length} frames`);

/* ---- scale and encode ----------------------------------------------------- */

/**
 * Box-filter downscale.
 *
 * Nearest-neighbour turns 12px UI text into noise, and noise is the worst
 * possible input to a palette quantiser -- it spends the palette on artefacts
 * instead of on the interface.
 */
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

/** A rule between the two engines, so the stack reads as two recordings. */
function withSeam(frame) {
  const { data, width, height } = frame;
  const mid = Math.round(height / 2);
  for (let y = mid - 1; y <= mid; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 150; data[i + 1] = 158; data[i + 2] = 168; data[i + 3] = 255;
    }
  }
  return frame;
}

/** Stack one captured pair into a single image: CRDT above, OT below. */
function compose({ shots }) {
  const [a, b] = shots.map((buf) => PNG.sync.read(buf));
  const full = new PNG({ width: W, height: CLIP_H * 2 + SEAM_H, fill: true });
  PNG.bitblt(a, full, 0, 0, Math.min(W, a.width), Math.min(CLIP_H, a.height), 0, 0);
  PNG.bitblt(b, full, 0, 0, Math.min(W, b.width), Math.min(CLIP_H, b.height),
    0, CLIP_H + SEAM_H);
  return full;
}

console.log('encoding...');

const gif = GIFEncoder();
for (let i = 0; i < frames.length; i++) {
  const small = withSeam(downscale(compose(frames[i]), SCALE));

  // Real elapsed time between captures. The last frame has no successor, so it
  // holds for a beat before the loop restarts -- which also gives a reader a
  // moment to see the converged state, the point of the whole recording.
  const delay = i + 1 < frames.length
    ? Math.max(20, frames[i + 1].at - frames[i].at)
    : 1500;

  // A palette per frame: the lab's colours change when a pane goes
  // partitioned, and one global palette muddies the amber warning state.
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
