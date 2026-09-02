/**
 * The algebraic laws OT correctness actually rests on, and a generator of
 * random operations to test them against.
 *
 * This lived inside `tools/ot-properties.mjs`, which ran it in CI and nowhere
 * else. It moved here so that the `/correctness` page can run the *same
 * definitions* in the visitor's browser rather than a second implementation
 * that agrees with this one until the day it quietly does not. There is one
 * statement of each law in this repository and both callers import it.
 *
 *   TP1        a.compose(b') === b.compose(a')      the convergence property
 *   compose    apply(apply(d, a), b) === apply(d, a.compose(b))
 *   roundtrip  fromJSON(toJSON(op)) === op
 *
 * TP1 is the one that matters. It says: if the server applied [a then b'] and
 * a client applied [b then a'], they end up with the same document. Every
 * other piece of the OT server is bookkeeping in service of that guarantee.
 *
 * Pure: no I/O, no timers, no `console`. The CLI prints, the page renders, and
 * this decides what is true.
 */
import { TextOperation } from './text-operation.js';

const ALPHABET = 'abcdefg \n';

/**
 * A seedable generator.
 *
 * `Math.random` cannot be replayed, so a failure found in a browser could be
 * reported but never reproduced. mulberry32 is eight lines, and it means a
 * counterexample can be handed back as a seed that regenerates it exactly --
 * which is the difference between "it failed once on someone's laptop" and a
 * bug report.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomString(rand, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

/** A random operation that is valid against a document of length `docLength`. */
export function randomOperation(rand, docLength) {
  const randInt = (n) => Math.floor(rand() * n);
  const op = new TextOperation();
  let left = docLength;
  while (left > 0) {
    const chunk = 1 + randInt(Math.min(left, 6));
    switch (randInt(3)) {
      case 0: op.retain(chunk); left -= chunk; break;
      case 1: op.insert(randomString(rand, 1 + randInt(5))); break;
      case 2: op.delete(chunk); left -= chunk; break;
    }
  }
  // Half the time, end with a trailing insert -- inserts at the very end of a
  // document are a classic off-by-one in transform implementations.
  if (randInt(2) === 0) op.insert(randomString(rand, 1 + randInt(4)));
  return op;
}

/**
 * Run every law `iterations` times against freshly generated documents.
 *
 * Returns counts and, on failure, the first counterexample with the seed that
 * produced it. Never throws for a law violation -- a violation is the result,
 * not an error. It will propagate a genuine crash from inside the algorithm,
 * which is also a finding.
 *
 * @param {{iterations?: number, seed?: number}} opts
 */
export function runProperties({ iterations = 500, seed = Date.now() >>> 0 } = {}) {
  const rand = mulberry32(seed);
  const randInt = (n) => Math.floor(rand() * n);

  const laws = {
    'TP1 convergence': 0,
    'TP1 composition identity': 0,
    'compose': 0,
    'JSON round-trip': 0,
  };
  const failures = [];
  let checked = 0;

  const fail = (law, detail) => failures.push({ law, seed, ...detail });

  for (let i = 0; i < iterations; i++) {
    const doc = randomString(rand, randInt(40));

    // ---- compose law -----------------------------------------------------
    {
      const a = randomOperation(rand, doc.length);
      const afterA = a.apply(doc);
      const b = randomOperation(rand, afterA.length);

      const sequential = b.apply(afterA);
      const composed = a.compose(b).apply(doc);
      if (sequential !== composed) {
        fail('compose', {
          doc, a: a.toString(), b: b.toString(),
          left: sequential, right: composed,
        });
      }
      laws.compose++;
      checked++;
    }

    // ---- TP1: the convergence property -----------------------------------
    {
      const a = randomOperation(rand, doc.length);
      const b = randomOperation(rand, doc.length);
      const [aPrime, bPrime] = TextOperation.transform(a, b);

      // Path 1: apply a, then the rebased b.
      const viaA = bPrime.apply(a.apply(doc));
      // Path 2: apply b, then the rebased a.
      const viaB = aPrime.apply(b.apply(doc));

      if (viaA !== viaB) {
        fail('TP1 convergence', {
          doc, a: a.toString(), b: b.toString(), left: viaA, right: viaB,
        });
      }
      laws['TP1 convergence']++;
      checked++;

      // The same law stated over composition rather than application.
      if (!a.compose(bPrime).equals(b.compose(aPrime))) {
        fail('TP1 composition identity', {
          doc, a: a.toString(), b: b.toString(),
          left: a.compose(bPrime).toString(), right: b.compose(aPrime).toString(),
        });
      }
      laws['TP1 composition identity']++;
      checked++;
    }

    // ---- serialisation round-trip ----------------------------------------
    {
      const a = randomOperation(rand, doc.length);
      const back = TextOperation.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
      if (!a.equals(back)) {
        fail('JSON round-trip', { a: a.toString(), left: a.toString(), right: back.toString() });
      }
      laws['JSON round-trip']++;
      checked++;
    }
  }

  return { seed, iterations, checked, laws, failures };
}
