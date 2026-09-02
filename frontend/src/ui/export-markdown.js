/**
 * RichText -> Markdown.
 *
 * Engine-agnostic by construction, like `marks.js`: it is handed a RichText and
 * never learns which engine produced it.
 *
 * Markdown cannot express everything this editor can -- there is no syntax for
 * a font, a size, a text colour or a highlight. Rather than inventing HTML
 * spans and calling the result Markdown, those are dropped, and `describeLoss`
 * reports what was left behind so the export dialog can say so out loud. An
 * exporter that silently discards half a document is worse than one that
 * refuses, and much worse than one that tells you.
 *
 * What survives: headings, bullet and numbered lists, blockquotes, indentation,
 * bold, italic, strikethrough, inline code, links, images and tables.
 *
 * Images and tables export well because of how they are stored (ADR-013): an
 * image is one character carrying a URL, and a table is a run of lines with
 * separated cells. Both are much closer to Markdown's own model than a
 * document tree would have been.
 */
import { LINE_ATTRIBUTES, EMBED_CHAR, CELL_SEPARATOR } from '@collab/ot';

/** Attributes Markdown has no way to say. Reported, not smuggled through. */
const LOSSY = [
  'font', 'size', 'color', 'highlight', 'underline', 'align', 'spacing', 'sup', 'sub',
  // An image survives; the width it was displayed at does not, because
  // Markdown has no syntax for one.
  'width',
];

/** Characters that would otherwise turn into formatting when read back. */
function escapeText(text) {
  // Only the ones that actually start a construct mid-line. Escaping every
  // possible metacharacter makes ordinary prose unreadable in the file, which
  // is the thing Markdown is for.
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

/**
 * Split a RichText into lines, each with its own line attributes and its
 * inline runs.
 *
 * Line attributes ride on the newline ENDING a line (ADR-006), so the split
 * has to look ahead to the terminator rather than reading the first run.
 */
function toLines(rich) {
  const lines = [];
  let current = { attributes: {}, runs: [] };

  for (const run of rich.runs) {
    let text = run.text;
    while (text.length > 0) {
      const at = text.indexOf('\n');
      if (at < 0) {
        current.runs.push({ text, attributes: run.attributes ?? {} });
        break;
      }
      if (at > 0) {
        current.runs.push({ text: text.slice(0, at), attributes: run.attributes ?? {} });
      }
      // The newline carries this line's block formatting.
      current.attributes = pickLine(run.attributes);
      lines.push(current);
      current = { attributes: {}, runs: [] };
      text = text.slice(at + 1);
    }
  }
  lines.push(current);
  return lines;
}

function pickLine(attributes) {
  const out = {};
  for (const key of LINE_ATTRIBUTES) {
    if (attributes && attributes[key] != null) out[key] = attributes[key];
  }
  return out;
}

/** One run -> Markdown, innermost marker first so nesting reads correctly. */
function renderRun({ text, attributes }) {
  const a = attributes ?? {};
  if (text === '') return '';

  // An image is a character with a URL on it, which is very nearly what
  // Markdown's image syntax is. The run may hold several embed characters if
  // two identical images ended up adjacent, so it renders once per character.
  if (a.image) {
    const alt = escapeText(String(a.alt ?? ''));
    const one = `![${alt}](${a.image})`;
    let out = '';
    for (const ch of text) out += ch === EMBED_CHAR ? one : '';
    return out;
  }

  // Code is not a wrapper like the others: its content is literal, so escaping
  // inside it would put backslashes into the code.
  if (a.code) {
    // A span containing a backtick needs a longer fence. Rare, and cheap.
    const fence = text.includes('`') ? '``' : '`';
    const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${text}${pad}${fence}`;
  }

  const escaped = escapeText(text);

  // Emphasis markers must sit against non-whitespace. A bold run that ends in
  // a space -- which is what you get by selecting "word " and pressing Ctrl+B,
  // an extremely ordinary thing to do -- would otherwise export as `**word **`
  // and render as literal asterisks. So the surrounding whitespace is hoisted
  // OUT of the markers, and a run that is only whitespace is never wrapped at
  // all.
  const lead = escaped.match(/^\s*/)[0];
  const trail = escaped.slice(lead.length).match(/\s*$/)[0];
  const core = escaped.slice(lead.length, escaped.length - trail.length);
  if (core === '') return escaped;

  let out = core;
  if (a.strike) out = `~~${out}~~`;
  if (a.italic) out = `*${out}*`;
  if (a.bold) out = `**${out}**`;
  // Links get the same treatment. Their brackets would tolerate the
  // whitespace, but a link whose text is "see here " renders with an
  // underlined trailing space, and the space was part of the sentence rather
  // than part of the link.
  if (a.link) out = `[${out}](${a.link})`;
  return lead + out + trail;
}

function renderLine(line, listCounters) {
  const a = line.attributes;
  const body = line.runs.map(renderRun).join('');
  const indent = '  '.repeat(Math.max(0, Number(a.indent) || 0));

  const kind = a.list ?? (a.bullet ? 'bullet' : null);
  if (kind === 'number') {
    const depth = Number(a.indent) || 0;
    listCounters[depth] = (listCounters[depth] ?? 0) + 1;
    // Deeper counters restart when we come back up a level.
    for (const key of Object.keys(listCounters)) {
      if (Number(key) > depth) delete listCounters[key];
    }
    return `${indent}${listCounters[depth]}. ${body}`;
  }
  // Any non-numbered line ends the numbering, or "1. a / para / 1. b" would
  // continue from 2.
  for (const key of Object.keys(listCounters)) delete listCounters[key];

  if (kind === 'bullet') return `${indent}- ${body}`;
  if (a.quote) return `${indent}> ${body}`;
  if (a.header) return `${'#'.repeat(Math.min(6, Number(a.header)))} ${body}`;
  return indent + body;
}

/**
 * Split one row into rendered cells.
 *
 * The separator is a character in the middle of a run, so runs have to be cut
 * at it rather than iterated whole -- a bold cell followed by a plain one is
 * two runs, but a plain row of three cells is one run containing two
 * separators.
 */
function renderRowCells(line) {
  const cells = [];
  let current = '';
  for (const run of line.runs) {
    const pieces = run.text.split(CELL_SEPARATOR);
    pieces.forEach((piece, i) => {
      if (i > 0) { cells.push(current); current = ''; }
      current += renderRun({ text: piece, attributes: run.attributes });
    });
  }
  cells.push(current);
  // A pipe inside a cell would end the cell. Markdown's own escape for it.
  return cells.map((c) => c.split('|').join('\\|').trim());
}

/**
 * Group consecutive rows of one table and render a Markdown table.
 *
 * Markdown requires a header row and a delimiter row; the document model has
 * no notion of a header, so the FIRST row is treated as one. That is a lossy
 * choice and the only one available -- a Markdown table without a header row
 * is not a table.
 */
function renderTable(rows) {
  const rendered = rows.map(renderRowCells);
  const columns = Math.max(...rendered.map((r) => r.length));
  const pad = (cells) => {
    const out = cells.slice(0, columns);
    while (out.length < columns) out.push('');
    return `| ${out.join(' | ')} |`;
  };
  const out = [pad(rendered[0]), `|${' --- |'.repeat(columns)}`];
  for (const row of rendered.slice(1)) out.push(pad(row));
  return out;
}

/**
 * @param {import('@collab/ot').RichText} rich
 * @param {{title?: string}} [opts]
 * @returns {string}
 */
export function toMarkdown(rich, { title } = {}) {
  const lines = toLines(rich);
  const counters = {};

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const table = lines[i].attributes.table;
    if (table) {
      // Consume the whole run of rows sharing this table id in one go: a
      // Markdown table is a block, not a sequence of independent lines.
      const rows = [];
      while (i < lines.length && lines[i].attributes.table === table) {
        rows.push(lines[i]);
        i++;
      }
      i--;
      for (const key of Object.keys(counters)) delete counters[key];
      out.push(...renderTable(rows));
      continue;
    }
    out.push(renderLine(lines[i], counters));
  }
  const body = out.join('\n');
  // A leading H1 only when there is a title AND the document does not already
  // open with a heading of its own.
  const opensWithHeading = lines[0]?.attributes?.header;
  return title && !opensWithHeading ? `# ${title}\n\n${body}\n` : `${body}\n`;
}

/**
 * Which attributes present in this document Markdown cannot carry.
 * @returns {string[]}
 */
export function describeLoss(rich) {
  const found = new Set();
  for (const run of rich.runs) {
    for (const key of LOSSY) {
      if (run.attributes && run.attributes[key] != null) found.add(key);
    }
  }
  return [...found];
}

/** Hand the browser a file. */
export function downloadMarkdown(markdown, filename) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick rather than immediately: Safari has not finished
  // reading the blob when click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A filesystem-safe name from a document title. */
export function filenameFor(title, docId) {
  const base = String(title ?? '').trim() || docId;
  return base.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').slice(0, 60) || 'document';
}
