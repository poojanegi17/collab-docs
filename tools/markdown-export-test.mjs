/**
 * Markdown export, as worked examples.
 *
 * Not property tests: there is no algebraic law here, only a set of decisions
 * about what Markdown can and cannot say. The interesting ones are the
 * negatives -- a run of spaces must not become `** **`, code must not be
 * escaped, and a font size must be REPORTED as lost rather than quietly
 * dropped or smuggled through as an HTML span.
 *
 *   node tools/markdown-export-test.mjs
 */
import { RichText } from '../shared/ot/src/index.js';
import { toMarkdown, describeLoss, filenameFor } from '../frontend/src/ui/export-markdown.js';

const NEWLINE = String.fromCharCode(10);
// Spelled out rather than escaped: this expectation is about a literal
// backslash, and every layer between here and the file wants to eat one.
const BACKSLASH = String.fromCharCode(92);
let pass = 0, fail = 0;

const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`        want: ${JSON.stringify(want)}`);
    console.log(`        got:  ${JSON.stringify(got)}`);
  }
  ok ? pass++ : fail++;
};

/** Build a RichText from [text, attributes] pairs. */
const doc = (...runs) => {
  const rt = new RichText();
  for (const [text, attributes] of runs) rt.push(text, attributes);
  return rt;
};

console.log(NEWLINE + 'Markdown export' + NEWLINE);

// ---- inline ---------------------------------------------------------------
check('bold', toMarkdown(doc(['hi ', undefined], ['there', { bold: true }])),
  'hi **there**' + NEWLINE);

check('italic inside bold nests innermost-first',
  toMarkdown(doc(['x', { bold: true, italic: true }])),
  '***x***' + NEWLINE);

check('strikethrough', toMarkdown(doc(['gone', { strike: true }])),
  '~~gone~~' + NEWLINE);

check('a link wraps the whole run',
  toMarkdown(doc(['docs', { link: 'https://example.com' }])),
  '[docs](https://example.com)' + NEWLINE);

check('a bold link keeps both',
  toMarkdown(doc(['docs', { link: 'https://example.com', bold: true }])),
  '[**docs**](https://example.com)' + NEWLINE);

// ---- the negatives that matter --------------------------------------------
// Selecting "word " (with the trailing space) and pressing Ctrl+B is an
// entirely ordinary thing to do, and `**word **` renders as literal asterisks.
check('trailing whitespace is hoisted out of the markers',
  toMarkdown(doc(['bold ', { bold: true }], ['plain', undefined])),
  '**bold** plain' + NEWLINE);

check('leading whitespace too',
  toMarkdown(doc(['plain', undefined], [' bold', { bold: true }])),
  'plain **bold**' + NEWLINE);

check('a whitespace-only run is not wrapped at all',
  toMarkdown(doc(['a', { bold: true }], ['   ', { italic: true }], ['b', { bold: true }])),
  '**a**   **b**' + NEWLINE);

// Same for links: a trailing space belongs to the sentence, not to the link,
// and leaving it inside renders an underlined space.
check('a link does not swallow the space after it',
  toMarkdown(doc(['a link ', { link: 'https://x.test' }])),
  '[a link](https://x.test) ' + NEWLINE);

check('code is literal, not escaped',
  toMarkdown(doc(['a_b*c', { code: true }])),
  '`a_b*c`' + NEWLINE);

check('code containing a backtick gets a longer fence',
  toMarkdown(doc(['a`b', { code: true }])),
  '``a`b``' + NEWLINE);

check('markdown metacharacters in prose are escaped',
  toMarkdown(doc(['a_b*c', undefined])),
  'a\\_b\\*c' + NEWLINE);

// ---- lines ----------------------------------------------------------------
check('a heading',
  toMarkdown(doc(['Title', undefined], [NEWLINE, { header: 2 }])),
  '## Title' + NEWLINE + NEWLINE);

check('a bullet list',
  toMarkdown(doc(['one', undefined], [NEWLINE, { list: 'bullet' }],
                 ['two', undefined], [NEWLINE, { list: 'bullet' }])),
  '- one' + NEWLINE + '- two' + NEWLINE + NEWLINE);

check('legacy bullet:true still renders',
  toMarkdown(doc(['one', undefined], [NEWLINE, { bullet: true }])),
  '- one' + NEWLINE + NEWLINE);

check('a numbered list counts up',
  toMarkdown(doc(['a', undefined], [NEWLINE, { list: 'number' }],
                 ['b', undefined], [NEWLINE, { list: 'number' }],
                 ['c', undefined], [NEWLINE, { list: 'number' }])),
  '1. a' + NEWLINE + '2. b' + NEWLINE + '3. c' + NEWLINE + NEWLINE);

check('a paragraph restarts the numbering',
  toMarkdown(doc(['a', undefined], [NEWLINE, { list: 'number' }],
                 ['break', undefined], [NEWLINE, undefined],
                 ['b', undefined], [NEWLINE, { list: 'number' }])),
  '1. a' + NEWLINE + 'break' + NEWLINE + '1. b' + NEWLINE + NEWLINE);

check('indent becomes two spaces per level',
  toMarkdown(doc(['deep', undefined], [NEWLINE, { list: 'bullet', indent: 2 }])),
  '    - deep' + NEWLINE + NEWLINE);

check('a blockquote',
  toMarkdown(doc(['said', undefined], [NEWLINE, { quote: true }])),
  '> said' + NEWLINE + NEWLINE);

// ---- blocks (ADR-013) ------------------------------------------------------
{
  const EMBED = String.fromCharCode(0xfffc);
  const SEP = String.fromCharCode(0x1f);

  check('an image becomes an image',
    toMarkdown(doc([EMBED, { image: 'https://x.test/a.png', alt: 'a cat' }])),
    '![a cat](https://x.test/a.png)' + NEWLINE);

  check('an image with no alt still exports',
    toMarkdown(doc([EMBED, { image: 'https://x.test/a.png' }])),
    '![](https://x.test/a.png)' + NEWLINE);

  check('an image sits inside its sentence',
    toMarkdown(doc(['see ', undefined], [EMBED, { image: 'https://x.test/a.png' }],
                   [' there', undefined])),
    'see ![](https://x.test/a.png) there' + NEWLINE);

  // The first row becomes the header, because a Markdown table without one is
  // not a table. Lossy, and the only option available.
  check('a table becomes a markdown table',
    toMarkdown(doc(['a' + SEP + 'b', undefined], [NEWLINE, { table: 't1' }],
                   ['c' + SEP + 'd', undefined], [NEWLINE, { table: 't1' }])),
    '| a | b |' + NEWLINE + '| --- | --- |' + NEWLINE + '| c | d |' + NEWLINE + NEWLINE);

  check('cell formatting survives',
    toMarkdown(doc(['a', { bold: true }], [SEP + 'b', undefined], [NEWLINE, { table: 't1' }])),
    '| **a** | b |' + NEWLINE + '| --- | --- |' + NEWLINE + NEWLINE);

  // A pipe inside a cell would otherwise end the cell early.
  check('a pipe inside a cell is escaped',
    toMarkdown(doc(['a|b' + SEP + 'c', undefined], [NEWLINE, { table: 't1' }])),
    '| a' + BACKSLASH + '|b | c |' + NEWLINE + '| --- | --- |' + NEWLINE + NEWLINE);

  // Short rows are padded, matching the rendering rule in ADR-013.
  check('a short row is padded to the table width',
    toMarkdown(doc(['a' + SEP + 'b' + SEP + 'c', undefined], [NEWLINE, { table: 't1' }],
                   ['d', undefined], [NEWLINE, { table: 't1' }])),
    '| a | b | c |' + NEWLINE + '| --- | --- | --- |' + NEWLINE + '| d |  |  |'
      + NEWLINE + NEWLINE);

  check('two tables stay separate',
    toMarkdown(doc(['a', undefined], [NEWLINE, { table: 't1' }],
                   ['mid', undefined], [NEWLINE, undefined],
                   ['b', undefined], [NEWLINE, { table: 't2' }])),
    '| a |' + NEWLINE + '| --- |' + NEWLINE + 'mid' + NEWLINE
      + '| b |' + NEWLINE + '| --- |' + NEWLINE + NEWLINE);

  check('an image is not reported as lost',
    describeLoss(doc([EMBED, { image: 'https://x.test/a.png' }])).length, 0);

  check('but its display width is',
    describeLoss(doc([EMBED, { image: 'https://x.test/a.png', width: 50 }])).join(','), 'width');
}

// ---- title ----------------------------------------------------------------
check('a title becomes an H1',
  toMarkdown(doc(['body', undefined]), { title: 'My notes' }),
  '# My notes' + NEWLINE + NEWLINE + 'body' + NEWLINE);

check('but not when the document already opens with a heading',
  toMarkdown(doc(['Real title', undefined], [NEWLINE, { header: 1 }]), { title: 'My notes' }),
  '# Real title' + NEWLINE + NEWLINE);

// ---- loss reporting -------------------------------------------------------
{
  const lossy = doc(['big', { size: 36 }], [' red', { color: '#ff0000' }], [' plain', undefined]);
  const loss = describeLoss(lossy).sort().join(',');
  check('lossy attributes are reported', loss, 'color,size');
  check('and are not smuggled into the output',
    toMarkdown(lossy), 'big red plain' + NEWLINE);
  check('a document with nothing lossy reports nothing',
    describeLoss(doc(['x', { bold: true }])).length, 0);
}

// ---- filenames ------------------------------------------------------------
check('a filename is made safe', filenameFor('My Notes: 2026!', 'fallback'), 'My-Notes-2026');
check('an empty title falls back to the id', filenameFor('   ', 'doc-abc'), 'doc-abc');

console.log(NEWLINE + `  ${pass} passed, ${fail} failed` + NEWLINE);
process.exit(fail ? 1 : 0);
