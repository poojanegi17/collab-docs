/**
 * Property tests for the OT algorithm.
 *
 * Hand-written transform functions fail on cases you would never think to write
 * a unit test for -- overlapping deletes, an insert landing inside a range
 * another op deleted, adjacent inserts at the same offset. So we do not write
 * example tests: we generate thousands of random operations and assert the
 * algebraic laws that OT correctness actually rests on.
 *
 *   TP1        a.compose(b') === b.compose(a')      the convergence property
 *   compose    apply(apply(d, a), b) === apply(d, a.compose(b))
 *   roundtrip  fromJSON(toJSON(op)) === op
 *
 * The laws and the generator themselves now live in `shared/ot/src/
 * properties.js`, because two copies of a correctness argument is one copy
 * too many. This
 * file is the command-line runner: it chooses an iteration count, prints, and
 * decides the exit code. What is true is decided over there.
 *
 *   node tools/ot-properties.mjs [iterations] [--seed=N]
 *
 * `--seed` replays an exact run. Every failure below prints the seed that
 * produced it, so a counterexample found in CI -- or by a visitor clicking
 * "run it again" -- can be reproduced here verbatim.
 */
import { runProperties } from '../shared/ot/src/index.js';

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith('--seed='));
const ITERATIONS = Number(args.find((a) => !a.startsWith('--')) ?? 2000);
const seed = seedArg ? Number(seedArg.split('=')[1]) : (Date.now() >>> 0);

console.log(`\nOT property tests  (${ITERATIONS} iterations, seed ${seed})\n`);

const result = runProperties({ iterations: ITERATIONS, seed });

for (const [law, n] of Object.entries(result.laws)) {
  const bad = result.failures.filter((f) => f.law === law).length;
  console.log(`  ${bad === 0 ? 'PASS' : 'FAIL'}  ${law.padEnd(26)} ${n} checks${bad ? `  (${bad} failed)` : ''}`);
}

for (const f of result.failures.slice(0, 3)) {
  console.error(`\nFAIL  ${f.law}   (replay: --seed=${f.seed})`);
  for (const [k, v] of Object.entries(f)) {
    if (k === 'law' || k === 'seed') continue;
    console.error(`   ${k}: ${JSON.stringify(v)}`);
  }
}

console.log(`\n  ${result.checked} assertions across ${ITERATIONS} random documents`);
console.log(`  ${result.failures.length === 0 ? 'PASS' : `FAIL (${result.failures.length})`}\n`);
process.exit(result.failures.length === 0 ? 0 : 1);
