/**
 * Images and tables under concurrency, on BOTH engines.
 *
 * ADR-013 makes one claim and this file exists to check it: images and tables
 * needed no new concurrency machinery, because neither introduces structure.
 * An image is one character; a table is a run of lines with separated cells.
 *
 * So the assertions are deliberately the ones you would write for plain text,
 * pointed at blocks:
 *
 *   - typing before an image leaves the image where it was, relative to words
 *   - deleting an image is a one-character delete and merges like one
 *   - two clients typing in DIFFERENT cells of one row both survive
 *   - two clients typing in the SAME cell merge character by character
 *   - adding a row while someone types in another row keeps both
 *
 * If any of those needed special handling, the design in ADR-013 would be
 * wrong. None of them do, and nothing in this file touches an engine directly.
 *
 *   node tools/blocks-test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { EMBED_CHAR, CELL_SEPARATOR, RichTextOperation } from '../shared/ot/src/index.js';
import { YjsSync } from '../frontend/src/sync/yjs-sync.js';
import { OTSync } from '../frontend/src/sync/ot-sync.js';
import { scratchSchemas, scratchEnv, resetSchemas } from './test-schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ENGINES = [
  { engine: 'yjs', port: 8108, Sync: YjsSync },
  { engine: 'ot', port: 8109, Sync: OTSync },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  fs.writeSync(1, '  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name +
    (detail ? '  -- ' + detail : '') + String.fromCharCode(10));
  ok ? pass++ : fail++;
};

const guard = setTimeout(() => { console.error('\nTIMED OUT\n'); process.exit(2); }, 120_000);
guard.unref?.();

function boot({ engine, port, schema, accountsSchema }) {
  const p = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: {
      ...process.env,
      ...scratchEnv({ schema, accountsSchema, port: port, engine: engine }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write('    [server] ' + d));
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(p); });
  });
}

/** Readable output: the block characters are invisible and confuse a diff. */
const show = (text) => JSON.stringify(
  text.split(CELL_SEPARATOR).join('|').split(EMBED_CHAR).join('[img]'));

async function run({ engine, port, Sync }) {
  const wsUrl = `ws://localhost:${port}`;
  const { schema, accountsSchema } = scratchSchemas('blocks', engine);
  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);

  console.log(`\n--- ${engine.toUpperCase()} ---\n`);
  const server = await boot({ engine, port, schema, accountsSchema });

  let docCounter = 0;
  const connectPair = async () => {
    const docId = `blocks-${engine}-${Date.now()}-${docCounter++}`;
    const make = async (id) => {
      const c = new Sync({ url: wsUrl, docId, clientId: id });
      c.socketFactory = () => new WebSocket(
        `${wsUrl}?doc=${encodeURIComponent(docId)}&client=${encodeURIComponent(id)}`);
      await c.connect();
      return c;
    };
    return [await make('alice'), await make('bob')];
  };

  // The two write paths, as the editor would drive them.
  const typeAt = (c, at, text) => {
    if (engine === 'yjs') c.text.insert(at, text);
    else c.applyLocal(new RichTextOperation()
      .retain(at).insert(text).retain(c.doc.length - at));
  };
  const deleteAt = (c, at, length) => {
    if (engine === 'yjs') c.text.delete(at, length);
    else c.applyLocal(new RichTextOperation()
      .retain(at).delete(length).retain(c.doc.length - at - length));
  };

  // ---- images ---------------------------------------------------------------
  {
    const [alice, bob] = await connectPair();
    typeAt(alice, 0, 'before ' + EMBED_CHAR + ' after');
    await sleep(400);
    alice.format(7, 8, { image: 'https://x.test/a.png' });
    await sleep(400);

    // "before " (7) + the image (1) + " after" (6). The point of the check is
    // the 1, not the 14: the embed occupies a single position.
    check('1. an image is one character', alice.getText().length === 14,
      `${alice.getText().length} chars`);
    check('1b. and it reaches the other client',
      bob.getText() === alice.getText(), show(bob.getText()));

    const attrs = bob.getRichText().runs.find((r) => r.text.includes(EMBED_CHAR))?.attributes;
    check('1c. carrying its source', attrs?.image === 'https://x.test/a.png',
      JSON.stringify(attrs));

    // The claim: an image is an index like any other.
    typeAt(bob, 0, '>>> ');
    await sleep(500);
    check('2. typing before an image shifts it, on both replicas',
      alice.getText() === bob.getText()
      && alice.getText().indexOf(EMBED_CHAR) === 11,
      show(alice.getText()));

    const stillThere = alice.getRichText().runs
      .find((r) => r.text.includes(EMBED_CHAR))?.attributes?.image;
    check('2b. and it keeps its source across the merge',
      stillThere === 'https://x.test/a.png', String(stillThere));

    // Concurrent: alice deletes the image while bob types elsewhere.
    deleteAt(alice, 11, 1);
    typeAt(bob, bob.getText().length, '!');
    await sleep(600);
    check('3. deleting an image merges with a concurrent edit',
      alice.getText() === bob.getText() && !alice.getText().includes(EMBED_CHAR),
      show(alice.getText()));

    alice.destroy(); bob.destroy();
  }

  // ---- tables ---------------------------------------------------------------
  {
    const [alice, bob] = await connectPair();
    // Two rows, two cells each: "a|b\nc|d\n"
    const row = ['', ''].join(CELL_SEPARATOR);
    typeAt(alice, 0, row + '\n' + row + '\n');
    await sleep(400);
    alice.format(1, 2, { table: 't1' });
    alice.format(3, 4, { table: 't1' });
    await sleep(500);

    check('4. a table is lines and separators, nothing else',
      alice.getText() === CELL_SEPARATOR + '\n' + CELL_SEPARATOR + '\n',
      show(alice.getText()));

    const rowAttrs = bob.getRichText().runs
      .filter((r) => r.attributes?.table).length;
    check('4b. the row attribute reaches the other client', rowAttrs > 0,
      `${rowAttrs} run(s) carry it`);

    // THE test. Two people, one row, different cells, at the same time.
    typeAt(alice, 0, 'left');
    typeAt(bob, 1, 'right');
    await sleep(700);
    check('5. two clients typing in DIFFERENT cells of one row both survive',
      alice.getText() === bob.getText()
      && alice.getText().includes('left') && alice.getText().includes('right'),
      show(alice.getText()));

    const cells = alice.getText().split('\n')[0].split(CELL_SEPARATOR);
    check('5b. and each word stayed in its own cell',
      cells.length === 2 && cells[0].includes('left') && cells[1].includes('right'),
      JSON.stringify(cells));

    alice.destroy(); bob.destroy();
  }

  // ---- same cell, and structural edits ---------------------------------------
  {
    const [alice, bob] = await connectPair();
    typeAt(alice, 0, CELL_SEPARATOR + '\n');
    await sleep(300);
    alice.format(1, 2, { table: 't2' });
    await sleep(400);

    typeAt(alice, 0, 'AAA');
    typeAt(bob, 0, 'BBB');
    await sleep(700);
    const merged = alice.getText().split(CELL_SEPARATOR)[0];
    check('6. two clients typing in the SAME cell merge, losing nothing',
      alice.getText() === bob.getText()
      && merged.length === 6
      && [...'AAA'].every((c) => merged.includes(c)),
      show(alice.getText()));

    // A structural edit -- adding a row -- concurrent with typing.
    const firstNewline = alice.getText().indexOf('\n');
    typeAt(alice, firstNewline, '\n' + CELL_SEPARATOR);
    typeAt(bob, 0, 'z');
    await sleep(700);
    check('7. adding a row while someone types keeps both',
      alice.getText() === bob.getText()
      && alice.getText().split('\n').length === 3
      && alice.getText().includes('z'),
      show(alice.getText()));

    alice.destroy(); bob.destroy();
  }

  server.kill();
  await sleep(300);
  // A clean slate: the scratch schema is dropped and recreated.
  // See tools/test-schema.mjs.
  await resetSchemas(schema, accountsSchema);
}

console.log('\nImages and tables under concurrency, both engines\n');
for (const spec of ENGINES) await run(spec);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
