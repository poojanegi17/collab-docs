/**
 * Measures what a reconnect actually costs, at increasing document sizes.
 *
 * The landing page quotes these numbers, so they are measured rather than
 * asserted. Run it again if the protocol changes and update the figures.
 *
 *   node tools/measure-delta.mjs   (needs: npm run dev:server)
 *
 * Method: fill a document, connect a fresh client, let it sync, disconnect,
 * reconnect, and record the bytes received during that second sync. The client
 * is already up to date, so this is the pure cost of the state-vector
 * handshake -- the floor a reconnect can reach.
 */
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';

const URL_ = process.env.WS_URL ?? 'ws://localhost:8080';
const SIZES = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];

for (const size of SIZES) {
  const docId = `measure-${size}-${Date.now()}`;

  // Fill in chunks: one Yjs update per insert, so this also exercises the log.
  const writer = new YjsSync({ url: URL_, docId, clientId: 'writer' });
  await writer.connect();
  const chunk = 'x'.repeat(250);
  for (let i = 0; i < size / 250; i++) writer.text.insert(writer.text.length, chunk);
  await sleep(600);

  const reader = new YjsSync({ url: URL_, docId, clientId: 'reader' });
  await reader.connect();
  await sleep(400);
  const firstSync = reader.stats.lastSyncRecv;

  // Now reconnect an already-current client.
  reader.disconnect();
  await sleep(300);
  await reader.connect();
  await sleep(400);
  const resync = reader.stats.lastSyncRecv;

  rows.push({
    chars: reader.text.length,
    firstSync,
    resync,
    ratio: reader.text.length / resync,
  });

  writer.destroy();
  reader.destroy();
  await sleep(200);
}

const fmt = (n) => String(n).padStart(9);
console.log('\n  chars      first sync    resync    ratio (doc / resync)');
console.log('  ' + '-'.repeat(56));
for (const r of rows) {
  console.log(`  ${fmt(r.chars)}  ${fmt(r.firstSync)}B ${fmt(r.resync)}B ${fmt(Math.round(r.ratio))}x`);
}
console.log('\n  JSON for the landing page chart:');
console.log('  ' + JSON.stringify(rows.map((r) => ({
  chars: r.chars, resync: r.resync, ratio: Math.round(r.ratio),
}))));
console.log();
process.exit(0);
