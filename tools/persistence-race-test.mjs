/**
 * The races an asynchronous store opens up, one test each.
 *
 *   node tools/persistence-race-test.mjs
 *
 * WHY THIS EXISTS
 *
 * Every one of these bugs is invisible when the database is fast, and every
 * one of them is a silent wrong answer rather than a crash. They share a
 * shape: code that reads correct on the page, and is not, because
 * `Store.appendUpdate` is a network round trip that yields to the event loop
 * half way through.
 *
 * So the delays here are DELIBERATE and load-bearing. Against an instant fake
 * store every one of these tests passes on the broken code and proves nothing.
 * `slowStore` below widens the window enough to lose a race in, which is what
 * a real 20-40ms hop to Neon does on its own.
 *
 * Sections 1-4 use a fake store so the failure can be injected and the
 * interleaving pinned down exactly. Sections 5-7 run against real Postgres at
 * the PRODUCTION window (`persistWindowMs = 25`) rather than the 0 every
 * other harness uses, because 0 bypasses the buffer entirely and 0 is not
 * what is deployed.
 */
import { config } from '../backend/src/config.js';
import { Store } from '../backend/src/storage/store.js';
import { UpdateBuffer, BufferedStore } from '../backend/src/realtime/update-buffer.js';
import { scratchSchemas, resetSchemas } from './test-schema.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Anything that escapes as an unhandled rejection is a failure of this file's
// subject matter, not an unrelated annoyance: the whole point of the retry
// and failure paths is that they are reported to somebody.
const unhandled = [];
process.on('unhandledRejection', (err) => unhandled.push(err));

/**
 * A store that yields like a real one.
 *
 * `failTimes` makes the next N writes throw, which is how the retry and
 * give-up paths are reached without unplugging Neon.
 */
function slowStore({ latencyMs = 20, failTimes = 0 } = {}) {
  const s = {
    written: [],
    calls: 0,
    failures: failTimes,
    async appendUpdates(docId, rows) {
      s.calls++;
      await sleep(latencyMs);
      if (s.failures > 0) { s.failures--; throw new Error('injected write failure'); }
      const seqs = [];
      for (const r of rows) {
        s.written.push(new TextDecoder().decode(r.bytes));
        seqs.push(s.written.length);
      }
      return seqs;
    },
  };
  return s;
}
const enc = (v) => new TextEncoder().encode(String(v));

console.log('\nPersistence races\n');

// ---------------------------------------------------------------------------
console.log('1. flush() must not return before the data is durable');
// The original bug: with a batch in flight and rows queued behind it, two
// concurrent flushes both await the in-flight batch; the first then drains
// the queue, and the second finds it empty and returns having written
// nothing. Its caller -- BufferedStore.load -- then reads a stale document.
{
  const store = slowStore();
  const buf = new UpdateBuffer({ store, windowMs: 25 });

  buf.append('d', enc('r1'));
  const first = buf.flush('d');          // starts the batch holding r1
  await sleep(5);                        // ...and let it get in flight
  buf.append('d', enc('r2'));            // queued behind it

  let sawAtReturn = null;
  const readerA = buf.flush('d');
  const readerB = buf.flush('d').then(() => { sawAtReturn = [...store.written]; });

  await Promise.all([first, readerA, readerB]);
  check('the second concurrent flush waits for the batch the first started',
    sawAtReturn.includes('r2'), `reader B saw [${sawAtReturn}]`);
  check('nothing is left queued afterwards', buf.pending('d') === 0);
}

// ---------------------------------------------------------------------------
console.log('\n2. a failed batch is retried, not stranded');
// The original bug: on failure the rows went back on the queue but no timer
// was re-armed, so they sat there until the next append or shutdown. With no
// further typing, that is where they stayed.
{
  const store = slowStore({ failTimes: 2 });
  const buf = new UpdateBuffer({ store, windowMs: 25 });

  const durable = buf.append('d', enc('a'));
  // Deliberately no further appends: nothing but the retry can rescue this.
  await durable;

  check('the append eventually succeeds after two failures', store.written.includes('a'));
  check('it took more than one attempt', store.calls === 3, `${store.calls} attempts`);
  check('nothing is left queued', buf.pending('d') === 0);
}

// ---------------------------------------------------------------------------
console.log('\n3. order survives a retry');
// Rows go back on the FRONT of the queue. If they went on the back, an append
// that arrived during the failed write would overtake them and the log would
// be permanently out of order -- see append-order-test for why that matters.
{
  const store = slowStore({ failTimes: 1 });
  const buf = new UpdateBuffer({ store, windowMs: 10 });

  const first = buf.append('d', enc('1'));
  await sleep(15);                       // let batch 1 be in flight and fail
  const second = buf.append('d', enc('2'));
  await Promise.all([first, second]);

  check('the retried row is written before the one queued behind it',
    store.written.join(',') === '1,2', `[${store.written}]`);
}

// ---------------------------------------------------------------------------
console.log('\n4. an abandoned batch is reported, not swallowed');
{
  const store = slowStore({ failTimes: 99 });
  const failures = [];
  const buf = new UpdateBuffer({
    store, windowMs: 5, maxAttempts: 3,
    onFailure: (docId, err) => failures.push({ docId, message: err.message }),
  });

  let rejected = null;
  await buf.append('d', enc('x')).catch((err) => { rejected = err; });

  check('the append rejects rather than resolving', rejected !== null,
    rejected?.message ?? 'resolved!');
  check('onFailure fires once with the document id',
    failures.length === 1 && failures[0].docId === 'd', JSON.stringify(failures));
  check('flush() after an abandoned batch does not hang or resolve falsely',
    buf.pending('d') === 0);

  // The un-awaited case: api.js's cold restore path does not await its
  // appends. That must not become an unhandled rejection.
  const store2 = slowStore({ failTimes: 99 });
  const buf2 = new UpdateBuffer({ store: store2, windowMs: 5, maxAttempts: 2 });
  buf2.append('d', enc('y'));            // deliberately not awaited
  await sleep(200);
  check('an un-awaited failed append raises no unhandled rejection',
    unhandled.length === 0, `${unhandled.length} unhandled`);
}

// ---------------------------------------------------------------------------
// From here on: real Postgres, production window.
// ---------------------------------------------------------------------------
if (!config.databaseUrl) {
  console.error('\nDATABASE_URL is not set. Run `neon env pull` first.');
  process.exit(1);
}

const { schema } = scratchSchemas('persistrace');
await resetSchemas(schema);
const base = await new Store({
  connectionString: config.databaseUrl,
  schema,
  adminConnectionString: config.databaseUrlAdmin,
  appRole: config.appRole,
}).init();

/**
 * Wrap the real store so chosen calls yield for longer than Neon does.
 *
 * `currentSeq` is in the list on purpose: the compaction bug is a race
 * between taking a snapshot and READING THE SEQUENCE NUMBER, so widening the
 * seq read is what opens the window. Delay only `appendUpdates` and the buggy
 * code passes.
 */
function delayed(store, delays) {
  return new Proxy(store, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      const ms = delays[prop];
      if (ms === undefined) return value.bind(target);
      return async (...args) => { await sleep(ms); return value.apply(target, args); };
    },
  });
}

console.log('\n5. concurrent appends and flushes against real Postgres (window=25ms)');
{
  const store = new BufferedStore(base, { windowMs: 25 });
  const docId = 'race-concurrent';
  const N = 120;

  // Fire-and-forget appends, exactly as the room's engine callback does,
  // interleaved with reads that must each see everything resolved so far.
  const writes = [];
  const reads = [];
  for (let i = 0; i < N; i++) {
    writes.push(store.appendUpdate(docId, enc(i)));
    if (i % 20 === 19) reads.push(store.load(docId));
    if (i % 7 === 0) await sleep(1);
  }
  await Promise.all([...writes, ...reads]);

  const rows = await base.db.all(
    'SELECT seq, data FROM {updates} WHERE doc_id = $1 ORDER BY seq', [docId]);
  const order = rows.map((r) => Number(new TextDecoder().decode(r.data)));
  check('every append reached Postgres', rows.length === N, `${rows.length}/${N}`);
  check('seq order matches call order',
    order.every((v, i) => v === i), `[${order.slice(0, 12)}...]`);

  const loaded = await store.load(docId);
  check('a read after the writes sees all of them',
    loaded.updates.length === N, `${loaded.updates.length} updates`);
}

console.log('\n6. compaction cannot pair a snapshot with the wrong seq');
// The heart of it. An edit lands DURING compaction's round trip. The old code
// took the snapshot first and read the seq afterwards, so that edit was
// inside `throughSeq` and absent from the snapshot -- and compaction deletes
// exactly the updates at or below `throughSeq`. The check is not "did it
// crash" but "is the update still readable afterwards".
{
  const slow = delayed(base, { appendUpdates: 10, currentSeq: 120 });
  const store = new BufferedStore(slow, { windowMs: 25 });
  const docId = 'race-compact';

  for (let i = 0; i < 10; i++) await store.appendUpdate(docId, enc(`early-${i}`));

  // `makeSnapshot` stands in for the engine: it reports everything appended
  // at the instant it is called, which is exactly what engine.snapshot()
  // does, since the engine has already applied an update by the time the
  // persist callback runs.
  const appended = [];
  let covered = null;
  const compaction = store.compactAtomically(docId, () => {
    covered = new Set(appended);
    return enc(`snapshot-of-${covered.size}`);
  });
  // Append THROUGHOUT the compaction, so some land while the seq is being
  // read. These are the updates the old code destroyed.
  for (let i = 0; i < 6; i++) {
    appended.push(`during-${i}`);
    void store.appendUpdate(docId, enc(`during-${i}`)).catch(() => {});
    await sleep(20);
  }
  const { throughSeq } = await compaction;
  await store.load(docId);   // drains anything still queued

  const live = await base.db.all(
    'SELECT seq, data FROM {updates} WHERE doc_id = $1 ORDER BY seq', [docId]);
  const archived = await base.db.all(
    'SELECT seq FROM {archive} WHERE doc_id = $1 ORDER BY seq', [docId]);
  const survivors = new Set(live.map((r) => new TextDecoder().decode(r.data)));

  // THE INVARIANT, stated exactly. Every update is either inside the
  // snapshot, or still in the live log. An update that is in neither has
  // been deleted by a compaction that did not contain it, and is gone.
  const lost = appended.filter((u) => !covered.has(u) && !survivors.has(u));
  check('no update was deleted by a compaction whose snapshot predates it',
    lost.length === 0,
    lost.length ? `LOST: ${lost.join(', ')}` : `${covered.size} in snapshot, ${survivors.size} live`);
  check('nothing above throughSeq was deleted',
    live.every((r) => Number(r.seq) > throughSeq), `throughSeq=${throughSeq}`);
  check('the compacted updates went to the archive rather than vanishing',
    archived.length >= 10, `${archived.length} archived`);
}

console.log('\n7. two compactions at once cannot undo each other');
// Concurrent persists each crossing the threshold used to start their own
// compaction; the last to commit overwrote the snapshot of the one further
// ahead with an older through_seq, and whatever the winner had already
// archived and deleted was gone from the live log.
{
  const slow = delayed(base, { appendUpdates: 40, currentSeq: 40 });
  const store = new BufferedStore(slow, { windowMs: 25 });
  const docId = 'race-double-compact';

  for (let i = 0; i < 20; i++) await store.appendUpdate(docId, enc(`u-${i}`));

  // Appends CONTINUE while the three compactions run, so each one cuts at a
  // different sequence number. Without that the three cut at the same place,
  // the older-overwrites-newer bug cannot show, and this test proves nothing.
  const extra = [];
  let typing = true;
  const typist = (async () => {
    for (let i = 0; typing && i < 40; i++) {
      extra.push(`x-${i}`);
      void store.appendUpdate(docId, enc(`x-${i}`)).catch(() => {});
      await sleep(15);
    }
  })();

  const results = await Promise.all([
    store.compactAtomically(docId, () => enc('snap-a')),
    store.compactAtomically(docId, () => enc('snap-b')),
    store.compactAtomically(docId, () => enc('snap-c')),
  ]);
  typing = false;
  await typist;
  await store.load(docId);   // drain anything still queued

  const snap = await base.db.one(
    'SELECT through_seq FROM {snapshots} WHERE doc_id = $1', [docId]);
  const live = await base.db.all(
    'SELECT seq FROM {updates} WHERE doc_id = $1 ORDER BY seq', [docId]);
  const highest = Math.max(...results.map((r) => r.throughSeq));

  check('the stored snapshot is the furthest-ahead one',
    Number(snap.through_seq) === highest,
    `stored=${snap.through_seq} highest=${highest}`);
  check('no live update sits at or below the stored through_seq',
    live.every((r) => Number(r.seq) > Number(snap.through_seq)),
    `${live.length} live rows`);

  // The point of the test: archive + updates must still concatenate into the
  // whole history. A compaction that overwrote a newer snapshot with an older
  // through_seq leaves a gap here, because the newer one had already deleted
  // the rows the older one now claims not to cover.
  const whole = await base.fullLog(docId);
  const expected = 20 + extra.length;
  check('the whole log is still reconstructable, with nothing missing',
    whole.length === expected, `${whole.length}/${expected} in archive+updates`);

  const seqs = whole.map((u) => u.seq);
  check('the reconstructed log has no duplicate sequence numbers',
    new Set(seqs).size === seqs.length, `${seqs.length} rows, ${new Set(seqs).size} distinct`);
}

console.log('\n8. a write that fails DURING a compaction still recovers');
// `runExclusive` drains the queue before it hands control to compaction. A
// batch that fails inside that drain re-queues itself and arms a retry -- and
// that retry has to be allowed to run even though an exclusive section is
// open, or the drain waits forever for rows nothing will ever write.
{
  let failNext = 1;
  const flaky = new Proxy(base, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (prop !== 'appendUpdates') return value.bind(target);
      return async (...args) => {
        await sleep(10);
        if (failNext-- > 0) throw new Error('injected mid-drain failure');
        return value.apply(target, args);
      };
    },
  });
  const store = new BufferedStore(flaky, { windowMs: 25 });
  const docId = 'race-fail-during-compact';

  const writes = [];
  for (let i = 0; i < 4; i++) writes.push(store.appendUpdate(docId, enc(`f-${i}`)));

  // Compact immediately, so the drain is what meets the injected failure.
  const compaction = store.compactAtomically(docId, () => enc('snap'));
  const finished = await Promise.race([
    compaction.then(() => 'done'),
    sleep(15_000).then(() => 'DEADLOCK'),
  ]);

  check('compaction completes rather than deadlocking on the retry',
    finished === 'done', finished);
  const settled = await Promise.allSettled(writes);
  check('every append that failed mid-drain was retried to success',
    settled.every((r) => r.status === 'fulfilled'),
    settled.map((r) => r.status).join(','));
  const whole = await base.fullLog(docId);
  check('and all four are in the log',
    whole.length === 4, `${whole.length}/4`);
}

await base.close();
await resetSchemas(schema);

await sleep(50);
check('no unhandled promise rejections in the whole run',
  unhandled.length === 0,
  unhandled.map((e) => e?.message ?? String(e)).join('; '));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
