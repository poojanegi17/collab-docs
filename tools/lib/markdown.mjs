/**
 * A small Markdown -> token-tree parser, for build time only.
 *
 * The /decisions route renders the ADRs. It could have pulled in a Markdown
 * library and shipped it to the browser, and that would have been the wrong
 * shape twice over: this project's claim is that Yjs is the only borrowed
 * part, and a client-side renderer means either `dangerouslySetInnerHTML` over
 * text or a sanitiser standing behind it.
 *
 * So the conversion happens here, in Node, at build time, and what reaches the
 * browser is a tree of typed tokens that React maps to elements. There is no
 * HTML anywhere in the pipeline, which means there is no injection surface in
 * it either -- the same argument `attribute-values.js` makes about formatting
 * values arriving from a peer.
 *
 * The subset is exactly what the ADRs use, and `parse` THROWS on a construct
 * it does not know rather than dropping it. A silently swallowed table is how
 * a documentation page quietly starts lying about the document it renders.
 *
 * Blocks:  heading, para, list, table, code, quote, hr
 * Inline:  text, strong, em, code, link
 */

/* ---- inline ------------------------------------------------------------- */

/**
 * Ordered by precedence. Code first: backticks win over everything, so
 * `**not bold**` inside a span of code stays literal.
 */
const INLINE = [
  { type: 'code', re: /`([^`]+)`/ },
  { type: 'link', re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { type: 'strong', re: /\*\*([^*]+)\*\*/ },
  { type: 'em', re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/ },
];

export function parseInline(src) {
  const out = [];
  let rest = src;

  while (rest) {
    // The earliest match across all patterns wins, so `a **b** c` and
    // `a *b* **c**` both split the way a reader expects.
    let best = null;
    for (const { type, re } of INLINE) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { type, m };
    }
    if (!best) { out.push({ t: 'text', v: rest }); break; }

    const { type, m } = best;
    if (m.index > 0) out.push({ t: 'text', v: rest.slice(0, m.index) });

    if (type === 'code') out.push({ t: 'code', v: m[1] });
    else if (type === 'link') out.push({ t: 'link', href: m[2], c: parseInline(m[1]) });
    else out.push({ t: type === 'strong' ? 'strong' : 'em', c: parseInline(m[1]) });

    rest = rest.slice(m.index + m[0].length);
  }

  // Collapse the empty text nodes the splitting can leave behind.
  return out.filter((n) => n.t !== 'text' || n.v !== '');
}

/* ---- blocks ------------------------------------------------------------- */

const splitRow = (line) => line
  .replace(/^\s*\|/, '')
  .replace(/\|\s*$/, '')
  .split('|')
  .map((c) => c.trim());

export function parse(md, where = 'markdown') {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // ---- fenced code ----
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) throw new Error(`${where}: unterminated code fence`);
      i++; // closing fence
      blocks.push({ t: 'code', lang, v: body.join('\n') });
      continue;
    }

    // ---- heading ----
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ t: 'heading', d: h[1].length, c: parseInline(h[2].trim()) });
      i++;
      continue;
    }

    // ---- horizontal rule ----
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }

    // ---- table ----
    // A pipe row followed by a delimiter row. Checking the delimiter matters:
    // a paragraph that happens to contain a pipe is not a table.
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i++]).map(parseInline));
      }
      blocks.push({ t: 'table', head, rows });
      continue;
    }

    // ---- blockquote ----
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ t: 'quote', c: parse(body.join('\n'), where) });
      continue;
    }

    // ---- list ----
    const bullet = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m) {
          // A wrapped continuation line belongs to the item above it. Without
          // this every soft-wrapped bullet in these documents becomes a
          // paragraph of its own.
          if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1] += ' ' + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        if (/\d/.test(m[2]) !== ordered) break;
        items.push(m[3]);
        i++;
      }
      blocks.push({ t: 'list', ordered, items: items.map(parseInline) });
      continue;
    }

    // ---- paragraph ----
    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])
      && !(lines[i].trim().startsWith('|'))) {
      para.push(lines[i++].trim());
    }
    if (!para.length) throw new Error(`${where}: could not parse line ${i + 1}: ${lines[i]}`);
    blocks.push({ t: 'para', c: parseInline(para.join(' ')) });
  }

  return blocks;
}

/** Plain text of a token tree — for search, and for counting words. */
export function plain(nodes) {
  return nodes.map((n) => {
    if (n.t === 'text' || n.t === 'code') return n.v ?? '';
    if (n.c) return plain(n.c);
    return '';
  }).join('');
}
