/**
 * A rich-text document: a list of runs, each a string plus an attribute map.
 *
 *   [ { text: "Hello ", attributes: { bold: true } },
 *     { text: "world"                              } ]
 *
 * Runs rather than per-character attributes because formatting is
 * overwhelmingly contiguous -- a bold word is one run, not four characters
 * that happen to agree -- and because the editor wants ranges anyway to build
 * decorations.
 *
 * The type is CANONICAL: adjacent runs with equal attributes are always
 * merged, and empty runs never survive. Two documents that look the same are
 * therefore `equals`, which is what lets the property tests assert convergence
 * by comparing documents directly instead of comparing rendered strings and
 * hoping the formatting matched too.
 *
 * Line-level formatting (headings, list items, blockquotes) is carried on the
 * newline character that ENDS the line, which is the Quill convention. It
 * looks odd until you try the alternative: a block model needs its own tree,
 * its own transform, and a rule for what happens when concurrent edits split a
 * block two different ways. Anchoring to the newline keeps the document a flat
 * sequence, so the transform below stays the plain-text one with attributes
 * bolted on -- and a heading is just `retain 1 with { header: 2 }`.
 */
import { attributesEqual } from './attributes.js';

export class RichText {
  /** @param {{text: string, attributes?: object}[]} runs */
  constructor(runs = []) {
    /** @type {{text: string, attributes?: object}[]} */
    this.runs = [];
    for (const run of runs) this.push(run.text, run.attributes);
  }

  static fromString(text, attributes) {
    return new RichText(text ? [{ text, attributes }] : []);
  }

  /** @param {{text: string, attributes?: object}[]} runs */
  static fromJSON(runs) {
    return new RichText(runs ?? []);
  }

  /**
   * Append, maintaining canonical form. Every mutation goes through here, so
   * there is exactly one place that can break the invariant.
   */
  push(text, attributes) {
    if (!text) return this;
    const attrs = attributes && Object.keys(attributes).length ? attributes : undefined;
    const last = this.runs[this.runs.length - 1];
    if (last && attributesEqual(last.attributes, attrs)) last.text += text;
    else this.runs.push(attrs ? { text, attributes: attrs } : { text });
    return this;
  }

  get length() {
    let n = 0;
    for (const run of this.runs) n += run.text.length;
    return n;
  }

  toString() {
    return this.runs.map((r) => r.text).join('');
  }

  toJSON() {
    return this.runs;
  }

  /** Half-open [from, to), in characters, ignoring run boundaries. */
  slice(from, to = this.length) {
    const out = new RichText();
    let at = 0;
    for (const run of this.runs) {
      const end = at + run.text.length;
      if (end > from && at < to) {
        out.push(run.text.slice(Math.max(0, from - at), Math.min(run.text.length, to - at)),
                 run.attributes);
      }
      at = end;
      if (at >= to) break;
    }
    return out;
  }

  /**
   * Attributes a character inserted at `index` should inherit.
   *
   * Taken from the character BEFORE the caret, which is what every editor
   * does: type at the end of a bold word and you stay bold, but move to the
   * start of it and you do not. Without this, formatting would silently end
   * wherever the user last stopped typing.
   */
  attributesAt(index) {
    if (index <= 0) return undefined;
    let at = 0;
    for (const run of this.runs) {
      const end = at + run.text.length;
      if (index <= end) return run.attributes;
      at = end;
    }
    return this.runs[this.runs.length - 1]?.attributes;
  }

  equals(other) {
    if (this.runs.length !== other.runs.length) return false;
    return this.runs.every((run, i) =>
      run.text === other.runs[i].text && attributesEqual(run.attributes, other.runs[i].attributes));
  }

  /** Debug form: `"Hello "[bold] + "world"`. */
  toDebugString() {
    return this.runs.map((r) => {
      const marks = Object.entries(r.attributes ?? {}).map(([k, v]) => v === true ? k : `${k}=${v}`);
      return JSON.stringify(r.text) + (marks.length ? `[${marks.join(',')}]` : '');
    }).join(' + ') || '(empty)';
  }
}
