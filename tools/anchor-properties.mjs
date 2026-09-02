/**
 * Property tests for OT ANCHOR transformation -- the positions a comment
 * hangs on.
 *
 * Under the CRDT an anchor is a relative position: it names a character and
 * rides along with it. There is nothing here to prove, because nothing is
 * being computed. Under OT an anchor is an integer index into a document that
 * other people are editing, and it stays correct only if it is transformed
 * against every operation that lands -- which makes it exactly as fragile as
 * an operation and deserving of exactly the same paranoia.
 *
 * The headline result, and the reason ADR-012 puts the OT server in charge of
 * anchors rather than the clients:
 *
 *   Anchor transformation CONVERGES under concurrent insertion and DIVERGES
 *   under concurrent deletion.
 *
 * Deletion is the whole problem. A delete that straddles an anchor destroys
 * the characters that told you where the anchor was, so the anchor collapses
 * onto the delete's start -- and two replicas that collapse it while applying
 * concurrent operations in opposite orders can collapse it to different
 * places. Insertion never destroys that information, which is why the
 * insert-only case is clean.
 *
 * The laws below are therefore split into ones that hold unconditionally, one
 * that holds only without deletes, and one PINNED COUNTEREXAMPLE asserting
 * that the general case really does diverge -- so that nobody later "fixes"
 * the divergence by quietly weakening the test.
 *
 *   bounds        0 <= tp(op, p) <= op.targetLength                 always
 *   monotonic     p <= q  =>  tp(p) <= tp(q)                        always
 *   tracking      the character at p is still under tp(p, right)    always
 *   convergence   tp(b', tp(a,p)) === tp(a', tp(b,p))               inserts only
 *   divergence    the same identity FAILS once deletes are allowed  pinned
 *   stickiness    a range grows only when typed INSIDE; both edges exclusive
 *
 *   node tools/anchor-properties.mjs [iterations]
 */
import { RichTextOperation, RichText } from '../shared/ot/src/index.js';

const ITERATIONS = Number(process.argv[2] ?? 3000);
const NEWLINE = String.fromCharCode(10);
const ALPHABET = 'abcdefg ' + NEWLINE;
const randInt = (n) => Math.floor(Math.random() * n);
const tp = RichTextOperation.transformPosition;

function randomString(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randInt(ALPHABET.length)];
  return s;
}

function randomDocument(n) {
  const doc = new RichText();
  let left = n;
  while (left > 0) {
    const chunk = 1 + randInt(Math.min(left, 7));
    doc.push(randomString(chunk));
    left -= chunk;
  }
  return doc;
}

/** Spans the whole document: there is no implicit trailing retain. */
function randomOperation(docLength, { noDeletes = false } = {}) {
  const op = new RichTextOperation();
  let left = docLength;
  while (left > 0) {
    const chunk = 1 + randInt(Math.min(left, 6));
    switch (randInt(noDeletes ? 3 : 4)) {
      case 0: case 1: op.retain(chunk); left -= chunk; break;
      case 2: op.insert(randomString(1 + randInt(4))); break;
      case 3: op.delete(chunk); left -= chunk; break;
    }
  }
  // Inserts at the very end of a document are a classic off-by-one.
  if (randInt(2) === 0) op.insert(randomString(1 + randInt(3)));
  return op;
}

let checked = 0;
const failures = [];
function fail(law, detail) {
  failures.push({ law, ...detail });
  if (failures.length <= 4) {
    console.error(NEWLINE + `FAIL  ${law}`);
    for (const [k, v] of Object.entries(detail)) console.error(`   ${k}: ${v}`);
  }
}

console.log(NEWLINE + `OT anchor property tests  (${ITERATIONS} iterations)` + NEWLINE);

for (let i = 0; i < ITERATIONS; i++) {
  const doc = randomDocument(1 + randInt(40));
  const a = randomOperation(doc.length);

  for (const stickRight of [true, false]) {
    const p = randInt(doc.length + 1);

    // ---- bounds ---------------------------------------------------------
    {
      const out = tp(a, p, stickRight);
      if (!(out >= 0 && out <= a.targetLength)) {
        fail('bounds', {
          position: p, stickRight, op: a.toString(),
          result: out, targetLength: a.targetLength,
        });
      }
      checked++;
    }

    // ---- monotonic ------------------------------------------------------
    // Order must survive, or a comment's start overtakes its end and the
    // range turns inside out.
    {
      const q = randInt(doc.length + 1);
      const [lo, hi] = p <= q ? [p, q] : [q, p];
      if (tp(a, lo, stickRight) > tp(a, hi, stickRight)) {
        fail('monotonic', {
          lo, hi, stickRight, op: a.toString(),
          'tp(lo)': tp(a, lo, stickRight), 'tp(hi)': tp(a, hi, stickRight),
        });
      }
      checked++;
    }
  }

  // ---- tracking -----------------------------------------------------------
  // The property a user would actually describe: with nothing deleted, the
  // character an anchor sits on is still under it afterwards.
  //
  // Necessarily `stickRight` -- an insert landing exactly ON the anchor has to
  // be stepped over to get back to the original character. With stickLeft the
  // anchor correctly stays put and the character under it is the newly typed
  // one, which is a different law, not a broken one.
  {
    const insertOnly = randomOperation(doc.length, { noDeletes: true });
    const p = randInt(doc.length);
    const before = doc.toString()[p];
    const after = insertOnly.apply(doc).toString()[tp(insertOnly, p, true)];
    if (before !== after) {
      fail('tracking', {
        doc: JSON.stringify(doc.toString()), position: p,
        op: insertOnly.toString(),
        expected: JSON.stringify(before), got: JSON.stringify(after),
      });
    }
    checked++;
  }

  // ---- convergence, inserts only ------------------------------------------
  // Two replicas see two concurrent insertions in opposite orders. They must
  // agree about where the anchor ended up, or one comment highlights two
  // different pieces of text in two browsers showing identical documents.
  {
    const a2 = randomOperation(doc.length, { noDeletes: true });
    const b2 = randomOperation(doc.length, { noDeletes: true });
    const [a2Prime, b2Prime] = RichTextOperation.transform(a2, b2);

    for (const stickRight of [true, false]) {
      const p = randInt(doc.length + 1);
      const viaA = tp(b2Prime, tp(a2, p, stickRight), stickRight);
      const viaB = tp(a2Prime, tp(b2, p, stickRight), stickRight);
      if (viaA !== viaB) {
        fail('convergence (inserts only)', {
          doc: JSON.stringify(doc.toString()), position: p, stickRight,
          a: a2.toString(), b: b2.toString(),
          'a then b-prime': viaA, 'b then a-prime': viaB,
        });
      }
      checked++;
    }
  }
}

// ---- divergence, pinned ---------------------------------------------------
// Deletes break the identity above. This is asserted rather than merely
// tolerated: it is the finding that decides the architecture, and a future
// change that made it converge would be a real result that should have to come
// and edit this test on purpose.
{
  //  doc:  "fgab"
  //  a:    drop "fg", type "b", keep "ab"        -> "bab"
  //  b:    drop the whole document               -> ""
  //
  //  The anchor sits at 1, between 'f' and 'g' -- inside the run that `b`
  //  deletes. Once those characters are gone there is no fact of the matter
  //  about which side of a's inserted "b" it belongs on, and the two replicas
  //  answer differently depending on which operation they applied first.
  const a = new RichTextOperation().delete(2).insert('b').retain(2);
  const b = new RichTextOperation().delete(4);
  const [aPrime, bPrime] = RichTextOperation.transform(a, b);

  const viaA = tp(bPrime, tp(a, 1, true), true);
  const viaB = tp(aPrime, tp(b, 1, true), true);

  if (viaA === viaB) {
    fail('divergence (pinned counterexample)', {
      note: 'concurrent deletes were expected to diverge, but agreed',
      'a then b-prime': viaA, 'b then a-prime': viaB,
      consequence: 'ADR-012 may need revisiting: client-side OT anchors might be safe',
    });
  }
  checked++;

  // Both answers are individually legal -- neither replica is buggy. That is
  // precisely why no amount of care inside `transformPosition` fixes this, and
  // why the OT server transforms anchors once, in its own canonical order, and
  // tells everyone the result (ADR-012).
  for (const [name, value] of [['a then b-prime', viaA], ['b then a-prime', viaB]]) {
    if (!(value >= 0 && value <= 1)) {
      fail('divergence (pinned counterexample)', {
        note: `${name} produced an out-of-range index`, value,
      });
    }
    checked++;
  }
}

// ---- stickiness -----------------------------------------------------------
// Worked examples rather than random ones: this is a product decision about
// what a highlight should do when you type at its edges, and it should be
// readable as a table.
{
  const range = { from: 2, to: 6 };            // "cdef" of "abcdefgh"
  const at = (pos, text) => new RichTextOperation()
    .retain(pos).insert(text).retain(8 - pos);

  const cases = [
    ['typing inside grows the range',     at(4, 'XY'), { from: 2, to: 8 }],
    // Both edges are exclusive. Note the range still covers "cdef" in both
    // of these -- the highlight did not change which characters it is about,
    // which is the point of the rule.
    ['typing at the start edge does not', at(2, 'XY'), { from: 4, to: 8 }],
    ['typing at the end edge does not',   at(6, 'XY'), { from: 2, to: 6 }],
    ['typing before shifts it whole',     at(0, 'XY'), { from: 4, to: 8 }],
    ['typing after leaves it alone',      at(8, 'XY'), { from: 2, to: 6 }],
  ];

  for (const [name, op, want] of cases) {
    const got = RichTextOperation.transformRange(op, range);
    if (!got || got.from !== want.from || got.to !== want.to) {
      fail('stickiness', {
        case: name, expected: JSON.stringify(want), got: JSON.stringify(got),
      });
    }
    checked++;
  }

  // Deleting every commented character orphans the comment rather than
  // collapsing it onto a caret somewhere it was never about.
  const wipe = new RichTextOperation().retain(2).delete(4).retain(2);
  const orphaned = RichTextOperation.transformRange(wipe, range);
  if (orphaned !== null) {
    fail('stickiness', {
      case: 'deleting the whole range orphans it',
      expected: 'null', got: JSON.stringify(orphaned),
    });
  }
  checked++;
}

console.log(`  ${checked} assertions`);
console.log(`  ${failures.length} failures` + NEWLINE);
process.exit(failures.length ? 1 : 0);
