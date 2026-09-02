/**
 * A text operation in the classic OT "changeset" form.
 *
 * An operation is a flat list of components describing a walk over the whole
 * document, so it is self-describing about the length of document it applies to:
 *
 *   positive number  N   retain N characters
 *   negative number -N   delete N characters
 *   string           s   insert s
 *
 * Example, turning "hello world" into "hey world!":
 *
 *   [2, "y", -3, 6, "!"]
 *    |   |    |  |   `- insert "!"
 *    |   |    |  `----- retain " world"
 *    |   |    `-------- delete "llo"
 *    |   `------------- insert "y"
 *    `----------------- retain "he"
 *
 * Why this shape rather than {type:'insert', pos, text}?
 *
 * A single editor keystroke can produce several changes at once (typing over a
 * multi-cursor selection, autocomplete, paste-over). The changeset form
 * represents any number of changes as one atomic operation, and -- crucially --
 * it *composes*: two sequential operations collapse into one. Positional ops
 * do not compose, which means the client's pending buffer would grow without
 * bound while it waits for an ack.
 *
 * Two invariants make everything else work:
 *
 *   baseLength    length of the document this op can be applied to
 *   targetLength  length of the document that results
 *
 * They are checked on every apply/compose/transform. A length mismatch always
 * means a bug upstream, and catching it here rather than three states later is
 * the difference between a five-minute and a five-hour debugging session.
 */

const isRetain = (op) => typeof op === 'number' && op > 0;
const isDelete = (op) => typeof op === 'number' && op < 0;
const isInsert = (op) => typeof op === 'string';

export class TextOperation {
  constructor() {
    /** @type {(number|string)[]} */
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }

  // ---- building ------------------------------------------------------------

  /** Skip over `n` characters, leaving them unchanged. */
  retain(n) {
    if (n <= 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    const last = this.ops[this.ops.length - 1];
    // Merge with the previous component so the op stays canonical -- two
    // adjacent retains are always equivalent to one, and keeping the form
    // canonical is what lets us compare operations for equality.
    if (isRetain(last)) this.ops[this.ops.length - 1] += n;
    else this.ops.push(n);
    return this;
  }

  insert(str) {
    if (str === '') return this;
    this.targetLength += str.length;
    const ops = this.ops;
    const last = ops[ops.length - 1];

    if (isInsert(last)) {
      ops[ops.length - 1] += str;
    } else if (isDelete(last)) {
      // An insert next to a delete means the same thing in either order, so we
      // always put the insert first. Without this, "delete then insert" and
      // "insert then delete" would be two representations of one operation and
      // equality checks would spuriously fail.
      if (isInsert(ops[ops.length - 2])) {
        ops[ops.length - 2] += str;
      } else {
        ops[ops.length] = ops[ops.length - 1];
        ops[ops.length - 2] = str;
      }
    } else {
      ops.push(str);
    }
    return this;
  }

  /** Accepts a length, a negative length, or the string being removed. */
  delete(n) {
    if (typeof n === 'string') n = n.length;
    if (n === 0) return this;
    if (n > 0) n = -n;
    this.baseLength -= n;
    const last = this.ops[this.ops.length - 1];
    if (isDelete(last)) this.ops[this.ops.length - 1] += n;
    else this.ops.push(n);
    return this;
  }

  /** True if applying this operation is a no-op. */
  isNoop() {
    return this.ops.length === 0 || (this.ops.length === 1 && isRetain(this.ops[0]));
  }

  // ---- using ---------------------------------------------------------------

  /** @param {string} str @returns {string} */
  apply(str) {
    if (str.length !== this.baseLength) {
      throw new Error(
        `apply: operation expects a document of length ${this.baseLength}, got ${str.length}`);
    }
    const parts = [];
    let i = 0;
    for (const op of this.ops) {
      if (isRetain(op)) { parts.push(str.slice(i, i + op)); i += op; }
      else if (isInsert(op)) parts.push(op);
      else i -= op; // delete: skip, contributing nothing
    }
    return parts.join('');
  }

  /**
   * Sequential composition: `a.compose(b)` is the single operation equivalent
   * to applying `a` then `b`.
   *
   *     apply(apply(doc, a), b) === apply(doc, a.compose(b))
   *
   * This is what keeps the client's pending buffer bounded -- however long the
   * server takes to acknowledge, the buffer stays one operation.
   */
  compose(other) {
    if (this.targetLength !== other.baseLength) {
      throw new Error(
        `compose: length mismatch (${this.targetLength} -> ${other.baseLength})`);
    }
    const out = new TextOperation();
    const ops1 = this.ops, ops2 = other.ops;
    let i1 = 0, i2 = 0;
    let op1 = ops1[i1++], op2 = ops2[i2++];

    for (;;) {
      if (op1 === undefined && op2 === undefined) break;

      // A delete in the first op was never seen by the second op, so it passes
      // straight through. Likewise an insert in the second op did not exist
      // when the first op ran.
      if (isDelete(op1)) { out.delete(op1); op1 = ops1[i1++]; continue; }
      if (isInsert(op2)) { out.insert(op2); op2 = ops2[i2++]; continue; }

      if (op1 === undefined) throw new Error('compose: first operation is too short');
      if (op2 === undefined) throw new Error('compose: first operation is too long');

      if (isRetain(op1) && isRetain(op2)) {
        if (op1 > op2) { out.retain(op2); op1 -= op2; op2 = ops2[i2++]; }
        else if (op1 === op2) { out.retain(op1); op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { out.retain(op1); op2 -= op1; op1 = ops1[i1++]; }
      } else if (isInsert(op1) && isDelete(op2)) {
        // The second op deletes text the first op just inserted: both cancel.
        if (op1.length > -op2) { op1 = op1.slice(-op2); op2 = ops2[i2++]; }
        else if (op1.length === -op2) { op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { op2 += op1.length; op1 = ops1[i1++]; }
      } else if (isInsert(op1) && isRetain(op2)) {
        if (op1.length > op2) { out.insert(op1.slice(0, op2)); op1 = op1.slice(op2); op2 = ops2[i2++]; }
        else if (op1.length === op2) { out.insert(op1); op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { out.insert(op1); op2 -= op1.length; op1 = ops1[i1++]; }
      } else if (isRetain(op1) && isDelete(op2)) {
        if (op1 > -op2) { out.delete(op2); op1 += op2; op2 = ops2[i2++]; }
        else if (op1 === -op2) { out.delete(op2); op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { out.delete(op1); op2 += op1; op1 = ops1[i1++]; }
      } else {
        throw new Error('compose: unreachable');
      }
    }
    return out;
  }

  /**
   * THE function. Everything else in OT is bookkeeping around this.
   *
   * Given two operations `a` and `b` that were both written against the *same*
   * document state, produce `[a', b']` such that applying them in either order
   * converges:
   *
   *     a.compose(b') === b.compose(a')
   *
   * That identity is called TP1, and it is what makes it safe for the server
   * and a client to have applied concurrent edits in different orders.
   *
   * Tie-breaking: when both sides insert at the same position, `a`'s insert is
   * placed first, unconditionally. The choice is arbitrary but it MUST be
   * consistent, which is why this system is server-authoritative -- the server
   * is always argument `a`, so every client resolves the tie the same way. A
   * CRDT achieves the same thing by comparing globally unique character ids
   * instead, which is why it does not need a central server. That contrast is
   * the single clearest way to see what you buy and pay for with each model.
   *
   * @param {TextOperation} a
   * @param {TextOperation} b
   * @returns {[TextOperation, TextOperation]} [a', b']
   */
  static transform(a, b) {
    if (a.baseLength !== b.baseLength) {
      throw new Error(
        `transform: operations are not concurrent (${a.baseLength} vs ${b.baseLength} base length)`);
    }
    const aPrime = new TextOperation();
    const bPrime = new TextOperation();
    const ops1 = a.ops, ops2 = b.ops;
    let i1 = 0, i2 = 0;
    let op1 = ops1[i1++], op2 = ops2[i2++];

    for (;;) {
      if (op1 === undefined && op2 === undefined) break;

      // Inserts do not consume characters of the base document, so they are
      // handled first and independently. `a` wins the position tie.
      if (isInsert(op1)) {
        aPrime.insert(op1);
        bPrime.retain(op1.length); // b must now skip over what a inserted
        op1 = ops1[i1++];
        continue;
      }
      if (isInsert(op2)) {
        aPrime.retain(op2.length);
        bPrime.insert(op2);
        op2 = ops2[i2++];
        continue;
      }

      if (op1 === undefined) throw new Error('transform: first operation is too short');
      if (op2 === undefined) throw new Error('transform: first operation is too long');

      let minl;
      if (isRetain(op1) && isRetain(op2)) {
        if (op1 > op2) { minl = op2; op1 -= op2; op2 = ops2[i2++]; }
        else if (op1 === op2) { minl = op2; op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { minl = op1; op2 -= op1; op1 = ops1[i1++]; }
        aPrime.retain(minl);
        bPrime.retain(minl);
      } else if (isDelete(op1) && isDelete(op2)) {
        // Both deleted the same text. Neither prime deletes it again -- this is
        // the case people get wrong by hand, and it is why deleting the same
        // word simultaneously does not delete twice as much.
        if (-op1 > -op2) { op1 -= op2; op2 = ops2[i2++]; }
        else if (op1 === op2) { op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { op2 -= op1; op1 = ops1[i1++]; }
      } else if (isDelete(op1) && isRetain(op2)) {
        if (-op1 > op2) { minl = op2; op1 += op2; op2 = ops2[i2++]; }
        else if (-op1 === op2) { minl = op2; op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { minl = -op1; op2 += op1; op1 = ops1[i1++]; }
        aPrime.delete(minl);
      } else if (isRetain(op1) && isDelete(op2)) {
        if (op1 > -op2) { minl = -op2; op1 += op2; op2 = ops2[i2++]; }
        else if (op1 === -op2) { minl = op1; op1 = ops1[i1++]; op2 = ops2[i2++]; }
        else { minl = op1; op2 += op1; op1 = ops1[i1++]; }
        bPrime.delete(minl);
      } else {
        throw new Error('transform: unreachable');
      }
    }
    return [aPrime, bPrime];
  }

  // ---- serialisation -------------------------------------------------------

  toJSON() {
    return this.ops;
  }

  /** @param {(number|string)[]} ops */
  static fromJSON(ops) {
    const o = new TextOperation();
    for (const op of ops) {
      if (isRetain(op)) o.retain(op);
      else if (isInsert(op)) o.insert(op);
      else if (isDelete(op)) o.delete(op);
      else throw new Error(`fromJSON: invalid component ${JSON.stringify(op)}`);
    }
    return o;
  }

  equals(other) {
    if (this.baseLength !== other.baseLength) return false;
    if (this.targetLength !== other.targetLength) return false;
    if (this.ops.length !== other.ops.length) return false;
    return this.ops.every((op, i) => op === other.ops[i]);
  }

  toString() {
    return this.ops.map((op) =>
      isRetain(op) ? `retain ${op}` :
      isInsert(op) ? `insert ${JSON.stringify(op)}` :
      `delete ${-op}`).join(', ');
  }
}
