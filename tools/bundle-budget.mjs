/**
 * Assert a ceiling on what the browser has to download.
 *
 * There is an irony this file exists to remove. A benchmark measures bytes on
 * the wire per keystroke to a fraction of a percent, the landing page renders
 * a live counter of them, and ADR-016 turned on a whole batching layer to move
 * that number by 1.3x -- while the app shipped an unmeasured bundle that
 * dwarfs every byte either of them counts. A reader is entitled to ask what
 * the delta-sync chart is worth if loading the page that draws it costs more
 * than a year of typing.
 *
 * So: a budget, checked in, enforced in CI, in the same spirit as
 * `generate-adr-index.mjs --check`. Not a warning -- Vite already prints one
 * of those and it has been printed on every build for months, which is exactly
 * how much a warning is worth.
 *
 * The numbers below sit roughly 5% above where the bundle actually is, which
 * is deliberate. A budget with 30% headroom is not a budget, it is a comment:
 * it would absorb an accidental import of a date library without a murmur,
 * which is the single thing it exists to catch. This much room allows ordinary
 * feature work and nothing else.
 *
 * When one of these fails the answer is either to make the bundle smaller, or
 * to raise the number ON PURPOSE in a commit that says what grew and why that
 * is worth it.
 *
 *   node tools/bundle-budget.mjs           check, after a build
 *   node tools/bundle-budget.mjs --report  print sizes and exit 0
 */
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'frontend', 'dist', 'assets');

/**
 * Budgets in KB of GZIPPED bytes.
 *
 * Gzipped and not raw, because gzipped is what actually crosses the network --
 * every static host and every CDN in existence serves compressed. Budgeting
 * raw bytes measures a number no user ever waits for.
 */
const BUDGETS = {
  // Raised from 235 when /engines was added: a long-form page explaining how
  // each engine reconciles concurrent edits, reached from the landing page's
  // engine chips. Prose and markup, no new dependency -- about 2.6 KB of it.
  // Set back to ~5% above actual per the policy above, which is the same
  // headroom 235 gave before the page existed.
  // Lowered from 246 when the four long-form routes were code-split. This is
  // now the ENTRY chunk only -- what somebody opening the front page actually
  // waits for -- and moving /engines and /decisions out of it took about
  // 17 KB gzipped off every first visit. Set back to ~5%
  // above actual, per the policy above.
  js: { limit: 239, why: 'React + CodeMirror 6 + Yjs, in the chunk every visitor downloads. The floor here is CodeMirror and Yjs together; React is not the problem people assume it is.' },
  // Raised from 16 when the landing page was rebuilt around what the project
  // actually demonstrates rather than around a health check. What grew, and
  // why it was worth it:
  //
  //   the hero demo   runs BOTH engines, two rows of two replicas with
  //                   per-engine verdicts and a partition control
  //   crash safety    a panel with a figure, a result sentence and three
  //                   stats
  //   the site nav    a real header -- five routes, a wordmark and a CSS mark
  //                   -- so every route on the site is reachable from every
  //                   other one
  //
  // That is four surfaces and one whole new page for 0.7 KB gzipped, which is
  // the trade this budget exists to make visible rather than to forbid. Set
  // back to ~5% above actual, the same headroom 16 gave before any of it.
  //
  // Raised again from 17.5, for three things that each cost a little:
  //
  //   paginated pages   the editor draws US Letter sheets with a real gap
  //                     between them instead of one column that grows for
  //                     ever, which is a repeating background and a break
  //                     block (see pagination.js)
  //   editor chrome     the tab index, the tasks pane and the inspector moved
  //                     onto the landing page's washes, so the document route
  //                     stopped looking like a different product from the
  //                     page that links to it
  //   /engines demo     an interactive explainer of both engines, in its own
  //                     stylesheet: two lanes, character chips carrying their
  //                     ids, and a stage control
  //
  // About 1 KB gzipped for a page rework, a theme conversion and a new
  // interactive. Set back to ~5% above actual, per the policy above.
  //
  // Lowered from 18.6 by the same split: each long-form route now carries its
  // own stylesheet, so the landing page no longer downloads the styles for the
  // decision record or the engine explainer.
  css: { limit: 15.2, why: 'The stylesheet every visitor downloads: landing mosaic, editor with paginated pages, and the lab. The long-form routes bring their own.' },
};

const kb = (bytes) => bytes / 1024;
const fmt = (n) => `${n.toFixed(1)} KB`;

if (!fs.existsSync(dist)) {
  console.error('\nNo build to measure. Run `npm run build` first.\n');
  process.exit(2);
}

/**
 * Entry chunks and route chunks are counted separately.
 *
 * This used to sum every emitted file, on the stated grounds that "chunking is
 * an implementation detail; splitting one 300 KB file into three 100 KB ones
 * downloads the same bytes". That was true while every route was imported
 * eagerly, and it stopped being true the moment the long-form pages became
 * lazy: a route chunk is fetched only by somebody who visits that route. Under
 * the old sum, splitting the bundle -- which made the front page 9 KB smaller
 * -- registered as the bundle getting BIGGER, because the same code now
 * carries per-chunk overhead. A budget that punishes the fix is worse than no
 * budget.
 *
 * So `js` and `css` are what every visitor downloads -- the `index-*` pair --
 * and each lazily-loaded route chunk is held to its own ceiling so one cannot
 * quietly become enormous. Vite emits a stylesheet per lazy route too, which
 * is why this tests the name rather than the extension.
 */
const isEntry = (name) => /^index-/.test(name);

const totals = { js: 0, css: 0 };
const files = [];
const routeChunks = [];
for (const name of fs.readdirSync(dist)) {
  const ext = path.extname(name).slice(1);
  if (ext !== 'js' && ext !== 'css') continue;
  const raw = fs.readFileSync(path.join(dist, name));
  const gz = gzipSync(raw).length;
  if (isEntry(name)) totals[ext] += gz;
  else routeChunks.push({ name, gz });
  files.push({ name, raw: raw.length, gz, ext, lazy: !isEntry(name) });
}

files.sort((a, b) => b.gz - a.gz);

console.log('\nBundle budget\n');
for (const f of files) {
  console.log(`  ${fmt(kb(f.gz)).padStart(9)} gz  ${fmt(kb(f.raw)).padStart(9)} raw   ${f.name}`
    + (f.lazy ? '   (lazy)' : ''));
}
console.log('');

let failed = 0;
for (const [ext, { limit, why }] of Object.entries(BUDGETS)) {
  const actual = kb(totals[ext]);
  const ok = actual <= limit;
  const headroom = limit - actual;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${ext.toUpperCase().padEnd(4)} ${fmt(actual).padStart(9)} `
    + `of ${fmt(limit)}  (${headroom >= 0 ? '' : '+'}${fmt(Math.abs(headroom))} `
    + `${headroom >= 0 ? 'to spare' : 'OVER'})`);
  if (!ok) {
    console.log(`        ${why}`);
    failed++;
  }
}
/*
 * Each lazily-loaded route, separately. Its own ceiling rather than a share of
 * one total: these are independent downloads, and the failure worth catching
 * is one page quietly acquiring a charting library -- which a combined total
 * would hide behind the entry chunk's much larger number.
 */
const ROUTE_LIMIT = 8;
for (const c of routeChunks.sort((a, b) => b.gz - a.gz)) {
  const actual = kb(c.gz);
  const ok = actual <= ROUTE_LIMIT;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  route ${fmt(actual).padStart(9)} of ${fmt(ROUTE_LIMIT)}   ${c.name}`);
  if (!ok) failed++;
}

console.log('');

if (process.argv.includes('--report')) process.exit(0);

if (failed) {
  console.error(
    'Over budget. Either make it smaller, or raise the limit in tools/bundle-budget.mjs\n'
    + 'in a commit that says what got bigger and why that is worth it.\n');
  process.exit(1);
}
process.exit(0);
