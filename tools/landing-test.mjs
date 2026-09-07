/**
 * Real-browser test for the landing mosaic and the /api/docs endpoint.
 *
 *   node tools/landing-test.mjs   (needs: npm run dev)
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';

/** The generated record. /decisions must agree with it exactly. */
const ADRS = JSON.parse(readFileSync(
  new URL('../frontend/public/decisions.json', import.meta.url), 'utf8')).adrs;

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const HEADFUL = process.argv.includes('--headful');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 120_000);
guard.unref?.();

/**
 * Wait for the one-shot entrance to finish.
 *
 * While `motion-pending` is set the panels are `visibility: hidden`, so a click
 * lands on nothing and the typing that follows goes into the void. That is not
 * a bug — it is the reference choreography — but a test that navigates and
 * immediately interacts has to respect it.
 */
/**
 * The title the editor is showing, once the server has told it.
 *
 * `.doc-title` starts as the document ID -- see the session defaults in
 * App.jsx -- and is replaced when the HELLO frame arrives. Waiting for
 * `.cm-content` is not enough to have seen it: admitting a socket is now four
 * Postgres round trips (session, tab, document, permission) plus the room's
 * own load, and HELLO measured 2.9s behind the editor mounting on a
 * development machine talking to a database in another region. In the same
 * region it is a few milliseconds.
 *
 * So this waits for the title to stop being the id rather than assuming one
 * has arrived, which asserts what the checks actually care about -- the server
 * sends the stored title -- instead of how fast it does it.
 */
const titleAfterHello = async (page, docId, timeout = 20_000) => {
  await page.waitForFunction((id) => {
    const el = document.querySelector('.doc-title');
    if (!el) return false;
    const shown = el.value ?? el.textContent;
    return shown && shown !== id;
  }, { timeout }, docId).catch(() => { /* fall through and report what is there */ });
  return page.$eval('.doc-title', (e) => e.value ?? e.textContent);
};

const settled = (page) => page.waitForFunction(() => {
  const c = document.documentElement.classList;
  return !c.contains('motion-pending') && !c.contains('entrance-run');
}, { timeout: 10_000 });

console.log('\nLanding mosaic\n');

// ---- the API the page depends on -------------------------------------------
for (const [label, port] of [['CRDT', 8080], ['OT', 8081]]) {
  const res = await fetch(`http://localhost:${port}/api/docs`);
  const body = await res.json();
  check(`1. ${label} server serves /api/docs`, res.ok && Array.isArray(body.docs),
    `engine=${body.engine} docs=${body.docs?.length}`);
  check(`1b. ${label} sends CORS header`, res.headers.get('access-control-allow-origin') === '*');

  // The status panel's whole point is that these are real, so the test asserts
  // the shape rather than trusting the panel's own rendering of it.
  // Shallow first: this is the shape Render and the keep-alive cron see, and
  // the assertion that matters is what is ABSENT. The storage aggregates must
  // not be here, because reaching storage on this path is what exhausted the
  // database's monthly compute -- see .github/workflows/keepalive.yml.
  const shallow = await (await fetch(`http://localhost:${port}/api/health`)).json();
  check(`1c. ${label} serves a shallow /api/health that never reads storage`,
    shallow.ok === true && Number.isFinite(shallow.clients)
      && Number.isFinite(shallow.uptimeMs)
      && !('docs' in shallow) && !('bytes' in shallow) && !('lastWrite' in shallow),
    JSON.stringify(shallow));

  const h = await (await fetch(`http://localhost:${port}/api/health?deep=1`)).json();
  check(`1c2. ${label} serves /api/health?deep=1 with aggregates`,
    h.ok === true && h.deep === true
      && Number.isFinite(h.docs) && Number.isFinite(h.bytes)
      && Number.isFinite(h.clients) && Number.isFinite(h.uptimeMs),
    JSON.stringify(h));
  // No titles, no ids, no owners: an unauthenticated route must not become a
  // way to enumerate documents.
  check(`1d. ${label} /api/health leaks no document identity`,
    !('docs' in h && Array.isArray(h.docs)) && !JSON.stringify(h).includes('title'),
    Object.keys(h).join(','));
}

// A document created over the WebSocket must appear in the listing -- proof the
// endpoint reads real storage rather than anything cached in memory.
const marker = `zz-probe-${Date.now()}`;
{
  const { YjsSync } = await import('../frontend/src/sync/yjs-sync.js');
  const c = new YjsSync({ url: 'ws://localhost:8080', docId: marker, clientId: 'probe' });
  await c.connect();
  c.text.insert(0, 'created for the landing listing');
  await sleep(600);
  const body = await (await fetch('http://localhost:8080/api/docs')).json();
  const found = body.docs.find((d) => d.docId === marker);
  check('2. a new document appears in the listing', !!found,
    found ? `${found.bytes} B, ${found.online} online` : 'not found');
  c.destroy();
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: !HEADFUL,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const errors = [];
const page = await browser.newPage();
await page.setViewport({ width: 1512, height: 820 });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
// Chrome's console message for a failed fetch is "Failed to load resource: the
// server responded with a status of 403", with no URL in it -- which says a
// request failed and refuses to say which. The response listener supplies the
// half that makes the failure actionable.
page.on('response', (r) => {
  if (r.status() >= 400) errors.push(`http ${r.status()} ${r.request().method()} ${r.url()}`);
});

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.stage', { timeout: 15_000 });
await settled(page);

// ---- routing and composition -----------------------------------------------
check('3. / renders the mosaic', true);
check('3b. / does NOT mount the editor', (await page.$('.cm-content')) === null);

{
  const cards = await page.$$eval('.card', (els) => els.map((e) => e.className.replace('card ', '')));
  check('4. all five panels render', cards.length === 5, cards.join(', '));
}

// The design-unit system: the root font-size knob must be scoped to this route.
{
  const size = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  const stage = await page.$eval('.stage', (e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  // 1374 x 666 design units, scaled by the knob.
  check('5. stage holds its 1374x666 unit ratio',
    Math.abs(stage.w / stage.h - 1374 / 666) < 0.02,
    `${stage.w}x${stage.h}, 1rem=${size.toFixed(3)}px`);
}

// ---- nothing overflows its card (the bug the first render had) --------------
{
  const bad = await page.evaluate(() => {
    const out = [];
    for (const card of document.querySelectorAll('.card')) {
      const cb = card.getBoundingClientRect();
      for (const el of card.querySelectorAll('.tag, .bar-search, .hood-proof b, .feat b, .feat-note, .demo-cut, .demo-verdict')) {
        const r = el.getBoundingClientRect();
        if (r.right > cb.right + 0.5 || r.left < cb.left - 0.5) {
          out.push(`${el.className.split(' ')[0]}:"${el.innerText.trim().slice(0, 18)}"`);
        }
      }
    }
    return out;
  });
  check('6. no element is clipped by its card', bad.length === 0, bad.join(', '));
}

// ---- the page says what it is, in its largest type -------------------------
//
// The centre panel is the introduction and the foot is the demonstration, so
// the largest words on the page describe the thing rather than a comparison
// between two of its internals. This asserts the h1 is the identity statement,
// not that it carries any particular phrasing.
{
  const intro = await page.evaluate(() => ({
    hero: document.querySelector('.intro h1')?.innerText.trim() ?? '',
    copy: document.querySelector('.intro-copy')?.innerText.trim() ?? '',
    all: document.querySelector('.intro')?.innerText.trim() ?? '',
  }));

  /*
   * The largest type on the page names the product, and the paragraph under it
   * uses the words somebody would search for.
   *
   * Split in two, because pinning both to the heading would pin the PHRASING
   * -- a `/typ/` here fails the moment the heading stops using that word, and
   * the check is supposed to be about whether the page introduces itself at
   * all. The heading is allowed to sell; what it may not do is be about
   * nothing.
   */
  check('6a. the page names what it is, in its biggest type',
    intro.hero.length > 15 && /(edit|collaborat|document)/i.test(intro.hero),
    intro.hero.replace(/\s+/g, ' '));
  // Across the panel, not the paragraph: "real-time" is doing its work in the
  // heading, and which line carries which word is the copywriter's business.
  check('6a-ii. and the panel uses the words people search for',
    /real-?time/i.test(intro.all) && /(cursor|merge)/i.test(intro.all)
      && /document/i.test(intro.all),
    intro.copy.replace(/\s+/g, ' ').slice(0, 70));
}

// ---- and the tile beside it says what that is built on ---------------------
//
// The regression this guards: a figure on this page that nothing produced. So
// the durability line is checked against the JSON the measurement tool wrote,
// and the record is checked for being a passing one.
{
  const hood = await page.evaluate(() => ({
    parts: [...document.querySelectorAll('.hood-list li')].map((e) => e.innerText.trim()),
    proof: document.querySelector('.hood-proof')?.innerText.trim() ?? '',
    adr: document.querySelector('.hood-proof')?.getAttribute('href'),
  }));

  const record = JSON.parse(readFileSync(
    new URL('../frontend/src/ui/landing/durability.json', import.meta.url), 'utf8'));

  check('6b. the page says what it is built on', hood.parts.length >= 4,
    `${hood.parts.length} parts: ${hood.parts.join(' | ')}`);
  check('6c. the durability record is a passing one',
    record.charsLost === 0 && record.coldClientAgrees === true,
    `lost=${record.charsLost} coldAgrees=${record.coldClientAgrees}`);
  check('6d. and its one figure is the measured one',
    hood.proof.includes(String(record.charsLost))
      && hood.proof.includes(record.charsWritten.toLocaleString())
      && hood.proof.includes(record.signal),
    hood.proof.replace(/\s+/g, ' '));
  check('6d-ii. the tile links to the durability ADR',
    hood.adr === '/decisions#adr-019', hood.adr);
}

// ---- and what it does, in photographs of the real thing --------------------
//
// The panel is four screenshots with a caption each, and the screenshots are
// produced by tools/capture-shots.mjs driving the actual editor. Two things
// are worth asserting and one is not: that every shot is named and captioned,
// and that every one of them actually LOADED -- a feature panel whose pictures
// 404 is worse than the prose it replaced. What is not asserted is what is in
// them; that is what the capture tool's own crops decide.
{
  const feat = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.feat')];
    const imgs = [...document.querySelectorAll('.feat-img')];
    return {
      rows: rows.length,
      named: rows.every((r) => (r.querySelector('b')?.innerText ?? '').trim().length > 2),
      noted: rows.every((r) => (r.querySelector('.feat-note')?.innerText ?? '').trim().length > 10),
      shots: imgs.length,
      broken: imgs.filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')),
      // Exactly one is shown at a time, and it is the one whose row is pressed.
      on: imgs.filter((i) => i.classList.contains('is-on')).length,
      pressed: rows.filter((r) => r.getAttribute('aria-pressed') === 'true').length,
      // The shot on show is the only one that may carry alt text -- the other
      // three are decoration for as long as they are hidden.
      described: imgs.filter((i) => (i.getAttribute('alt') ?? '').length > 20).length,
      also: document.querySelector('.feat-also')?.innerText.trim() ?? '',
    };
  });

  check('6e. every feature is captioned', feat.rows === 5 && feat.named && feat.noted,
    `${feat.rows} rows`);
  check('6f. and photographed', feat.shots === 5, `${feat.shots} shots`);
  check('6g. every photograph loaded', feat.broken.length === 0, feat.broken.join(', '));
  check('6h. one is shown, and its row says so',
    feat.on === 1 && feat.pressed === 1 && feat.described === 1,
    `${feat.on} shown, ${feat.pressed} pressed, ${feat.described} described`);
  check('6h-ii. the rest are named in a line, not a list', /live cursors/i.test(feat.also),
    feat.also);
}

// ---- /decisions renders the record ------------------------------------------
{
  const dec = await browser.newPage();
  await dec.goto(`${BASE}/decisions`, { waitUntil: 'domcontentloaded' });
  await dec.waitForSelector('.dec-card', { timeout: 15_000 });

  /*
   * A card per decision, not every ADR rendered in full: the grid is the map,
   * and the prose sits behind a control rather than always in the DOM -- so
   * the parser checks below open one first.
   */
  const got = await dec.evaluate(() => ({
    cards: document.querySelectorAll('.dec-card').length,
    first: document.querySelector('.adr-h')?.innerText.trim(),
    consequences: document.querySelectorAll('.adr-consequence').length,
    // Every decision is summarised, and every summary has a picture.
    briefs: document.querySelectorAll('.dec-brief').length,
    diagrams: document.querySelectorAll('.dec-dia svg').length,
    // A diagram is not decoration: it has to say in words what it shows.
    labelled: [...document.querySelectorAll('.dec-dia svg')]
      .every((s) => (s.getAttribute('aria-label') ?? '').length > 20),
    collapsed: document.querySelectorAll('.adr-prose').length,
  }));

  // One card per ADR, and nothing else.
  check('17. /decisions shows every ADR', got.cards === ADRS.length,
    `${got.cards} cards vs ${ADRS.length} ADRs`);
  check('17b. newest decision first', got.first === ADRS[ADRS.length - 1].title, got.first);
  check('17c. every card states its consequence',
    got.consequences === ADRS.length, String(got.consequences));
  check('17d. every decision has a brief and a diagram',
    got.briefs === ADRS.length && got.diagrams === ADRS.length,
    `${got.briefs} briefs, ${got.diagrams} diagrams`);
  check('17e. every diagram carries a text alternative', got.labelled);
  check('17f. the full prose starts collapsed', got.collapsed === 0, String(got.collapsed));

  // Opening one renders the record, and the markdown parser still works.
  await dec.evaluate(() => document.querySelector('.dec-more').click());
  await dec.waitForSelector('.adr-prose', { timeout: 10_000 });
  const opened = await dec.evaluate(() => ({
    tables: document.querySelectorAll('.md-table').length,
    code: document.querySelectorAll('.md-pre').length,
    // Every rendered block, not just paragraphs: a record written as bullets
    // and a table is as fully rendered as one written as prose.
    blocks: document.querySelectorAll('.adr-prose > *').length,
    raw: document.body.innerText.includes('**') || document.body.innerText.includes(']('),
  }));
  check('17h. opening a card renders its record', opened.blocks > 3, `${opened.blocks} blocks`);
  check('17i. code and tables survived the parser',
    opened.code > 0 || opened.tables > 0, `${opened.tables} tables, ${opened.code} code blocks`);
  // The giveaway that a token never got mapped to an element.
  check('17j. no unrendered markdown leaked through', opened.raw === false);

  // An in-page jump has to land AND open, because the panel links to one to
  // justify a claim -- arriving at a collapsed summary answers nothing.
  await dec.goto(`${BASE}/decisions#adr-016`, { waitUntil: 'domcontentloaded' });
  await dec.waitForSelector('#adr-016 .adr-prose', { timeout: 10_000 });
  check('17k. a deep link opens the record it points at', true);
  await dec.close();
}

// ---- the measured chart -----------------------------------------------------
{
  const bars = await page.$$eval('.chart .bar', (els) => els.map((e) => e.innerText.trim()));
  const days = await page.$$eval('.chart .day', (els) => els.map((e) => e.innerText.trim()));
  check('7. chart shows seven measured ratios', bars.length === 7, bars.join(' '));
  check('7b. ratios match tools/measure-delta.mjs',
    bars.join(',') === '3×,6×,16×,31×,62×,154×,408×', bars.join(','));
  check('7c. x axis is document size', days.join(',') === '1K,2K,5K,10K,20K,50K,100K', days.join(','));
  const hot = await page.$$eval('.chart .bar.hot', (els) => els.length);
  check('7d. only the largest bar is highlighted', hot === 1, `${hot} highlighted`);

  // A ratio between two things the page never named is a chart nobody can
  // read. The panel has to say what is actually sent on a reconnect.
  const why = await page.$eval('.insights-why', (e) => e.innerText.trim()).catch(() => '');
  check('7e. and the panel says why the delta is smaller',
    /reconnect/i.test(why) && /(updates|missing)/i.test(why), why.slice(0, 60));

  /*
   * The axis has to be INSIDE the card, at every layout.
   *
   * responsive-test.mjs excludes bottom overflow on purpose -- the hero's
   * front window bleeds off its card by design -- so a chart pushed past its
   * own bottom edge is exactly the regression neither harness could see.
   * Adding the paragraph above cost the tablet cell 3.4px of axis, which is
   * how this check came to exist.
   */
  const axis = await page.evaluate(() => {
    const card = document.querySelector('.insights').getBoundingClientRect();
    const days = [...document.querySelectorAll('.chart .day')];
    return Math.max(...days.map((d) => d.getBoundingClientRect().bottom)) - card.bottom;
  });
  check('7f. the axis sits inside its card', axis <= 0, `${axis.toFixed(1)}px past the edge`);
}

// ---- the search field is real ----------------------------------------------
//
// The field drops no menu of matching titles, so the matching is checked
// through what it does instead -- type a name, press Enter, land in that
// document rather than in a second one with the same name.
//
// The landing page also shows only documents this browser owns or has
// opened. `marker` was created over a raw socket from node, which makes it
// somebody else's unowned document as far as this browser is concerned, so it
// is invisible until the browser has actually been there. That is the rule,
// not an accident, so it is asserted in both directions.
{
  await page.click('.bar-search input');
  await page.type('.bar-search input', marker, { delay: 8 });
  await sleep(400);
  const panel = await page.$eval('.intro', (e) => e.innerText);
  check('8. the panel never lists document names', !panel.includes(marker),
    panel.replace(/\n/g, ' | '));

  // Open it once, the way following a link would, and it becomes a document
  // this browser knows about.
  await page.goto(`${BASE}/doc?doc=${marker}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  await sleep(1200);

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.bar-search input');
  await settled(page);

  /*
   * The palette can only MATCH a document it has been told about, and it is
   * told by `/api/docs` filtered through `listable()` -- which requires the
   * document to have indexed text. Indexing is debounced two seconds behind
   * the last keystroke and is now a Postgres round trip on top of that, and
   * the palette itself refetches on a five-second timer.
   *
   * Pressing Enter before all of that has happened does not fail loudly: with
   * no match, the field CREATES a document with the typed name, which opens an
   * empty editor. The check then reports "" and looks like a sync failure when
   * the palette simply had not heard of the document yet.
   *
   * So wait for the server to list it before typing.
   */
  await page.waitForFunction(async (id) => {
    const res = await fetch(`http://localhost:8080/api/docs`);
    if (!res.ok) return false;
    const body = await res.json();
    return (body.docs ?? []).some((d) => d.docId === id && (d.chars ?? 0) > 0);
  }, { timeout: 30_000, polling: 500 }, marker).catch(() => { /* assert below */ });

  /*
   * ...and then wait for THIS PAGE to have it, which is not the same thing.
   *
   * The check above proves the server lists the document. The palette matches
   * against its own copy of that list, refetched on a five-second timer, so a
   * fixed `sleep` here would be a bet that a poll lands inside it. When it
   * does not, Enter finds no match, creates a document named after the marker,
   * and the assertion reports "" as though sync had failed.
   *
   * Reloading makes the mount fetch the one to wait on rather than waiting up
   * to five seconds for the next poll, and waiting for a RESPONSE that
   * actually carries the marker replaces the guess with a precondition.
   * `topMatch` is derived state with no DOM of its own (Landing.jsx), so the
   * network is the only honest signal there is.
   */
  const listedInPage = page.waitForResponse(async (res) => {
    try {
      if (new URL(res.url()).pathname !== '/api/docs') return false;
      const body = await res.json();
      return (body.docs ?? []).some((d) => d.docId === marker);
    } catch { return false; }
  }, { timeout: 30_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await listedInPage;
  await page.waitForSelector('.bar-search input');
  await settled(page);
  // One render commit for setDocs, not a guess about the network.
  await sleep(250);

  await page.click('.bar-search input');
  await page.type('.bar-search input', marker, { delay: 8 });
  await Promise.all([
    page.waitForSelector('.cm-content', { timeout: 15_000 }),
    page.keyboard.press('Enter'),
  ]);

  let text = '';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    text = await page.$eval('.cm-content', (el) => el.innerText.trim());
    if (text.includes('created for the landing listing')) break;
    await sleep(200);
  }
  /*
   * The detail names WHICH failure this is, because "" alone cannot tell them
   * apart and the two have different causes:
   *
   *   opened=<marker>  the match worked and the document had not synced yet
   *                    -- a latency problem, not a matching one
   *   opened=<other>   no match was found, so Enter created a new document
   *                    named after what was typed
   */
  const opened = new URL(page.url()).searchParams.get('doc');
  check('9. Enter opens the document that matches what you typed',
    text.includes('created for the landing listing'),
    `opened=${opened} wanted=${marker} text=${JSON.stringify(text)}`);
}

// ---- typing an unknown name offers to create it -----------------------------
{
  // Unique per run: this test CREATES the document, so a fixed name exists on
  // the second run and the create row correctly stops appearing.
  const fresh = `brand-new-${Date.now().toString(36)}`;
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.bar-search input');
  await settled(page);
  await page.click('.bar-search input');
  await page.type('.bar-search input', fresh, { delay: 8 });
  await sleep(300);
  await Promise.all([
    page.waitForSelector('.cm-content', { timeout: 15_000 }),
    page.keyboard.press('Enter'),
  ]);
  check('10. an unknown name is created rather than searched for',
    page.url().includes(fresh), page.url());
  const madeTitle = await titleAfterHello(page, new URL(page.url()).searchParams.get('doc'));
  check('10b. and it keeps the name that was typed', madeTitle === fresh, madeTitle);
}

// ---- the demonstration is the way into the lab ------------------------------
//
// It was the centre panel that carried this link; the band across the foot
// carries it now, and for a better reason -- a reader who has just watched the
// partition play out is the one with a question the lab answers.
{
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.demo-strip');
  await settled(page);
  await Promise.all([
    page.waitForSelector('.pane', { timeout: 15_000 }),
    page.click('.demo-strip .strip-lede'),
  ]);
  check('11. the demo band opens the lab', (await page.$$('.pane')).length === 2);
}

// ---- entrance choreography ---------------------------------------------------
{
  const fresh = await browser.newPage();
  await fresh.setViewport({ width: 1512, height: 820 });
  await fresh.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

  // Sample the root class over the life of the animation.
  const seen = await fresh.evaluate(async () => {
    const found = new Set();
    for (let i = 0; i < 130; i++) {
      for (const c of document.documentElement.classList) found.add(c);
      await new Promise((r) => setTimeout(r, 25));
    }
    return { seen: [...found], final: document.documentElement.className };
  });
  check('12. the entrance runs', seen.seen.includes('entrance-run'), seen.seen.join(' '));
  check('12b. animation classes detach afterwards',
    !seen.final.includes('entrance-run') && !seen.final.includes('motion-pending'),
    `final="${seen.final}"`);
  check('12c. the mosaic class stays for the route', seen.final.includes('mosaic'), seen.final);

  const opacity = await fresh.$eval('.intro', (e) => getComputedStyle(e).opacity);
  check('12d. panels end fully visible', opacity === '1', opacity);
  await fresh.close();
}

// ---- reduced motion skips it entirely ---------------------------------------
{
  const rm = await browser.newPage();
  await rm.setViewport({ width: 1512, height: 820 });
  await rm.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await rm.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await rm.waitForSelector('.stage');
  await sleep(300);
  const vis = await rm.$$eval('.card', (els) =>
    els.every((e) => getComputedStyle(e).opacity === '1' && getComputedStyle(e).visibility === 'visible'));
  check('13. reduced motion shows everything immediately', vis);
  await rm.close();
}

// ---- the root font-size knob must not leak to other routes ------------------
{
  await page.goto(`${BASE}/doc?doc=knob-check`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cm-content', { timeout: 15_000 });
  const cls = await page.evaluate(() => document.documentElement.className);
  const size = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  check('14. the editor route does not inherit the mosaic scale',
    !cls.includes('mosaic') && parseFloat(size) > 8, `class="${cls}" font-size=${size}`);
  // The landing boot must not attach its class (or its fail-safe timer) to a
  // route that has no mosaic to reveal.
  check('14b. the editor route has no entrance classes at all',
    cls.trim() === '', `class="${cls}"`);
}

// ---- 16. the panel's document buttons --------------------------------------
//
// The palette only helps if you already know a document's name. These are the
// documents themselves, one click each, plus the way to make a new one.
//
// Run in its own browser context: the session token lives in localStorage, and
// every check above this line is deliberately signed out.
{
  const stamp = Date.now();
  const ctx = await browser.createBrowserContext();
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push('[signed-in] ' + e.message));
  await p2.setViewport({ width: 1400, height: 900 });

  await p2.goto(BASE + '/docs', { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.account-btn', { timeout: 15000 });
  await p2.click('.account-btn');
  await p2.waitForSelector('.account-form');
  await p2.$$eval('.account-tabs button',
    (els) => els.find((e) => e.textContent.includes('Create account'))?.click());
  await sleep(200);
  const ins = await p2.$$('.account-form input');
  await ins[0].type(`land-${stamp}@example.com`);
  await ins[1].type('Ada');
  await ins[2].type('lovelace1');
  await p2.$eval('.account-form button[type=submit]', (b) => b.click());
  await p2.waitForSelector('.account-chip', { timeout: 15000 });
  await sleep(600);

  // Signed in with nothing yet: the create button is the only action offered.
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.intro-do', { timeout: 15000 });
  await sleep(1200);
  check('16. a signed-in visitor is offered a create button',
    !!(await p2.$('.intro-new')));
  check('16b. and nothing else -- the panel does not list documents',
    (await p2.$$('.lede-doc')).length === 0);

  // Creating from the panel opens the new document.
  const TITLE = `Panel doc ${stamp}`;
  await p2.click('.bar-search input');
  await p2.type('.bar-search input', TITLE);
  await sleep(300);
  await p2.evaluate(() => document.querySelector('.intro-new').click());
  await p2.waitForSelector('.cm-content', { timeout: 20000 });
  await sleep(900);
  const created = await titleAfterHello(p2, new URL(p2.url()).searchParams.get('doc'));
  check('16c. the create button makes a titled document', created === TITLE, created);

  // Having a document does NOT put it on the panel: the panel is a way in,
  // not a listing, and the listing is one link away.
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('.intro-do', { timeout: 15000 });
  await sleep(1400);
  check('16d. a document you own does not appear on the panel',
    (await p2.$$('.intro ul, .intro ol')).length === 0);

  const panelText = await p2.$eval('.intro', (e) => e.innerText);
  check('16d-ii. and its name is nowhere on the card',
    !panelText.includes(TITLE), panelText.replace(/\n/g, ' | '));

  // The link to the listing is the way to it.
  await Promise.all([
    p2.waitForNavigation({ timeout: 15000 }),
    p2.click('.docs-link'),
  ]);
  check('16e. the panel links to the documents page',
    new URL(p2.url()).pathname === '/docs', p2.url());

  await ctx.close();
}


check('15. no page errors', errors.length === 0, errors.slice(0, 2).join(' ;; '));

if (process.env.SHOT) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.stage');
  await settled(page);
  await page.screenshot({ path: process.env.SHOT });
}
if (HEADFUL) await sleep(20_000);
await browser.close();

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
