/**
 * Property tests for the ATTRIBUTED OT algorithm.
 *
 * The sibling of `ot-properties.mjs`, and the reasoning is the same: hand-written
 * transform functions fail on cases nobody thinks to write a unit test for, so
 * we generate thousands of random operations and assert the algebraic laws that
 * correctness actually rests on.
 *
 * Attributes add a class of conflict that plain text cannot express, and it is
 * the one worth being paranoid about. Two replicas can converge on identical
 * TEXT while disagreeing about formatting -- a divergence in which nothing
 * looks broken, so no user ever reports it. Every law below therefore compares
 * whole rich documents, never rendered strings.
 *
 *   TP1        applying [a then b'] and [b then a'] yields the same document
 *   compose    apply(apply(d, a), b) === apply(d, a.compose(b))
 *   roundtrip  fromJSON(toJSON(op)) === op
 *   lengths    baseLength/targetLength survive transform and compose
 *
 *   node tools/rich-ot-properties.mjs [iterations]
 */
import { RichTextOperation, RichText } from '../shared/ot/src/index.js';

const ITERATIONS = Number(process.argv[2] ?? 2000);
const NEWLINE = String.fromCharCode(10);
const ALPHABET = 'abcdefg ' + NEWLINE;

/**
 * A deliberately cramped attribute vocabulary. Wide value ranges would make
 * collisions rare, and collisions are the entire point -- we WANT two random
 * operations to fight over the same key constantly.
 *
 * `null` is in the value set on purpose: removal is the case that separates a
 * correct implementation from one that merely looks correct, because it is the
 * only value whose composition is not simply "last writer wins".
 */
const ATTR_KEYS = ['bold', 'italic', 'header'];
const ATTR_VALUES = [true, null, 1, 2];

const randInt = (n) => Math.floor(Math.random() * n);

function randomString(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randInt(ALPHABET.length)];
  return s;
}

/** Sometimes nothing: an op whose every component carried attributes would
 *  never exercise the "formatting untouched" paths. */
function randomAttributes(chanceOfNone = 3) {
  if (randInt(chanceOfNone) === 0) return undefined;
  const attrs = {};
  const count = 1 + randInt(2);
  for (let i = 0; i < count; i++) {
    attrs[ATTR_KEYS[randInt(ATTR_KEYS.length)]] = ATTR_VALUES[randInt(ATTR_VALUES.length)];
  }
  return attrs;
}

/** A random rich document of roughly `n` characters, in several runs. */
function randomDocument(n) {
  const doc = new RichText();
  let left = n;
  while (left > 0) {
    const chunk = 1 + randInt(Math.min(left, 7));
    // Documents never contain null attributes -- null is an operation-only
    // value meaning "remove". Generating one here would test a state the
    // system cannot reach.
    const attrs = randomAttributes();
    const clean = attrs && Object.fromEntries(
      Object.entries(attrs).filter(([, v]) => v !== null));
    doc.push(randomString(chunk), clean && Object.keys(clean).length ? clean : undefined);
    left -= chunk;
  }
  return doc;
}

/**
 * A random operation valid against a document of length `docLength`.
 *
 * Every operation spans the WHOLE document -- there is no implicit trailing
 * retain in this implementation, exactly as in the plain-text one, which is
 * what keeps `baseLength` a real invariant rather than a hint.
 */
function randomOperation(docLength) {
  const op = new RichTextOperation();
  let left = docLength;
  while (left > 0) {
    const chunk = 1 + randInt(Math.min(left, 6));
    switch (randInt(4)) {
      case 0: op.retain(chunk); left -= chunk; break;
      // Two cases out of four retain, one of them with formatting -- format
      // operations are the new thing here and deserve the extra weight.
      case 1: op.retain(chunk, randomAttributes(2)); left -= chunk; break;
      case 2: op.insert(randomString(1 + randInt(5)), randomAttributes()); break;
      case 3: op.delete(chunk); left -= chunk; break;
    }
  }
  // Half the time, end with a trailing insert. Inserts at the very end of a
  // document are a classic off-by-one in transform implementations.
  if (randInt(2) === 0) op.insert(randomString(1 + randInt(4)), randomAttributes());
  return op;
}

let checked = 0;
const failures = [];

function fail(law, detail) {
  failures.push({ law, ...detail });
  if (failures.length <= 3) {
    console.error(String.fromCharCode(10) + `FAIL  ${law}`);
    for (const [k, v] of Object.entries(detail)) console.error(`   ${k}: ${v}`);
  }
}

console.log(String.fromCharCode(10) + `Rich-text OT property tests  (${ITERATIONS} iterations)` +
  String.fromCharCode(10));

for (let i = 0; i < ITERATIONS; i++) {
  const doc = randomDocument(randInt(40));

  // ---- compose law -------------------------------------------------------
  {
    const a = randomOperation(doc.length);
    const afterA = a.apply(doc);
    const b = randomOperation(afterA.length);

    const stepwise = b.apply(afterA);
    const composed = a.compose(b).apply(doc);

    if (!stepwise.equals(composed)) {
      fail('compose', {
        doc: doc.toDebugString(),
        a: a.toString(), b: b.toString(),
        'a then b': stepwise.toDebugString(),
        'compose(a,b)': composed.toDebugString(),
      });
    }
    checked++;
  }

  // ---- TP1, the one that matters -----------------------------------------
  {
    const a = randomOperation(doc.length);
    const b = randomOperation(doc.length);
    const [aPrime, bPrime] = RichTextOperation.transform(a, b);

    // Path 1: the server applied a, then the rebased b.
    const viaA = bPrime.apply(a.apply(doc));
    // Path 2: a client applied b, then the rebased a.
    const viaB = aPrime.apply(b.apply(doc));

    if (!viaA.equals(viaB)) {
      fail('TP1 convergence', {
        doc: doc.toDebugString(),
        a: a.toString(), b: b.toString(),
        "a then b'": viaA.toDebugString(),
        "b then a'": viaB.toDebugString(),
        'text equal?': viaA.toString() === viaB.toString(),
      });
    }

    // The same law stated over composition. This is STRICTER than convergence:
    // it demands the two paths produce the same operation, not merely the same
    // document. It holds for plain text, and it is worth asserting here to
    // find out whether attributes break it -- if they do, that is a fact about
    // attributed OT worth knowing rather than a bug to paper over.
    const left = a.compose(bPrime);
    const right = b.compose(aPrime);
    if (!left.equals(right)) {
      fail('TP1 composition identity', {
        doc: doc.toDebugString(),
        a: a.toString(), b: b.toString(),
        'a.compose(bPrime)': left.toString(),
        'b.compose(aPrime)': right.toString(),
        'same document?': left.apply(doc).equals(right.apply(doc)),
      });
    }

    // Transform must preserve the length contract, or the NEXT operation
    // against this document throws instead of silently corrupting it.
    if (a.compose(bPrime).baseLength !== doc.length) {
      fail('length invariant', { doc: doc.length, got: a.compose(bPrime).baseLength });
    }
    checked += 3;
  }

  // ---- serialisation round-trip ------------------------------------------
  {
    const a = randomOperation(doc.length);
    const back = RichTextOperation.fromJSON(JSON.parse(JSON.stringify(a.toJSON())));
    if (!a.equals(back)) {
      fail('JSON round-trip', { a: a.toString(), back: back.toString() });
    }
    checked++;
  }
}

console.log(`  ${checked} assertions across ${ITERATIONS} random documents`);
console.log(`  ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}` +
  String.fromCharCode(10));
process.exit(failures.length === 0 ? 0 : 1);
