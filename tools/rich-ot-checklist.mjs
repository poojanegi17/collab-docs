/**
 * Worked examples for the attributed OT algorithm -- the readable companion
 * to the fuzzer in rich-ot-properties.mjs.
 *
 * The property tests prove the laws hold; they are useless for understanding
 * what the laws MEAN, because a random 40-character document with three
 * conflicting attributes teaches nobody anything. These are the same laws on
 * cases you can hold in your head, and each one is a case that came up while
 * designing the transform:
 *
 *   formatting vs concurrent typing      does bold survive an insert before it
 *   bold vs un-bold on one range         the conflict plain text cannot express
 *   delete vs format of the same range   deletion wins, formatting evaporates
 *   headings on the newline              line attributes need no block model
 *   composing a removal                  null must survive into the composed op
 *
 *   node tools/rich-ot-checklist.mjs
 */
import { RichTextOperation as Op, RichText } from '../shared/ot/src/index.js';

const show = (d) => d.toDebugString();
let bad = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got  ${got}\n        want ${want}`);
};

const doc = RichText.fromString('Hello world');       // 11 chars
const bold = new Op().retain(5, { bold: true }).retain(6);
check('bold a word', show(bold.apply(doc)), '"Hello"[bold] + " world"');

// concurrent: a bolds "Hello", b inserts at the front
{
  const a = new Op().retain(5, { bold: true }).retain(6);
  const b = new Op().insert('X').retain(11);
  const [ap, bp] = Op.transform(a, b);
  check('TP1  format vs insert', show(bp.apply(a.apply(doc))), show(ap.apply(b.apply(doc))));
}

// the conflict plain text cannot produce: bold vs un-bold over one range
const boldDoc = bold.apply(doc);
{
  const a = new Op().retain(5, { bold: null }).retain(6);          // server
  const b = new Op().retain(5, { bold: true, italic: true }).retain(6);
  const [ap, bp] = Op.transform(a, b);
  check('TP1  un-bold vs bold+italic',
    show(bp.apply(a.apply(boldDoc))), show(ap.apply(b.apply(boldDoc))));
  check('server wins the attribute tie, italic survives',
    show(bp.apply(a.apply(boldDoc))), '"Hello"[italic] + " world"');
}

// delete beats concurrent formatting of the deleted range
{
  const a = new Op().delete(5).retain(6);
  const b = new Op().retain(5, { bold: true }).retain(6);
  const [ap, bp] = Op.transform(a, b);
  check('TP1  delete vs format', show(bp.apply(a.apply(doc))), show(ap.apply(b.apply(doc))));
  check('formatting deleted text is a no-op', show(bp.apply(a.apply(doc))), '" world"');
}

// line attributes ride the newline: headings, lists, blockquotes
{
  const para = RichText.fromString('Title\nbody');
  const heading = new Op().retain(5).retain(1, { header: 1 }).retain(4);
  check('heading rides the newline',
    show(heading.apply(para)), "\"Title\" + " + JSON.stringify(String.fromCharCode(10)) + "[header=1] + \"body\"");
}

// compose must keep an attribute removal alive
{
  const composed = new Op().retain(5, { bold: true }).retain(6)
    .compose(new Op().retain(5, { bold: null }).retain(6));
  check('compose preserves the removal', composed.toString(), 'retain 5 {bold:null}, retain 6');
  check('composed removal, applied', show(composed.apply(boldDoc)), '"Hello world"');
}

// insert carrying formatting, and JSON round-trip
{
  const op = new Op().retain(11).insert('!', { bold: true });
  check('formatted insert', show(op.apply(doc)), '"Hello world" + "!"[bold]');
  check('JSON round-trip', Op.fromJSON(JSON.parse(JSON.stringify(op))).equals(op), true);
  check('wire form', JSON.stringify(op), '[{"r":11},{"i":"!","a":{"bold":true}}]');
}

console.log(bad === 0 ? '\nall sanity checks passed' : `\n${bad} FAILED`);
process.exit(bad ? 1 : 0);
