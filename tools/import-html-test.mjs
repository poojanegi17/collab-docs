/**
 * HTML import, as worked examples.
 *
 * Not property tests, for the same reason `markdown-export-test.mjs` is not:
 * there is no algebraic law relating HTML to a RichText, only a set of
 * decisions about what this vocabulary can and cannot say. So the assertions
 * are examples, and the ones that matter most are the negatives -- a document
 * default must NOT arrive as formatting, a `javascript:` href must NOT arrive
 * as a link, and a table must not vanish along with the words inside it.
 *
 * The fixture is a trimmed real `files.export` response. Testing against
 * hand-written markup would test a Google Docs export that does not exist:
 * the real one carries its boldness in a stylesheet, not in a `<b>`, and an
 * importer that only reads tags passes every invented test and then reads a
 * genuine document as entirely unformatted.
 *
 *   node tools/import-html-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBED_CHAR } from '../shared/ot/src/index.js';
import { htmlToRichText, describeImportLoss } from '../frontend/src/ui/import/html-to-rich.js';
import { parseCss, decodeEntities } from '../frontend/src/ui/import/html-parse.js';
import { toMarkdown } from '../frontend/src/ui/export-markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NEWLINE = String.fromCharCode(10);
let pass = 0, fail = 0;

/**
 * Attribute maps are compared by content, not by insertion order. The order
 * keys land in an attribute map is an artefact of which branch of the walk
 * wrote them, and asserting on it would make every one of these tests break
 * the next time two lines of the converter are swapped.
 */
const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
};

const check = (name, got, want) => {
  // `undefined` and `{}` are different answers -- "no attributes" and "an empty
  // attribute map" -- and only the first is canonical (see RichText#push), so
  // the comparison has to be able to tell them apart.
  const show = (v) => (v === undefined ? 'undefined' : JSON.stringify(sorted(v)));
  const ok = show(got) === show(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`        want: ${show(want)}`);
    console.log(`        got:  ${show(got)}`);
  }
  ok ? pass++ : fail++;
};

/**
 * The document as `[{ text, attrs }]`, one entry per line.
 *
 * Line attributes ride on the newline ENDING a line (ADR-006), so reading them
 * back means looking at the terminator rather than at the line's own runs --
 * the same lookahead `toLines` does in the exporter.
 */
function linesOf(rich) {
  const lines = [];
  let text = '';
  for (const run of rich.runs) {
    let rest = run.text;
    while (rest.length) {
      const at = rest.indexOf(NEWLINE);
      if (at < 0) { text += rest; break; }
      text += rest.slice(0, at);
      lines.push({ text, attrs: run.attributes ?? {} });
      text = '';
      rest = rest.slice(at + 1);
    }
  }
  lines.push({ text, attrs: {} });
  return lines;
}

/**
 * The inline attributes on the first run whose text contains `needle`.
 *
 * Returns the run's own `attributes`, which is `undefined` for an unformatted
 * run rather than `{}` -- that distinction is the canonical form RichText
 * maintains, and several assertions below are precisely about it.
 */
function attrsOf(rich, needle) {
  for (const run of rich.runs) {
    if (run.text.includes(needle)) return run.attributes;
  }
  return 'no such run';
}

const fixture = fs.readFileSync(
  path.join(here, 'fixtures', 'google-doc-export.html'), 'utf8');
const { rich, loss, title } = htmlToRichText(fixture);
const lines = linesOf(rich);
const text = lines.map((l) => l.text);
const lossOf = (what) => loss.counts.get(what) ?? 0;

console.log(NEWLINE + 'HTML import' + NEWLINE);

// ---- the assertion this whole feature turns on ----------------------------
// Google's export contains no <b> at all: "bold word" is a <span class="c1">
// and the weight is in a stylesheet at the top of the file. An importer that
// misses this reads every Google Doc as unformatted text.
check('bold arrives from a stylesheet class, not from a tag',
  attrsOf(rich, 'bold word'), { bold: true });

check('italic likewise', attrsOf(rich, 'italic'), { italic: true });
check('strikethrough likewise', attrsOf(rich, 'struck out'), { strike: true });

// ---- the negatives: defaults are not formatting ---------------------------
// Every span in a Google export states colour, size, weight and family,
// including the unremarkable ones. Carrying those in would pin the document to
// Google's defaults -- and an explicit #000000 on every run is invisible text
// in this app's dark theme.
check('a plain run carries no attributes at all',
  attrsOf(rich, 'Plain text with a '), undefined);

check('a non-default colour does arrive',
  attrsOf(rich, 'Red text'), { color: '#b91c1c' });

check('a highlight does arrive',
  attrsOf(rich, 'highlighted text'), { highlight: '#fef08a' });

check('a non-default size and family do arrive',
  attrsOf(rich, 'A centred line'), { size: 24, font: 'serif' });

// ---- links ----------------------------------------------------------------
// Google rewrites every href through its click redirector. Importing those
// verbatim points every link in the document at google.com, and leaks the
// reader's navigation to a third party.
check('the google.com/url redirector is unwrapped',
  attrsOf(rich, 'the report'), { link: 'https://example.com/report' });

// A link's blue underline is rendering, not formatting, and this app renders
// links its own way.
check('a link does not import its own underline or blue',
  Object.keys(attrsOf(rich, 'the report')), ['link']);

check('a javascript: href keeps the text and loses the link',
  attrsOf(rich, 'not a link'), undefined);
check('and is reported', lossOf('links'), 1);

// ---- block structure ------------------------------------------------------
check('h1 becomes header 1', lines[0].attrs, { header: 1 });
check('h3 becomes header 3',
  lines.find((l) => l.text === 'A third-level heading').attrs, { header: 3 });
check('h4 clamps to header 3 rather than becoming body text',
  lines.find((l) => l.text === 'A fourth-level heading').attrs, { header: 3 });
check('the clamp is reported', lossOf('heading levels'), 1);

check('text-align and line-height become align and spacing',
  lines.find((l) => l.text.startsWith('A centred line')).attrs,
  { align: 'center', spacing: '150' });

check('margin-left becomes one indent level',
  lines.find((l) => l.text === 'An indented paragraph.').attrs, { indent: 1 });

check('a blockquote becomes a quote line',
  lines.find((l) => l.text === 'A quoted line.').attrs, { quote: true });

// ---- lists ----------------------------------------------------------------
check('a bullet at the top level has no indent',
  lines.find((l) => l.text === 'First bullet').attrs, { list: 'bullet' });

// Nesting depth is the indent, NOT the margin-left Google also writes -- and
// honouring both would indent this twice.
check('a nested bullet indents once, from the nesting and not the margin',
  lines.find((l) => l.text === 'Nested bullet').attrs, { list: 'bullet', indent: 1 });

check('an ordered list becomes list: number',
  lines.find((l) => l.text === 'First step').attrs, { list: 'number' });

// The bug this catches: <li>text<ul>..</ul></li> flushes its own line when it
// reaches the nested list, and a naive "every block ends with a line" rule
// then owes it a second, empty one -- a stray empty bullet after every item
// that has children.
check('a list item containing a nested list emits no trailing empty bullet',
  text.filter((t) => t === '').length, 0);

// ---- text -----------------------------------------------------------------
check('a <br> ends the line without ending the block',
  [text.indexOf('Line one') >= 0, text.indexOf('line two after a break') >= 0],
  [true, true]);

check('entities are decoded',
  text.find((t) => t.startsWith('Entities')),
  'Entities: café & co — “quoted” — 5 < 6.');

// The markup is indented, so the newlines between tags are layout. Importing
// them would put a leading space on most lines in the document.
check('inter-tag whitespace is not text',
  text.filter((t) => t !== t.trimStart()).length, 0);

// ---- images ---------------------------------------------------------------
// 234px is 175.5pt, which is 37.5% of the 468pt text column.
check('an image is one character carrying its URL',
  attrsOf(rich, EMBED_CHAR),
  { image: 'https://lh3.googleusercontent.com/chart-image', alt: 'A chart', width: 38 });

// ---- tables ---------------------------------------------------------------
// Not carried yet -- but the words inside them are. Dropping the table along
// with its contents is the one failure an importer must never have.
check('table cells survive as paragraphs',
  ['Region', 'Revenue', 'North', '120'].every((t) => text.includes(t)), true);
check('and the flattening is reported', lossOf('tables flattened to paragraphs'), 1);

// ---- everything else ------------------------------------------------------
check('an unsupported font is dropped and reported',
  [attrsOf(rich, 'A paragraph set in Papyrus.'), lossOf('fonts')], [undefined, 1]);

check('a horizontal rule is reported', lossOf('horizontal rules'), 1);

// Google ends almost every export with an empty paragraph.
check('the trailing empty paragraph is trimmed',
  text[text.length - 1] !== '' || text.length === 1, true);

check('the title comes from <title>', title, 'Quarterly Notes');

check('the loss report reads as a sentence, and counts of one read as one',
  describeImportLoss(loss),
  'Imported with changes: 1 heading level flattened, 1 font dropped, '
  + '1 table flattened to paragraphs, 1 link dropped and 1 horizontal rule dropped.');
check('nothing lost means no sentence',
  describeImportLoss(htmlToRichText('<p>hi</p>').loss), '');

// The source file is indented, so the newline before a nested <ul> and the one
// before its first <li> both land at the end of the parent item's line.
check('a list item with a nested list keeps no trailing whitespace',
  text.includes('Second bullet'), true);

// ---- the parser, on the cases that corrupt a document ---------------------

check('an unclosed <p> does not swallow the rest of the document',
  linesOf(htmlToRichText('<p>one<p>two<p>three').rich).map((l) => l.text),
  ['one', 'two', 'three']);

// `alt="a > b"` is ordinary, and stopping at the first > splits the tag.
check('a > inside an attribute value does not end the tag',
  htmlToRichText('<p><img src="https://x.test/i.png" alt="a > b">after</p>')
    .rich.runs.find((r) => r.attributes?.image)?.attributes.alt,
  'a > b');

check('a stray close tag does not unwind the stack',
  linesOf(htmlToRichText('<p>one</div>two</p>').rich).map((l) => l.text), ['onetwo']);

check('a bare < in prose is text, not a tag',
  htmlToRichText('<p>5 < 6</p>').rich.toString(), '5 < 6');

check('@import and @page are skipped, and a combinator selector is not a class',
  [...parseCss("@import url('x');@page{margin:1in}.a>li{color:red}.b{font-weight:700}").keys()],
  ['b']);

check('a later rule wins, as in CSS',
  parseCss('.a{color:#111111}.a{color:#222222}').get('a'), { color: '#222222' });

check('a comment is not a rule',
  [...parseCss('/* .a{color:red} */ .b{color:#333333}').keys()], ['b']);

// A span saying font-weight:400 inside a bold paragraph has to be able to turn
// boldness off -- which is how Google writes a plain word inside a bold run.
check('font-weight: 400 turns off inherited boldness',
  htmlToRichText('<div style="font-weight:700">a<span style="font-weight:400">b</span></div>')
    .rich.toDebugString(),
  '"a"[bold] + "b"');

check('an unknown entity is left alone', decodeEntities('&nope; &amp;'), '&nope; &');

check('a numeric entity is decoded', decodeEntities('&#65;&#x42;'), 'AB');

// The last line has no newline to carry its attributes -- so a document that
// ends in a heading needs one more line, exactly as applying a heading to the
// final line in the editor does.
check('a formatted final line gets a newline to carry its attributes',
  linesOf(htmlToRichText('<p>body</p><h2>the end</h2>').rich).map((l) => [l.text, l.attrs]),
  [['body', {}], ['the end', { header: 2 }], ['', {}]]);

check('an empty paragraph between two others is a blank line',
  linesOf(htmlToRichText('<p>a</p><p></p><p>b</p>').rich).map((l) => l.text), ['a', '', 'b']);

check('empty input is an empty document', htmlToRichText('').rich.toString(), '');

// A tree walk that recurses on children without a depth guard is a stack
// overflow waiting for a pathological file; this is the cheap check that the
// ordinary deep-nesting case is fine.
check('deeply nested markup does not throw',
  htmlToRichText(`${'<div>'.repeat(200)}deep${'</div>'.repeat(200)}`).rich.toString(), 'deep');

// ---- the imported document is an ordinary document -------------------------
// Everything downstream -- the renderer, the engines, the exporter -- assumes
// a canonical RichText with line attributes on the newlines that end lines. If
// the importer produced something merely close to that, the failure would not
// surface here but somewhere far away, so it is asserted here instead: the
// exporter reads the imported document back out and finds the structure the
// converter claims to have built.
const markdown = toMarkdown(rich);
check('an imported document round-trips through the Markdown exporter',
  [
    markdown.includes('# **Quarterly Notes**'),
    markdown.includes('- First bullet'),
    markdown.includes('  - Nested bullet'),
    markdown.includes('2. Second step'),
    markdown.includes('> A quoted line.'),
    markdown.includes('[the report](https://example.com/report)'),
  ],
  [true, true, true, true, true, true]);

// Adjacent runs with equal attributes are always merged and empty runs never
// survive (see RichText#push). Trimming trailing whitespace at a line boundary
// can empty a run, so this is the check that the trimming did not leave one.
check('the result is in canonical form',
  rich.runs.some((r) => r.text === ''), false);

/*
 * The clipboard and file-name assertions that used to close this file are
 * gone with the code they covered. Import is Drive-only now: the picker hands
 * back HTML and `importHtml` converts it, which is everything above this line.
 * There is no longer a paste flavour to choose or a file extension to judge.
 */

console.log(`${NEWLINE}  ${pass} passed, ${fail} failed${NEWLINE}`);
process.exit(fail ? 1 : 0);
