/**
 * Rich-text OT: `TextOperation` with attributes.
 *
 * This is a SIBLING of `TextOperation`, not a replacement. The plain-text
 * operation stays exactly as it was -- still used, still property-tested --
 * because attributed OT is genuinely a different algorithm, and folding the
 * two together would have meant weakening the simpler one's invariants to make
 * room. See ADR-006.
 *
 * The component form changes from the flat `number | string` encoding to
 * tagged objects, because attributes need somewhere to live:
 *
 *   { r: 5 }                  retain 5 characters, formatting untouched
 *   { r: 5, a: { b: true } }  retain 5 characters AND apply an attribute change
 *   { i: "hi" }               insert
 *   { i: "hi", a: { b: 1 } }  insert, already formatted
 *   { d: 3 }                  delete 3 characters
 *
 * Note what `{ r: n, a }` buys: formatting is a RETAIN, not a new message type.
 * Bolding a word neither inserts nor deletes text, so it transforms against
 * concurrent typing using machinery that already exists. A dedicated "format"
 * component would have needed its own transform against each of insert, delete
 * and retain -- nine new cases instead of zero.
 *
 * Both invariants from the plain-text version survive unchanged:
 *
 *   baseLength    length of the document this op applies to
 *   targetLength  length of the document that results
 *
 * Attributes never affect either, which is precisely why `transform` below is
 * recognisably the same function as its plain-text counterpart.
 */
import { RichText } from './rich-text.js';
import {
  composeAttributes, transformAttributes, attributesEqual, withoutNulls,
} from './attributes.js';

const isRetain = (c) => c != null && typeof c.r === 'number';
const isInsert = (c) => c != null && typeof c.i === 'string';
const isDelete = (c) => c != null && typeof c.d === 'number';
const lengthOf = (c) => (isInsert(c) ? c.i.length : isRetain(c) ? c.r : c.d);

/**
 * Walks a component list, handing out pieces of whatever size the caller asks
 * for and splitting components as needed.
 *
 * The plain-text version does this inline with a pair of mutable `op1`/`op2`
 * cursors. That worked for three component types encoded as primitives; with
 * objects carrying attributes it became the same six lines of splitting logic
 * copy-pasted into every branch, which is how one branch ends up dropping
 * attributes on a split and nobody notices until a bold range mysteriously
 * ends one character early.
 */
class Iterator {
  constructor(ops) {
    this.ops = ops;
    this.index = 0;
    this.offset = 0;
  }

  hasNext() {
    return this.index < this.ops.length;
  }

  /** Type of the next component, or 'retain' once exhausted. */
  peekType() {
    const c = this.ops[this.index];
    if (!c) return 'retain';
    return isInsert(c) ? 'insert' : isDelete(c) ? 'delete' : 'retain';
  }

  /** Characters left in the next component; Infinity once exhausted. */
  peekLength() {
    const c = this.ops[this.index];
    if (!c) return Infinity;
    return lengthOf(c) - this.offset;
  }

  /**
   * Take up to `wanted` characters. Past the end this yields an unlimited
   * supply of plain retains, which is what lets compose and transform run
   * until BOTH inputs are exhausted without special-casing either tail.
   */
  next(wanted = Infinity) {
    const c = this.ops[this.index];
    if (!c) return { r: wanted === Infinity ? 0 : wanted };

    const offset = this.offset;
    const total = lengthOf(c);
    const take = Math.min(wanted, total - offset);

    if (offset + take >= total) { this.index++; this.offset = 0; }
    else this.offset += take;

    if (isDelete(c)) return { d: take };
    if (isRetain(c)) return c.a ? { r: take, a: c.a } : { r: take };
    const slice = c.i.slice(offset, offset + take);
    return c.a ? { i: slice, a: c.a } : { i: slice };
  }
}

export class RichTextOperation {
  constructor() {
    /** @type {object[]} */
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }

  // ---- building ------------------------------------------------------------

  /**
   * Skip `n` characters. With `attributes`, also change their formatting --
   * which is the entire rich-text extension, in one method.
   */
  retain(n, attributes) {
    if (n <= 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    return this._push(attributes ? { r: n, a: attributes } : { r: n });
  }

  /**
   * Insert text. Unlike a retain's, an insert's attributes are ABSOLUTE --
   * the text is new, so a removal has nothing to remove. Nulls are stripped
   * here rather than trusted from the caller, because a null that reaches a
   * document run makes two replicas converge on the same text with different
   * formatting. See withoutNulls in attributes.js.
   */
  insert(str, attributes) {
    if (str === '') return this;
    const attrs = withoutNulls(attributes);
    this.targetLength += str.length;
    return this._push(attrs ? { i: str, a: attrs } : { i: str });
  }

  delete(n) {
    if (typeof n === 'string') n = n.length;
    if (n < 0) n = -n;
    if (n === 0) return this;
    this.baseLength += n;
    return this._push({ d: n });
  }

  /**
   * Append in canonical form: merge with the previous component when they are
   * the same kind with equal attributes, and keep an insert ahead of an
   * adjacent delete.
   *
   * The insert-before-delete ordering is the same normalisation the plain-text
   * version does, for the same reason -- "delete then insert" and "insert then
   * delete" describe one operation, and two spellings of one operation make
   * `equals` lie.
   */
  _push(component) {
    const ops = this.ops;

    if (isDelete(component)) {
      // Skip back over EVERY trailing insert, not just the last one.
      //
      // Looking back a single component is what the plain-text version does,
      // and there it is correct: without attributes, two adjacent inserts
      // always merge into one, so there is never a run of them. With
      // attributes there is -- insert "a" bold followed by insert "b" plain
      // stays two components -- and a delete arriving after that pair got
      // stranded between the inserts instead of merging with the delete in
      // front of them. The result was two spellings of one operation, which
      // made equality disagree with itself across a JSON round-trip. Found
      // by the property tests; it survived every hand-written case.
      let at = ops.length;
      while (at > 0 && isInsert(ops[at - 1])) at--;

      const before = ops[at - 1];
      if (isDelete(before)) { before.d += component.d; return this; }
      if (at === ops.length) ops.push(component);
      else ops.splice(at, 0, component);
      return this;
    }

    const last = ops[ops.length - 1];
    if (last) {
      if (isRetain(component) && isRetain(last) && attributesEqual(component.a, last.a)) {
        last.r += component.r; return this;
      }
      if (isInsert(component) && isInsert(last) && attributesEqual(component.a, last.a)) {
        last.i += component.i; return this;
      }
    }
    ops.push(component);
    return this;
  }

  isNoop() {
    return this.ops.every((c) => isRetain(c) && !c.a);
  }

  // ---- using ---------------------------------------------------------------

  /**
   * @param {RichText|string} doc
   * @returns {RichText}
   */
  apply(doc) {
    const input = typeof doc === 'string' ? RichText.fromString(doc) : doc;
    if (input.length !== this.baseLength) {
      throw new Error(
        `apply: operation expects a document of length ${this.baseLength}, got ${input.length}`);
    }

    const out = new RichText();
    let at = 0;
    for (const c of this.ops) {
      if (isInsert(c)) {
        out.push(c.i, c.a);
      } else if (isRetain(c)) {
        // Attribute changes apply per-run, so a retain spanning a formatting
        // boundary correctly yields two differently-formatted runs.
        for (const run of input.slice(at, at + c.r).runs) {
          out.push(run.text, composeAttributes(run.attributes, c.a, false));
        }
        at += c.r;
      } else {
        at += c.d;
      }
    }
    return out;
  }

  /**
   * `a.compose(b)` is the single operation equivalent to applying `a` then
   * `b`. Same contract and same purpose as the plain-text version: it is what
   * keeps the client's pending buffer at exactly one operation, however long
   * the server takes to acknowledge.
   */
  compose(other) {
    if (this.targetLength !== other.baseLength) {
      throw new Error(`compose: length mismatch (${this.targetLength} -> ${other.baseLength})`);
    }
    const out = new RichTextOperation();
    const iterA = new Iterator(this.ops);
    const iterB = new Iterator(other.ops);

    while (iterA.hasNext() || iterB.hasNext()) {
      // A delete in `a` was never visible to `b`, so it passes straight
      // through -- and it is checked first, matching TextOperation.compose, so
      // both implementations normalise insert/delete order the same way.
      if (iterA.peekType() === 'delete') { out.delete(lengthOf(iterA.next())); continue; }
      // An insert in `b` did not exist when `a` ran.
      if (iterB.peekType() === 'insert') { const c = iterB.next(); out.insert(c.i, c.a); continue; }

      const length = Math.min(iterA.peekLength(), iterB.peekLength());
      const ca = iterA.next(length);
      const cb = iterB.next(length);

      if (isRetain(cb)) {
        if (isRetain(ca)) {
          // keepNull: an attribute removal in `b` has to survive into the
          // composed operation or it will not remove anything when applied.
          out.retain(length, composeAttributes(ca.a, cb.a, true));
        } else {
          // `a` inserted this text and `b` reformatted it, so the formatting
          // folds into the insert. A removal resolves to plain absence right
          // here -- there is no older document state left for it to strip.
          out.insert(ca.i, composeAttributes(ca.a, cb.a, false));
        }
      } else if (isDelete(cb) && isRetain(ca)) {
        out.delete(length);
      }
      // isDelete(cb) && isInsert(ca): `b` deletes what `a` just inserted. The
      // two cancel and nothing is emitted.
    }
    return out;
  }

  /**
   * THE function, in its attributed form.
   *
   * Given `a` and `b` written against the SAME document, return `[a', b']`
   * such that `a.compose(b')` and `b.compose(a')` produce the same document.
   * That is TP1, the convergence property, and everything else in the OT
   * server is bookkeeping in service of it.
   *
   * Two tie-breaks, both resolved in `a`'s favour, both unconditional:
   *
   *   position    concurrent inserts at one offset put `a`'s text first
   *   attribute   concurrent changes to one attribute keep `a`'s value
   *
   * Arbitrary, but they MUST be consistent across replicas, which is why this
   * system is server-authoritative: the server is always argument `a`, so
   * every client resolves both ties identically.
   *
   * The second tie-break has no plain-text analogue, and it is the reason
   * rich-text OT is not merely the same algorithm with extra fields. Text
   * alone cannot produce a conflict where both sides target the same
   * characters and disagree about the result -- concurrent bold and un-bold
   * can, and if the two replicas resolve it differently they diverge with
   * identical text and different formatting. That is the worst kind of
   * divergence, because nothing looks broken.
   *
   * @param {RichTextOperation} a
   * @param {RichTextOperation} b
   * @returns {[RichTextOperation, RichTextOperation]}
   */
  /**
   * Where does `position` end up after `op` is applied?
   *
   * This is what a comment anchor needs and a cursor already needed. Under the
   * CRDT an anchor is a relative position that moves *by construction* -- it
   * names a character, and the character carries it. OT has no such thing: a
   * position is an integer index into a document that other people are
   * editing, so it only stays correct if it is transformed against every
   * operation that lands, exactly like an operation would be. That asymmetry
   * is the whole reason comments are worth building here (ADR-012).
   *
   * `stickRight` decides what happens when an insert lands *exactly* at the
   * position, which is genuinely ambiguous and has to be answered per caller
   * rather than globally. Sticking right means the anchor steps OVER the
   * inserted text; sticking left means it stays put and the text lands after
   * it. For a range that reads as:
   *
   *   - A comment's START sticks RIGHT, so text typed at that boundary is
   *     pushed out in front of the highlight rather than joining it.
   *   - A comment's END sticks LEFT, so text typed at the far boundary stays
   *     outside too.
   *
   * Together those make both edges exclusive: a comment grows only when
   * someone types strictly INSIDE it, and typing against either edge leaves
   * the highlighted characters exactly as they were. The alternative -- either
   * edge sticking inward -- gives you a comment that silently annexes whatever
   * gets typed next to it, which is how a note about one sentence ends up
   * covering the paragraph after it.
   *
   * @param {RichTextOperation} op
   * @param {number} position index into the document `op` applies to
   * @param {boolean} [stickRight] which side of an insert at exactly `position` to land on
   * @returns {number} the corresponding index in the resulting document
   */
  static transformPosition(op, position, stickRight = false) {
    if (position < 0) throw new Error(`transformPosition: negative position ${position}`);

    // Characters of the base document still strictly to the LEFT of the
    // anchor. Counting down rather than tracking two cursors keeps the
    // straddling-delete case from needing its own branch: a delete that
    // spans the anchor simply consumes what is left of it and stops.
    let remaining = position;
    let result = 0;

    for (const c of op.ops) {
      // Nothing further along the document can move an anchor that already
      // has no characters to its left -- unless it is an insert landing
      // exactly on it and we were told to stick to its right.
      if (remaining === 0 && !stickRight) break;

      if (isInsert(c)) {
        // At or before the anchor, so the anchor slides along.
        result += c.i.length;
      } else if (isRetain(c)) {
        const take = Math.min(c.r, remaining);
        result += take;
        remaining -= take;
        if (take < c.r) break; // the anchor lies inside this retain
      } else {
        // Deleted characters that were to our left simply cease to exist, so
        // they are subtracted from the anchor without contributing to it. A
        // delete that straddles the anchor collapses it onto the delete's
        // start, which is the only place left to put it.
        const take = Math.min(c.d, remaining);
        remaining -= take;
        if (take < c.d) break;
      }
    }

    return result;
  }

  /**
   * Transform a whole range, applying the sticky rules described above.
   *
   * Returns `null` when the range has been entirely deleted. That is a real
   * outcome and not an error: someone deleted the text a comment was attached
   * to, and the honest thing to do is orphan the comment rather than silently
   * re-anchor it somewhere it was never about.
   *
   * @param {RichTextOperation} op
   * @param {{from: number, to: number}} range
   * @returns {{from: number, to: number}|null}
   */
  static transformRange(op, { from, to }) {
    const nextFrom = RichTextOperation.transformPosition(op, from, true);
    const nextTo = RichTextOperation.transformPosition(op, to, false);
    return nextTo > nextFrom ? { from: nextFrom, to: nextTo } : null;
  }

  static transform(a, b) {
    if (a.baseLength !== b.baseLength) {
      throw new Error(
        `transform: operations are not concurrent (${a.baseLength} vs ${b.baseLength} base length)`);
    }
    const aPrime = new RichTextOperation();
    const bPrime = new RichTextOperation();
    const iterA = new Iterator(a.ops);
    const iterB = new Iterator(b.ops);

    while (iterA.hasNext() || iterB.hasNext()) {
      // Inserts consume no characters of the base document, so they are
      // handled first and independently. `a` wins the position tie.
      if (iterA.peekType() === 'insert') {
        const c = iterA.next();
        aPrime.insert(c.i, c.a);
        bPrime.retain(c.i.length); // b must now skip over what a inserted
        continue;
      }
      if (iterB.peekType() === 'insert') {
        const c = iterB.next();
        aPrime.retain(c.i.length);
        bPrime.insert(c.i, c.a);
        continue;
      }

      const length = Math.min(iterA.peekLength(), iterB.peekLength());
      const ca = iterA.next(length);
      const cb = iterB.next(length);

      if (isDelete(ca)) {
        // Text `a` removed. If `b` removed it too, neither prime removes it
        // again -- the case that makes two people deleting one word delete it
        // once rather than twice. If `b` merely retained (possibly formatted)
        // it, the deletion wins: formatting text that no longer exists is a
        // no-op, so dropping `b`'s attribute change here is correct.
        if (!isDelete(cb)) aPrime.delete(length);
      } else if (isDelete(cb)) {
        bPrime.delete(length);
      } else {
        // Both retained. `a` keeps its attribute changes verbatim; `b` keeps
        // only the keys `a` did not touch.
        aPrime.retain(length, ca.a);
        bPrime.retain(length, transformAttributes(ca.a, cb.a, true));
      }
    }
    return [aPrime, bPrime];
  }

  // ---- serialisation -------------------------------------------------------

  toJSON() {
    return this.ops;
  }

  static fromJSON(ops) {
    const out = new RichTextOperation();
    for (const c of ops ?? []) {
      if (isRetain(c)) out.retain(c.r, c.a);
      else if (isInsert(c)) out.insert(c.i, c.a);
      else if (isDelete(c)) out.delete(c.d);
      else throw new Error(`fromJSON: invalid component ${JSON.stringify(c)}`);
    }
    return out;
  }

  equals(other) {
    if (this.baseLength !== other.baseLength) return false;
    if (this.targetLength !== other.targetLength) return false;
    if (this.ops.length !== other.ops.length) return false;
    return this.ops.every((c, i) => {
      const o = other.ops[i];
      if (isRetain(c)) return isRetain(o) && c.r === o.r && attributesEqual(c.a, o.a);
      if (isInsert(c)) return isInsert(o) && c.i === o.i && attributesEqual(c.a, o.a);
      return isDelete(o) && c.d === o.d;
    });
  }

  toString() {
    const marks = (a) => (a ? ` {${Object.entries(a).map(([k, v]) => `${k}:${v}`).join(',')}}` : '');
    return this.ops.map((c) =>
      isRetain(c) ? `retain ${c.r}${marks(c.a)}` :
      isInsert(c) ? `insert ${JSON.stringify(c.i)}${marks(c.a)}` :
      `delete ${c.d}`).join(', ') || '(noop)';
  }
}
