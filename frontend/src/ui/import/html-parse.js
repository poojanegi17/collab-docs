/**
 * A small HTML and CSS parser, sufficient for what Google Docs exports.
 *
 * WHY NOT `DOMParser`. The browser has one, and it is better than this. But
 * the converter that sits on top of this file (html-to-rich.js) is the part
 * with all the decisions in it, and it has to be tested the way everything
 * else in `npm test` is tested: in node, with no browser and no network. A
 * DOM-based converter would either be untestable there or would be tested
 * against a shim -- which means the harness exercises code that is not the
 * code the browser runs. Parsing here instead keeps ONE implementation, and
 * the fixture test drives exactly the bytes that ship.
 *
 * The trade is real and worth stating: this is not a spec-compliant HTML
 * parser and must never be pointed at the open web. It is aimed at
 * machine-generated markup -- Google's `files.export` output and the
 * `text/html` flavour of its clipboard -- which is well-formed, closes its
 * tags, and quotes its attributes. What it does handle beyond that is a small
 * set of implicit closes (see AUTO_CLOSE), because pasted markup is not always
 * as tidy as exported markup and an unclosed `<p>` should not swallow the rest
 * of the document.
 *
 * The output is deliberately not DOM-shaped. An element is
 * `{ tag, attrs, children }` and a text node is `{ text }`, because that is
 * all the converter reads, and a smaller surface is a smaller thing to be
 * wrong about.
 */

/** Elements with no closing tag. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text, not markup. `</style>` ends a stylesheet. */
const RAW_TEXT = new Set(['script', 'style']);

/**
 * Which open elements a newly opened tag implicitly closes.
 *
 * Only the cases that actually corrupt a document when they are missed. An
 * unclosed `<p>` is the one that matters: without this rule every following
 * paragraph nests one level deeper inside it, and the converter -- which
 * flushes a line per block -- would still produce the right text but would
 * attribute every line to the first paragraph's formatting.
 */
const AUTO_CLOSE = {
  p: new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'blockquote', 'table', 'tr', 'td', 'th', 'hr', 'pre']),
  li: new Set(['li']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
  tr: new Set(['tr']),
};

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', bull: '•',
  middot: '·', copy: '©', reg: '®',
  trade: '™', deg: '°', euro: '€', pound: '£',
};

/**
 * The Latin-1 named entities, which are exactly code points 192-255 in this
 * order. Generated rather than typed out as a table: ninety-six names is a lot
 * of opportunity to transpose two, and the list is only correct as a sequence
 * anyway.
 *
 * Case matters here and nowhere else in this file -- `&Eacute;` and `&eacute;`
 * are different letters -- so this is consulted before the case-insensitive
 * table above.
 */
const LATIN1 = {};
('Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml '
  + 'Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times '
  + 'Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc '
  + 'atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute '
  + 'icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash '
  + 'ugrave uacute ucirc uuml yacute thorn yuml')
  .split(' ').forEach((name, i) => { LATIN1[name] = String.fromCodePoint(192 + i); });

/**
 * `&amp;` and friends, plus numeric forms.
 *
 * An unrecognised entity is left exactly as it was rather than dropped: it is
 * far more likely to be someone writing about entities than a form this parser
 * should have known, and returning the literal text is the failure that loses
 * nothing.
 */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      // Surrogates and out-of-range values would throw; keep the source text.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return LATIN1[body] ?? NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * The index of the `>` closing the tag that starts at `open`.
 *
 * Scanned rather than `indexOf('>')` because an attribute value may contain
 * one -- `alt="a > b"` is ordinary, and stopping at the first `>` would split
 * the tag in the middle and emit the rest as text.
 */
function findTagEnd(html, open) {
  let quote = null;
  for (let i = open + 1; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;

function parseAttrs(source) {
  const attrs = {};
  ATTR.lastIndex = 0;
  let match;
  while ((match = ATTR.exec(source))) {
    const name = match[1].toLowerCase();
    // A bare attribute (`disabled`) has no value; store the empty string so
    // callers can use `attrs.x` without distinguishing the two.
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Parse a document into `{ tag: '#root', attrs, children }`.
 *
 * Never throws. Malformed input produces a tree that is wrong in some local
 * way rather than no tree at all -- an import that drops one span is a much
 * better outcome than an import that reports a syntax error about a file the
 * user did not write and cannot fix.
 */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  const addText = (raw) => {
    if (!raw) return;
    top().children.push({ text: decodeEntities(raw) });
  };

  const closeTo = (name) => {
    // Search from the top for a matching open element. A close tag with no
    // open counterpart is discarded rather than unwinding the stack, which is
    // what stops a stray `</div>` from closing the whole document.
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].tag === name) {
        stack.length = i;
        return;
      }
    }
  };

  let i = 0;
  const source = String(html ?? '');
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) { addText(source.slice(i)); break; }
    if (lt > i) addText(source.slice(i, lt));

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    // `<!DOCTYPE ...>` and any other bang-directive.
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end < 0 ? source.length : end).trim().toLowerCase();
      closeTo(name);
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    const end = findTagEnd(source, lt);
    if (end < 0) { addText(source.slice(lt)); break; }

    const inner = source.slice(lt + 1, end);
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner);
    if (!nameMatch) {
      // A `<` that does not begin a tag is a `<` in the prose. Only the
      // character itself is consumed: `5 < 6</p>` found its `>` in the CLOSE
      // TAG, so taking everything up to it as text would eat the `</p>` and
      // leave the paragraph open for the rest of the document.
      addText('<');
      i = lt + 1;
      continue;
    }

    const tag = nameMatch[1].toLowerCase();
    const attrs = parseAttrs(inner.slice(tag.length).replace(/\/$/, ''));

    while (AUTO_CLOSE[top().tag]?.has(tag)) stack.pop();

    const node = { tag, attrs, children: [] };
    top().children.push(node);
    i = end + 1;

    if (VOID.has(tag) || inner.trimEnd().endsWith('/')) continue;

    if (RAW_TEXT.has(tag)) {
      // Raw text runs to the close tag verbatim -- entities are not decoded
      // inside a stylesheet, where `&` has no such meaning.
      const closer = `</${tag}`;
      const at = source.toLowerCase().indexOf(closer, i);
      const stop = at < 0 ? source.length : at;
      if (stop > i) node.children.push({ text: source.slice(i, stop) });
      const after = at < 0 ? source.length : source.indexOf('>', at);
      i = after < 0 ? source.length : after + 1;
      continue;
    }

    stack.push(node);
  }

  return root;
}

/** Depth-first walk over every element in a tree. */
export function* elements(node) {
  for (const child of node.children ?? []) {
    if (child.tag === undefined) continue;
    yield child;
    yield* elements(child);
  }
}

/** The concatenated text of a node and everything under it. */
export function textOf(node) {
  if (node.text !== undefined) return node.text;
  let out = '';
  for (const child of node.children ?? []) out += textOf(child);
  return out;
}

/**
 * `.c3 { font-weight: 700 }` -> `Map { c3 => { 'font-weight': '700' } }`.
 *
 * This exists because Google's HTML export does not use `<b>` and `<i>`. It
 * emits `<span class="c3">` and puts the boldness in a stylesheet at the top
 * of the document, so a converter that only looks at tags and inline `style`
 * attributes reads a Google Doc as entirely unformatted -- which is the single
 * most surprising way this feature could fail.
 *
 * At-rules are skipped over as balanced blocks. `@import` for a web font and
 * `@page` for the paper size both appear in real exports, and a naive
 * `selector { ... }` regex reads the inside of `@media print { ... }` as
 * top-level rules.
 */
export function parseCss(css) {
  const out = new Map();
  const source = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;

  const skipBlock = (from) => {
    let depth = 0;
    for (let j = from; j < source.length; j++) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}' && --depth === 0) return j + 1;
    }
    return source.length;
  };

  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;

    if (source[i] === '@') {
      const brace = source.indexOf('{', i);
      const semi = source.indexOf(';', i);
      // `@import url(...);` ends at the semicolon; `@media ... { }` at a block.
      if (semi >= 0 && (brace < 0 || semi < brace)) { i = semi + 1; continue; }
      if (brace < 0) break;
      i = skipBlock(brace);
      continue;
    }

    const brace = source.indexOf('{', i);
    if (brace < 0) break;
    const close = source.indexOf('}', brace);
    const selectors = source.slice(i, brace);
    const decls = parseDeclarations(source.slice(brace + 1, close < 0 ? source.length : close));
    i = close < 0 ? source.length : close + 1;
    if (!Object.keys(decls).length) continue;

    for (const selector of selectors.split(',')) {
      // `.c1` and `p.c1` both name a class this document uses. A selector with
      // a combinator in it is skipped: honouring `.c1 .c2` would mean matching
      // ancestors, and Google's export has no such rule to honour.
      const match = /^[a-zA-Z0-9]*\.([\w-]+)$/.exec(selector.trim());
      if (!match) continue;
      const existing = out.get(match[1]);
      // Later rules win, as they do in CSS.
      out.set(match[1], existing ? { ...existing, ...decls } : decls);
    }
  }

  return out;
}

/** `a: 1; b: 2` -> `{ a: '1', b: '2' }`. Property names are lowercased. */
export function parseDeclarations(text) {
  const out = {};
  for (const part of String(text ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon < 1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}
