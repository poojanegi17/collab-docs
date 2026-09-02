/**
 * The update log must be in the order the engine produced it.
 *
 *   node tools/append-order-test.mjs
 *
 * WHY THIS EXISTS
 *
 * `seq` is the spine of everything built on the log. Compaction preserves it,
 * `archive` reuses it, `fullLog` concatenates archive and updates and orders by
 * it, `stateAt` selects a checkpoint by it, and replay applies updates in it.
 * A log in the wrong order does not fail loudly at write time -- it rebuilds a
 * document that never existed, later, somewhere else.
 *
 * Ordering is not free here, and it is not obvious either. A synchronous
 * write would give it away -- updates land in the order they were made and
 * nothing has to defend it -- but every append here is a network round trip:
 *
 *   - the room's persist callback is fire-and-forget (`void this.persist()`),
 *     because awaiting it would put a network round trip on the keystroke
 *     path, so several appends for one document are in flight at once;
 *   - `seq` is assigned by Postgres when the INSERT executes, not when the
 *     call was made.
 *
 * Those two together mean concurrent appends can be numbered out of order.
 * They were: an early version of the write-through path (`persistWindowMs=0`,
 * which is what every other harness runs with) wrote forty updates and got
 * them back as 0,10,11,12,13,14,15,4,8,3,... The visible symptom was
 * authorship-test dying inside the OT engine with "operation expects a
 * document of length 11, got 6", four files away from the cause.
 *
 * BOTH modes are asserted, because they take different paths through
 * UpdateBuffer and only one of them was broken.
 */
import { config } from '../backend/src/config.js';
import { Store } from '../backend/src/storage/store.js';
import { BufferedStore } from '../backend/src/realtime/update-buffer.js';
import { scratchSchemas, resetSchemas } from './test-schema.mjs';

const { schema } = scratchSchemas('appendorder');
const N = 60;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set. Run `neon env pull` first.');
  process.exit(1);
}

console.log('\nAppend ordering\n');

await resetSchemas(schema);
const base = await new Store({
  connectionString: config.databaseUrl,
  schema,
  adminConnectionString: config.databaseUrlAdmin,
  appRole: config.appRole,
}).init();

for (const windowMs of [0, 25]) {
  await base.db.query('DELETE FROM {updates}');
  const store = new BufferedStore(base, { windowMs });
  const docId = `order-${windowMs}`;

  // Exactly what room.js does with the engine's persist callback: start the
  // write and do not await it.
  const started = [];
  for (let i = 0; i < N; i++) {
    started.push(store.appendUpdate(docId, new Uint8Array([i & 0xff, (i >> 8) & 0xff])));
  }
  await Promise.all(started);

  const rows = await base.db.all(
    'SELECT seq, data FROM {updates} WHERE doc_id = $1 ORDER BY seq', [docId]);
  const order = rows.map((r) => r.data[0] | (r.data[1] << 8));
  const misplaced = order.findIndex((v, i) => v !== i);

  check(`persistWindowMs=${windowMs}: all ${N} appends are present`,
    rows.length === N, `${rows.length} rows`);
  check(`persistWindowMs=${windowMs}: seq order matches call order`,
    misplaced === -1,
    misplaced === -1 ? '' : `first wrong at index ${misplaced}: ${order.slice(0, 16).join(',')}...`);

  // A read must never see a shorter log than the writes that have resolved.
  // This is the invariant BufferedStore's flush-before-read rule exists for.
  const loaded = await store.load(docId);
  check(`persistWindowMs=${windowMs}: a read after the writes sees all of them`,
    loaded.updates.length === N, `${loaded.updates.length} updates`);
}

await base.close();
await resetSchemas(schema);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
