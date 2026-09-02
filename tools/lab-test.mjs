/**
 * Real-browser test for /lab.
 *
 *   node tools/lab-test.mjs [--engine=ot] [--headful]
 *
 * The interesting assertion is the last one: partition both replicas, edit
 * both, heal, and check that the engines diverge in the way their ADRs say
 * they should. CRDT merges; OT discards the reconnecting client's work.
 */
import puppeteer from 'puppeteer-core';
import { until } from './ui-wait.mjs';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const ENGINE = (process.argv.find((a) => a.startsWith('--engine=')) ?? '').split('=')[1] ?? 'yjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`${BASE}/lab?engine=${ENGINE}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pane', { timeout: 15_000 });

console.log(`\nLab end-to-end  (engine=${ENGINE})\n`);

// ---- structure -------------------------------------------------------------
const paneCount = await page.$$eval('.pane', (e) => e.length);
check('1. lab renders two client panes', paneCount === 2, `${paneCount} panes`);

/*
 * Waited for, not slept on. Reaching `synced` is the socket admission path --
 * session, tab, document and permission reads -- plus the room's own load, all
 * of which are Postgres round trips, so a fixed sleep is either flaky or slow
 * depending which side of the network it was tuned for. See tools/ui-wait.mjs.
 */
const readStatuses = () =>
  page.$$eval('.pane-status', (els) => els.map((e) => e.innerText.trim()));
const statuses = await until(
  readStatuses,
  (s) => s.length === 2 && s.every((v) => v.includes('synced')),
  { timeout: 20_000 });
check('2. both replicas connect independently',
  statuses.length === 2 && statuses.every((s) => s.includes('synced')), statuses.join(' | '));

/** Text of pane `i`, with peer caret labels stripped. */
const paneText = (i) => page.evaluate((idx) => {
  const el = document.querySelectorAll('.pane .cm-content')[idx];
  const clone = el.cloneNode(true);
  for (const c of clone.querySelectorAll('.cm-peer-caret')) c.remove();
  return clone.innerText.replace(/\u200b/g, '').trim();
}, i);

const typeInPane = async (i, text) => {
  const el = (await page.$$('.pane .cm-content'))[i];
  await el.click();
  await page.keyboard.type(text, { delay: 10 });
};

// ---- live sync between panes ----------------------------------------------
await typeInPane(0, 'shared text. ');
// Waited for rather than slept on, for the reason above: this is a round trip
// to the server and back out to the other replica.
const synced = await until(() => paneText(1), (t) => t.includes('shared text.'),
  { timeout: 15_000 });
check('3. panes sync live', synced.includes('shared text.'), JSON.stringify(synced));

// ---- the timeline is decoding real frames ----------------------------------
{
  const rows = await page.$$eval('.tl-row', (els) =>
    els.slice(0, 12).map((e) => e.innerText.replace(/\s+/g, ' ')));
  check('4. timeline records frames', rows.length > 0, `${rows.length} rows`);
  const kinds = await page.$$eval('.tl-kind', (els) => [...new Set(els.map((e) => e.innerText))]);
  const expected = ENGINE === 'ot' ? ['op', 'ack', 'apply'] : ['update', 'sync-step1', 'sync-step2'];
  check('5. timeline decodes engine frames', expected.some((k) => kinds.includes(k)),
    kinds.join(', '));
}

// ---- latency actually delays delivery --------------------------------------
{
  // Give pane 0 a large latency, type, and confirm pane 1 has NOT seen it yet.
  await page.evaluate(() => {
    const slider = document.querySelectorAll('.pane')[0].querySelectorAll('input[type=range]')[0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(slider, '2000');
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);

  const sentAt = Date.now();
  await typeInPane(0, 'DELAYED ');
  await sleep(700);
  const early = await paneText(1);
  check('6. latency delays delivery', !early.includes('DELAYED'), JSON.stringify(early));

  /**
   * Poll rather than sleep a fixed amount, and report how long it took --
   * because the two engines genuinely differ here and the number is the point.
   *
   * CRDT streams updates without waiting for anything, so the whole burst
   * lands after roughly ONE latency. OT allows exactly one op in flight, so
   * the buffered remainder cannot leave until the first op is acked: two full
   * round trips, ~4x the latency. That is the cost of server authority under
   * a slow link, and it is invisible until you can actually slow the link.
   */
  const deadline = Date.now() + 15_000;
  let late = '';
  while (Date.now() < deadline) {
    late = await paneText(1);
    if (late.includes('DELAYED')) break;
    await sleep(150);
  }
  check('6b. delayed frames all arrive eventually', late.includes('DELAYED'),
    `${((Date.now() - sentAt) / 1000).toFixed(1)}s at 2000ms latency — ${JSON.stringify(late)}`);

  // Put it back.
  await page.evaluate(() => {
    const slider = document.querySelectorAll('.pane')[0].querySelectorAll('input[type=range]')[0];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(slider, '0');
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(1500);
}

// ---- partition, diverge, heal ----------------------------------------------
{
  const partitionButtons = await page.$$('.net-partition');
  await partitionButtons[0].click();
  await partitionButtons[1].click();
  await sleep(400);

  const warns = await page.$$eval('.pane-warn', (e) => e.length);
  check('7. both panes show as partitioned', warns === 2, `${warns} warnings`);

  // The socket is still open, so status must NOT read offline -- that is what
  // makes a black-hole partition nastier than a disconnect.
  const stillConnected = await page.$$eval('.pane-status', (els) =>
    els.every((e) => !e.innerText.includes('offline')));
  check('8. partition does not look like a disconnect', stillConnected);

  await typeInPane(0, '[A-partitioned] ');
  await typeInPane(1, '[B-partitioned] ');
  await sleep(800);

  const a = await paneText(0), b = await paneText(1);
  check('9. replicas diverge under partition',
    a.includes('[A-partitioned]') && !b.includes('[A-partitioned]'),
    `A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);

  // Heal both and force anti-entropy.
  await page.click('.lab-btn-accent');  // "reconnect all"
  await sleep(3500);

  const a2 = await paneText(0), b2 = await paneText(1);
  check('10. replicas converge after heal', a2 === b2, `A=${JSON.stringify(a2)} B=${JSON.stringify(b2)}`);

  // The documented engine difference.
  const keptBoth = a2.includes('[A-partitioned]') && a2.includes('[B-partitioned]');
  if (ENGINE === 'yjs') {
    check('11. CRDT: both sides of the partition survive the heal', keptBoth, JSON.stringify(a2));
  } else {
    check('11. OT: heal resyncs to the server document, discarding local work',
      !keptBoth, JSON.stringify(a2));
  }
}

// ---- adding a client --------------------------------------------------------
{
  const addBtn = await page.$$('.lab-btn');
  for (const b of addBtn) {
    if ((await b.evaluate((e) => e.innerText)).includes('+ replica')) { await b.click(); break; }
  }
  await sleep(2500);
  const panes = await page.$$eval('.pane', (e) => e.length);
  check('12. a third replica can join live', panes === 3, `${panes} panes`);
  const third = await paneText(2);
  check('12b. the new replica loads the document', third.length > 0, JSON.stringify(third).slice(0, 80));
}

check('13. no page errors', errors.length === 0, errors.slice(0, 2).join(' ;; '));

if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
if (HEADFUL) { console.log('\n  (headful: holding 20s)'); await sleep(20_000); }
await browser.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
