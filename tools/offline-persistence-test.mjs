/**
 * Does work survive a RELOAD while offline?
 *
 * This is the gap the local store was added to close, and it is the one thing
 * no other harness could ever have caught. Every headless test in `tools/`
 * runs in Node, and Node has no IndexedDB -- so the whole persistence path is
 * invisible to them by construction. `toggle-test.mjs` proves the neighbouring
 * and much weaker claim: that a client which loses its socket and keeps typing
 * converges once the socket comes back. It never closes the page, so it never
 * asks whether the document was anywhere but memory.
 *
 * It was not. Before this, `y-indexeddb` was a declared dependency that
 * nothing imported, and "offline editing" in the README meant only "the socket
 * dropped and you kept typing". Reloading during a network drop lost the work
 * silently -- and for a guest document, which the server files under nobody
 * and which is recoverable only from its URL, that is the whole document.
 *
 * The last check is the important one and it is a NEGATIVE. The lab puts
 * several replicas of the SAME document in ONE browser, so a local store
 * shared between them would be a back channel: partition two replicas, type in
 * both, and they would converge through the disk with the network cut. The
 * partition demo -- the single thing the lab exists to show -- would keep
 * looking like it worked while proving nothing. So persistence is off by
 * default and the editor opts in, and this asserts that it stayed that way.
 *
 *   node tools/offline-persistence-test.mjs            (needs: npm run dev)
 *   node tools/offline-persistence-test.mjs --headful
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

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 180_000);
guard.unref?.();

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const docId = 'persist-' + Date.now();
const errors = [];

async function openDoc(page, client) {
  page.on('pageerror', (e) => errors.push(`[${client}] ${e.message}`));
  page.on('console', (m) => {
    // A refused WebSocket is what this test is DOING, so its console noise is
    // expected output rather than a failure.
    const t = m.text();
    const noisy = ['websocket', 'ws:', 'err_blocked', 'failed to fetch'];
    if (m.type() === 'error' && !noisy.some((n) => t.toLowerCase().includes(n))) {
      errors.push(`[${client}] console: ${t}`);
    }
  });
  await page.goto(`${BASE}/doc?doc=${docId}&client=${client}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  return page;
}

const text = (page) => page.evaluate(() => window.__sync.getText());

/**
 * Cut the WebSocket, and only the WebSocket.
 *
 * `setOfflineMode` would be the obvious tool and is the wrong one here: in
 * development the app itself is served over the network, so blocking
 * everything means the page cannot even load its own JavaScript and the
 * reload proves nothing. A deployed app would have a cached shell; this
 * harness gets the same effect by blocking the sync server's ws:// origin and
 * leaving http:// alone. The document's content only ever travels over the
 * socket -- never over the JSON API, by the rule at the top of api.js -- so
 * text that appears after this reload cannot have come from anywhere but disk.
 */
async function cutSocket(page, cut) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: cut ? ['ws://localhost:8080*'] : [] });
  return cdp;
}
/** The status button doubles as the offline/online toggle. */
const toggle = (page) => page.evaluate(() => document.querySelector('button.status').click());

console.log('\nOffline durability across a reload\n');

// ---- 1. a document written online is on disk, not only in memory ------------
const alice = await openDoc(await browser.newPage(), 'alice');
await alice.click('.cm-content');
await alice.keyboard.type('written while online');
await sleep(800);

check('1. the local store is wired up at all',
  await alice.evaluate(() => window.__sync.persistence !== null));

const dbs = await alice.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
check('1b. it is namespaced, not squatting on a bare document id',
  dbs.some((n) => n === `collab-docs:${docId}`), JSON.stringify(dbs.slice(0, 4)));

// ---- 2. THE POINT: go offline, type, reload ---------------------------------
await toggle(alice);
await sleep(400);
await alice.click('.cm-content');
await alice.keyboard.press('End');
await alice.keyboard.type(' + written while OFFLINE');
await sleep(600);

const beforeReload = await text(alice);
check('2. the offline edit is in the document before reloading',
  beforeReload.includes('written while OFFLINE'), JSON.stringify(beforeReload));

// Reload with the socket still cut. Memory is gone; only the disk can answer.
const cdp = await cutSocket(alice, true);
await alice.reload({ waitUntil: 'domcontentloaded' });
await alice.waitForSelector('.cm-content', { timeout: 15_000 });
await sleep(1200);

const afterReload = await text(alice);
check('2b. it SURVIVES a reload with no server reachable',
  afterReload.includes('written while OFFLINE'), JSON.stringify(afterReload));
check('2c. and so does the text written before the drop',
  afterReload.includes('written while online'), JSON.stringify(afterReload));

// ---- 3. and it still reaches the server once the network returns ------------
await cdp.send('Network.setBlockedURLs', { urls: [] });
await sleep(500);
await alice.evaluate(() => window.__sync.connect());
await sleep(2500);

const bob = await openDoc(await browser.newPage(), 'bob');
await sleep(2000);
const bobText = await text(bob);
check('3. a second client receives the work done offline',
  bobText.includes('written while OFFLINE'), JSON.stringify(bobText));
check('3b. restoring from disk did not duplicate the document',
  (bobText.match(/written while online/g) ?? []).length === 1, JSON.stringify(bobText));

// ---- 4. the lab must NOT persist, or its partition proves nothing -----------
// Snapshot first. `indexedDB.databases()` is per ORIGIN, not per page, so the
// lab can see the store the EDITOR made above; the question is whether opening
// the lab adds one of its own.
const before = new Set(await alice.evaluate(
  async () => (await indexedDB.databases()).map((d) => d.name)));

const lab = await browser.newPage();
lab.on('pageerror', (e) => errors.push(`[lab] ${e.message}`));
await lab.goto(`${BASE}/lab`, { waitUntil: 'domcontentloaded' });
await lab.waitForSelector('.cm-content', { timeout: 15_000 });
await sleep(1500);

const labPersists = await lab.evaluate(
  () => (window.__labSyncs ?? []).some((s) => s.persistence !== null));
check('4. lab replicas do not share a local store', labPersists === false);

const after = await lab.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
const added = after.filter((n) => !before.has(n));
check('4b. and opening the lab created no store of its own',
  added.length === 0, JSON.stringify(added));

check('5. no page errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await browser.close();
process.exit(fail ? 1 : 0);
