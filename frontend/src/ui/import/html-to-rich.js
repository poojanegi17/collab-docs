/**
 * HTML -> RichText. The import side of `export-markdown.js`.
 *
 * Engine-agnostic by construction, like the exporter and like `marks.js`: it
 * produces a RichText and never learns which engine will carry it. That is
 * what lets an imported document be opened under the CRDT or the OT server
 * without this file knowing either exists.
 *
 * WHAT THIS IS FOR. Drive hands a document back as HTML (`files.export`), and
 * that markup arrives here. What lands is an INDEPENDENT document: from the
 * moment it does there is no link back to Drive, no sync, and no shared
 * authority. See ADR-020 for why that is the only honest version of this
 * feature -- a live bridge would mean two concurrency-control systems
 * arbitrating one document, with the other one winning, which is precisely the
 * arrangement the rest of this project exists to avoid.
 *
 * THE MODEL IT TARGETS. A RichText is a flat list of runs, and line-level
 * formatting rides on the newline that ENDS a line (ADR-006). Incoming HTML is
 * a tree. So this is a flattening, and flattening into a flat model is the
 * easy direction -- there is no block tree to reconcile, which is the payoff
 * ADR-013 was arguing for.
 *
 * WHAT IS DROPPED, AND WHY IT IS COUNTED. Nothing here is silently discarded.
 * Every attribute that cannot be expressed in the vocabulary of ADR-011 is
 * recorded in a loss report, and `describeImportLoss` turns that into a
 * sentence the import dialog says out loud -- the same bargain
 * `describeLoss` makes on the way out. An importer that quietly halves a
 * document is worse than one that refuses, and much worse than one that tells
 * you.
 */
import { RichText, EMBED_CHAR, MAX_INDENT } from '@collab/ot';
import {
  safeColor, safeLink, safeSize, safeAlign, safeSpacing,
  safeImageSrc, safeAlt, safeImageWidth, FONTS,
} from '../attribute-values.js';
import { parseHtml, parseCss, parseDeclarations, textOf } from './html-parse.js';

/** Elements that end the current line. Everything else is inline. */
const BLOCK = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li',
  'pre', 'section', 'article', 'header', 'footer', 'main', 'figure',
  'figcaption', 'dt', 'dd', 'td', 'th',
]);

/** Elements whose content is not document text at all. */
const SKIP = new Set(['head', 'style', 'script', 'meta', 'title', 'link', 'noscript']);

/**
 * Font families mapped onto the six keys the document vocabulary has.
 *
 * The document stores a KEY and looks the stack up locally (ADR-011), so an
 * imported font either becomes one of these or becomes nothing. Matching is on
 * the first family in the stack, lowercased -- `"Times New Roman", serif` is a
 * Times document whatever its fallbacks say.
 */
const FONT_ALIASES = {
  arial: 'sans', helvetica: 'sans', 'helvetica neue': 'sans', verdana: 'sans',
  tahoma: 'sans', calibri: 'sans', roboto: 'sans', 'open sans': 'sans', lato: 'sans',
  'times new roman': 'serif', times: 'serif', georgia: 'serif', garamond: 'serif',
  cambria: 'serif', 'book antiqua': 'serif', palatino: 'serif',
  'courier new': 'mono', courier: 'mono', consolas: 'mono', monaco: 'mono',
  'roboto mono': 'mono', menlo: 'mono',
  nunito: 'rounded', 'comic sans ms': 'rounded',
  'arial narrow': 'condensed', 'roboto condensed': 'condensed',
};

/**
 * What Google Docs considers unremarkable, which this importer therefore does
 * not record.
 *
 * The rule is: an import carries a document's DEVIATIONS from normal, not its
 * normal. Google's export states every property on every span, so without this
 * every single character would arrive carrying `color: #000000`, `size: 11`
 * and `font: sans`, and the document would be pinned to Google's defaults
 * forever instead of picking up this app's typography.
 *
 * The colour is the one that is not merely untidy. This app has a dark theme.
 * A document whose every run explicitly says black renders as black text on a
 * dark background -- an imported document that is invisible, which reads as a
 * broken importer rather than as a faithful one.
 */
const DEFAULT_SIZE_PT = 11;
const DEFAULT_FONT = 'sans';
/**
 * Google Docs' default line spacing, which it writes onto every paragraph.
 * Importing it would put an explicit spacing on every line of every document
 * for the same reason 11pt would put an explicit size on every character.
 */
const DEFAULT_LINE_HEIGHT = 1.15;
const DEFAULT_COLORS = new Set(['#000000', '#000', 'rgb(0,0,0)', 'rgb(0, 0, 0)']);

/** The colour Google paints every link. See `emit`. */
const LINK_BLUE = '#1155cc';

/**
 * Marks "this run is inside an anchor" while walking. A Symbol rather than a
 * string key so it cannot be mistaken for -- or accidentally emitted as -- a
 * document attribute: `Object.entries` does not see it, which is exactly the
 * property that keeps it out of the RichText.
 */
const IN_LINK = Symbol('in-link');

/**
 * The width of the text column on Google's default page: US Letter, one-inch
 * margins, in points. Image widths arrive as absolute lengths and the document
 * model stores a percentage of the page (ADR-011), so converting between them
 * needs a page to be a percentage OF.
 */
const PAGE_WIDTH_PT = 468;

/** One indent level, in points. Google Docs indents by half an inch. */
const INDENT_PT = 36;

// ---- CSS value readers ------------------------------------------------------

/** `12pt`, `16px`, `1.5em` -> points. Returns null for anything else. */
function toPoints(value) {
  const match = /^(-?[\d.]+)\s*(pt|px|in|cm|mm|em|rem)?$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  switch (match[2]) {
    case 'px': return n * 0.75;
    case 'in': return n * 72;
    case 'cm': return n * 28.3465;
    case 'mm': return n * 2.83465;
    // Relative to the surrounding font, which here is the document default.
    case 'em': case 'rem': return n * DEFAULT_SIZE_PT;
    default: return n;
  }
}

/**
 * A CSS colour -> `#rrggbb`, or null.
 *
 * Only the two forms that actually come out of Google -- hex and `rgb()`. The
 * result still goes through `safeColor`, so this function widens what is
 * RECOGNISED without widening what is TRUSTED: the allowlist at the render
 * boundary is still the thing deciding, exactly as ADR-011 requires.
 */
function toHexColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(text);
  if (!rgb) return null;
  const hex = (n) => Math.min(255, Number(n)).toString(16).padStart(2, '0');
  return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`;
}

/**
 * Google's export does not link where the document links.
 *
 * Every external href is rewritten to
 * `https://www.google.com/url?q=REAL&sa=D&source=...`, a redirector that
 * counts the click. Importing those verbatim would mean every link in every
 * imported document points at Google, keeps working only as long as that
 * redirector does, and leaks the reader's navigation to a third party. So the
 * real target is unwrapped before anything else looks at it.
 */
function unwrapGoogleRedirect(href) {
  const text = String(href ?? '');
  if (!/^https?:\/\/(www\.)?google\.com\/url\?/i.test(text)) return text;
  try {
    const inner = new URL(text).searchParams.get('q');
    return inner || text;
  } catch {
    return text;
  }
}

// ---- style -> attributes ----------------------------------------------------

/**
 * Inline attributes implied by a set of CSS declarations.
 *
 * `false` is meaningful in the result and is not the same as absent: a span
 * saying `font-weight: 400` inside a bold paragraph has to be able to turn
 * boldness OFF, and Google's export relies on exactly that. The falsy keys are
 * stripped at the point a run is emitted, not here.
 */
function marksFromDeclarations(decls, loss) {
  const out = {};
  if (!decls) return out;

  const weight = decls['font-weight'];
  if (weight !== undefined) {
    const n = Number(weight);
    out.bold = weight === 'bold' || weight === 'bolder' || (Number.isFinite(n) && n >= 600);
  }

  const style = decls['font-style'];
  if (style !== undefined) out.italic = style === 'italic' || style === 'oblique';

  // `text-decoration` is shorthand and may carry a colour and a style as well
  // as the line, so it is searched rather than compared.
  const decoration = `${decls['text-decoration'] ?? ''} ${decls['text-decoration-line'] ?? ''}`;
  if (decoration.trim()) {
    out.underline = decoration.includes('underline');
    out.strike = decoration.includes('line-through');
  }

  const vertical = decls['vertical-align'];
  if (vertical === 'super') out.sup = true;
  else if (vertical === 'sub') out.sub = true;
  else if (vertical !== undefined) { out.sup = false; out.sub = false; }

  if (decls.color !== undefined) {
    const hex = toHexColor(decls.color);
    // Black is the document default, not a formatting choice. See DEFAULT_COLORS.
    out.color = hex && !DEFAULT_COLORS.has(hex) ? (safeColor(hex) ?? false) : false;
    if (hex && !DEFAULT_COLORS.has(hex) && !safeColor(hex)) loss.note('text colours');
  }

  const background = decls['background-color'];
  if (background !== undefined) {
    const hex = /transparent|^#ffffff$|^#fff$/i.test(background.trim())
      ? null
      : toHexColor(background);
    out.highlight = hex ? (safeColor(hex) ?? false) : false;
  }

  const size = decls['font-size'];
  if (size !== undefined) {
    const points = toPoints(size);
    if (points === null) out.size = false;
    else if (Math.round(points) === DEFAULT_SIZE_PT) out.size = false;
    else {
      const safe = safeSize(points);
      out.size = safe ?? false;
      // A size outside 6..96 is a real value this vocabulary refuses to carry,
      // as opposed to a value it simply considers unremarkable.
      if (!safe) loss.note('font sizes');
    }
  }

  const family = decls['font-family'];
  if (family !== undefined) {
    const first = family.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();
    const key = FONT_ALIASES[first] ?? (Object.hasOwn(FONTS, first) ? first : null);
    out.font = key && key !== DEFAULT_FONT ? key : false;
    if (!key && first) loss.note('fonts');
  }

  return out;
}

/** Line attributes implied by a block element's own declarations. */
function lineMarksFromDeclarations(decls, loss) {
  const out = {};
  if (!decls) return out;

  const align = safeAlign(String(decls['text-align'] ?? '').trim());
  if (align) out.align = align;

  const height = decls['line-height'];
  if (height !== undefined) {
    // Google writes a unitless multiplier. The vocabulary has three named
    // spacings and nothing between them, so anything else is reported rather
    // than rounded to the nearest -- rounding 1.3 to "1.15" is a silent lie
    // about the document.
    const n = Number(height);
    if (Number.isFinite(n) && n > 0 && Math.abs(n - DEFAULT_LINE_HEIGHT) > 0.005) {
      const spacing = safeSpacing(String(Math.round(n * 100)));
      if (spacing) out.spacing = spacing;
      else if (Math.abs(n - 1) > 0.01) loss.note('line spacing');
    }
  }

  const margin = toPoints(decls['margin-left']) ?? toPoints(decls['padding-left']);
  if (margin && margin > 0) {
    const levels = Math.round(margin / INDENT_PT);
    if (levels > 0) out.indent = Math.min(levels, MAX_INDENT);
  }

  return out;
}

// ---- the loss report --------------------------------------------------------

function newLoss() {
  const counts = new Map();
  return {
    counts,
    note(what, n = 1) { counts.set(what, (counts.get(what) ?? 0) + n); },
  };
}

/**
 * Singular and plural wording for each thing that can be lost.
 *
 * A pair per kind rather than a suffix rule, because "1 tables flattened to
 * paragraphs" is the sort of detail that makes a careful message look
 * careless, and because none of these pluralise by adding an `s` to the end of
 * the phrase anyway.
 */
const LOSS_LABELS = {
  fonts: ['font dropped', 'fonts dropped'],
  'font sizes': ['font size dropped', 'font sizes dropped'],
  'text colours': ['text colour dropped', 'text colours dropped'],
  'line spacing': ['line spacing dropped', 'line spacings dropped'],
  links: ['link dropped', 'links dropped'],
  images: ['image dropped', 'images dropped'],
  'horizontal rules': ['horizontal rule dropped', 'horizontal rules dropped'],
  'heading levels': ['heading level flattened', 'heading levels flattened'],
  'tables flattened to paragraphs':
    ['table flattened to paragraphs', 'tables flattened to paragraphs'],
};

/**
 * The loss report as a sentence, or `''` when nothing was left behind.
 *
 * Counts are of OCCURRENCES, not of distinct values, because "3 tables" is
 * what a person can go and look for in the document and "2 distinct table
 * structures" is not.
 */
export function describeImportLoss(loss) {
  const entries = [...(loss?.counts ?? new Map())].filter(([, n]) => n > 0);
  if (!entries.length) return '';
  // Largest first: the thing most worth checking should be read first.
  entries.sort((a, b) => b[1] - a[1]);
  const parts = entries.map(([what, n]) => {
    const label = LOSS_LABELS[what] ?? [what, what];
    return `${n} ${label[n === 1 ? 0 : 1]}`;
  });
  const list = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Imported with changes: ${list}.`;
}

// ---- the walk ---------------------------------------------------------------

/**
 * Convert a document's HTML into a RichText plus a loss report.
 *
 * @param {string} html
 * @returns {{ rich: RichText, loss: { counts: Map<string, number> }, title: string }}
 */
export function htmlToRichText(html) {
  const root = parseHtml(html);
  const css = collectStylesheets(root);
  const loss = newLoss();

  /** @type {{ attrs: object, runs: {text: string, attributes?: object}[] }[]} */
  const lines = [];
  let pending = [];
  let lineAttrs = {};

  /** Emit one run onto the line being built, with the falsy marks stripped. */
  const emit = (text, marks) => {
    if (!text) return;
    const attributes = {};
    for (const [key, value] of Object.entries(marks ?? {})) {
      if (value !== false && value !== null && value !== undefined && value !== '') {
        attributes[key] = value;
      }
    }
    // A link's blue underline is how a link is RENDERED, not how the author
    // formatted it, and this app renders links its own way. Carrying Google's
    // version in means every imported link is underlined twice and pinned to a
    // blue that was never chosen. A link deliberately coloured something else
    // is a formatting decision and survives.
    if (marks?.[IN_LINK]) {
      delete attributes.underline;
      if (attributes.color === LINK_BLUE) delete attributes.color;
    }
    pending.push({ text, attributes: Object.keys(attributes).length ? attributes : undefined });
  };

  const pushLine = () => {
    // Trailing whitespace is stripped at the line boundary, as HTML itself
    // does at a block boundary. Without this, `<li>text<ul>...` imports as
    // "text  " -- once for the newline between the span and the nested list,
    // and again for the newline between the list and its first item, both of
    // which are the source file's indentation rather than the document's text.
    for (let i = pending.length - 1; i >= 0; i--) {
      const trimmed = pending[i].text.replace(/ +$/, '');
      pending[i] = { ...pending[i], text: trimmed };
      if (trimmed) break;
      pending.pop();
    }
    lines.push({ attrs: lineAttrs, runs: pending });
    pending = [];
  };

  /**
   * Run `fn` as one block: whatever it emits becomes at least one line
   * carrying `attrs`.
   *
   * The `lines.length === before` test is what keeps a list item that contains
   * a nested list from ending in a spurious empty bullet. `<li>a<ul>..</ul></li>`
   * flushes "a" when it reaches the nested list, so by the time control gets
   * back here there is nothing pending -- but lines WERE added, so no empty
   * line is owed. An empty `<p></p>` adds none, and does owe one, because a
   * blank line between paragraphs is content.
   */
  const block = (attrs, fn) => {
    if (pending.length) pushLine();
    const outerAttrs = lineAttrs;
    const before = lines.length;
    lineAttrs = attrs;
    fn();
    if (pending.length || lines.length === before) pushLine();
    lineAttrs = outerAttrs;
  };

  /** The declarations in force on an element: its classes, then its `style`. */
  const declarationsFor = (node) => {
    let out = null;
    for (const name of String(node.attrs?.class ?? '').split(/\s+/)) {
      const decls = name && css.get(name);
      if (decls) out = out ? { ...out, ...decls } : decls;
    }
    if (node.attrs?.style) {
      out = { ...(out ?? {}), ...parseDeclarations(node.attrs.style) };
    }
    return out;
  };

  /**
   * @param {object} node
   * @param {object} marks   inline attributes inherited from ancestors
   * @param {{ list: string|null, depth: number }} list
   */
  const walk = (node, marks, list) => {
    for (const child of node.children ?? []) {
      if (child.text !== undefined) {
        // HTML collapses runs of whitespace, and the markup is indented, so
        // the newlines between tags are layout rather than text. Leading
        // whitespace on an empty line is dropped for the same reason: it is
        // the indentation of the source file, not of the document.
        let text = child.text.replace(/[\t\n\r ]+/g, ' ');
        if (!pending.length && !text.trim()) continue;
        if (!pending.length) text = text.replace(/^ +/, '');
        emit(text, marks);
        continue;
      }

      const tag = child.tag;
      if (SKIP.has(tag)) continue;

      const decls = declarationsFor(child);
      const next = { ...marks, ...marksFromDeclarations(decls, loss) };

      switch (tag) {
        case 'br':
          // A soft break and a paragraph break are the same thing in a flat
          // document: both end a line, and both keep the block's formatting.
          pushLine();
          continue;

        case 'hr':
          loss.note('horizontal rules');
          continue;

        case 'b': case 'strong': next.bold = true; break;
        case 'i': case 'em': next.italic = true; break;
        case 'u': next.underline = true; break;
        case 's': case 'strike': case 'del': next.strike = true; break;
        case 'sup': next.sup = true; break;
        case 'sub': next.sub = true; break;
        case 'code': case 'kbd': case 'samp': next.code = true; break;

        case 'a': {
          const href = safeLink(unwrapGoogleRedirect(child.attrs?.href));
          if (href) next.link = href;
          // An anchor with no usable target -- a bookmark, or a `javascript:`
          // href -- keeps its text and loses its linkiness. The characters are
          // the document; the link is decoration (ADR-011).
          else if (child.attrs?.href) loss.note('links');
          // Marked whether or not the href survived, and read by `emit`. A
          // rejected `javascript:` link that kept Google's blue underline
          // would look exactly like a working link and go nowhere, which is a
          // worse outcome than either importing it or dropping it outright.
          next[IN_LINK] = true;
          break;
        }

        case 'img': {
          const src = safeImageSrc(child.attrs?.src);
          if (!src) { loss.note('images'); continue; }
          // A CSS width carries its own unit. The bare `width="600"` attribute
          // does not, and it means pixels -- reading it as points would import
          // every image at a third more than its size.
          const width = toPoints(decls?.width)
            ?? (/^\d+$/.test(child.attrs?.width ?? '')
              ? toPoints(`${child.attrs.width}px`)
              : null);
          emit(EMBED_CHAR, {
            image: src,
            alt: safeAlt(child.attrs?.alt ?? ''),
            width: width ? safeImageWidth(Math.round((width / PAGE_WIDTH_PT) * 100)) : 100,
          });
          continue;
        }

        case 'ul': case 'ol':
          // The list itself emits nothing. Its items do, and they need to know
          // which kind of list and how deep they are.
          walk(child, next, { list: tag === 'ol' ? 'number' : 'bullet', depth: list.depth + 1 });
          continue;

        case 'li': {
          const attrs = { ...lineMarksFromDeclarations(decls, loss) };
          if (list.list) {
            attrs.list = list.list;
            // Nesting depth is the indent. Google ALSO writes a margin-left
            // per level, and honouring both would indent a second-level bullet
            // twice, so the structural answer wins over the visual one.
            attrs.indent = Math.min(Math.max(0, list.depth - 1), MAX_INDENT);
            if (!attrs.indent) delete attrs.indent;
          }
          block(attrs, () => walk(child, next, list));
          continue;
        }

        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
          const level = Number(tag[1]);
          // The vocabulary has three heading levels. A deeper one is clamped
          // rather than dropped -- it is still a heading, and rendering it as
          // body text would lose the document's structure, not just its look.
          if (level > 3) loss.note('heading levels');
          block(
            { header: Math.min(level, 3), ...lineMarksFromDeclarations(decls, loss) },
            () => walk(child, next, list),
          );
          continue;
        }

        case 'blockquote':
          block({ quote: true, ...lineMarksFromDeclarations(decls, loss) },
            () => walk(child, next, list));
          continue;

        case 'pre':
          block(lineMarksFromDeclarations(decls, loss),
            () => walk(child, { ...next, code: true }, list));
          continue;

        case 'table':
          // Tables are not carried yet. Their CELLS still are: each becomes an
          // ordinary paragraph, so the words survive even though the grid does
          // not. Dropping the table outright would delete content, which is
          // the one thing an importer must never do quietly.
          loss.note('tables flattened to paragraphs');
          walk(child, next, list);
          continue;

        default: break;
      }

      if (BLOCK.has(tag)) {
        block(lineMarksFromDeclarations(decls, loss), () => walk(child, next, list));
      } else {
        walk(child, next, list);
      }
    }
  };

  const body = findBody(root) ?? root;
  walk(body, {}, { list: null, depth: 0 });
  if (pending.length) pushLine();

  return { rich: assemble(lines), loss, title: titleOf(root) };
}

/**
 * Lines -> RichText, with the line attributes on the newlines that end them.
 *
 * The last line is the awkward one. Its attributes have nowhere to live,
 * because there is no newline after it -- which is not a quirk of this
 * function but how the whole document model works (see `marks.js`, which reads
 * line attributes only when `line.to < doc.length`). So a document whose final
 * line is formatted gets one extra empty line to carry it, exactly as applying
 * a heading to the last line in the editor does.
 */
function assemble(lines) {
  // Trailing blank lines are an artefact of the exporter, not the document:
  // Google ends a file with an empty paragraph almost every time.
  while (lines.length > 1) {
    const last = lines[lines.length - 1];
    if (last.runs.length || Object.keys(last.attrs).length) break;
    lines.pop();
  }

  const rich = new RichText();
  lines.forEach((line, i) => {
    for (const run of line.runs) rich.push(run.text, run.attributes);
    const last = i === lines.length - 1;
    if (!last) rich.push('\n', Object.keys(line.attrs).length ? line.attrs : undefined);
    else if (Object.keys(line.attrs).length) rich.push('\n', line.attrs);
  });
  return rich;
}

/** Every `<style>` in the document, parsed into one class map. */
function collectStylesheets(root) {
  const out = new Map();
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (child.tag === 'style') {
        for (const [name, decls] of parseCss(textOf(child))) {
          const existing = out.get(name);
          out.set(name, existing ? { ...existing, ...decls } : decls);
        }
      } else if (child.tag !== undefined) {
        visit(child);
      }
    }
  };
  visit(root);
  return out;
}

function findBody(root) {
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (child.tag === 'body') return child;
      if (child.tag !== undefined) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root);
}

/** The `<title>`, which Drive fills with the document's name. */
function titleOf(root) {
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (child.tag === 'title') return textOf(child).trim();
      if (child.tag !== undefined) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return '';
  };
  return visit(root).replace(/\s+/g, ' ').slice(0, 200);
}
