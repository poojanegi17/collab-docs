/**
 * Renders formatting as CodeMirror decorations.
 *
 * CodeMirror's document is plain text and always will be -- attributes live in
 * the sync layer's RichText, and this file is the only thing that turns them
 * into something visible. That split is deliberate: the editor never becomes a
 * second place where the document's formatting is stored, so it can never
 * disagree with the replica.
 *
 * It is also why this file is engine-agnostic. It takes a RichText and knows
 * nothing about where it came from; CRDT and OT produce the same type, so both
 * engines render through exactly this code.
 *
 * Three kinds of decoration, because there are three kinds of attribute:
 *
 *   inline flag    bold, italic, underline, code, strike, sup, sub
 *                  a class over a character range
 *
 *   inline value   font, size, color, highlight, link
 *                  a STYLE over a character range, built from a value that
 *                  came off the network -- see attribute-values.js, which is
 *                  where that value is made safe
 *
 *   line           header, quote, list, align, indent, spacing
 *                  carried on the newline ENDING the line (see ADR-006), so to
 *                  decorate line N we read the attributes at its final character
 */
import { LINE_ATTRIBUTES, MAX_INDENT, EMBED_CHAR, CELL_SEPARATOR } from '@collab/ot';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import {
  safeAlign, safeColor, safeFont, safeIndent, safeLink, safeList, safeSize, safeSpacing,
  safeImageSrc, safeAlt, safeImageWidth, safeTableId,
} from './attribute-values.js';

/** Push a new RichText in; the decorations rebuild from it. */
export const setRichDoc = StateEffect.define();

/** Attributes rendered as a class over a range of characters. */
export const INLINE_FLAG_MARKS = ['bold', 'italic', 'underline', 'code', 'strike', 'sup', 'sub'];

/**
 * Attributes rendered as a style over a range, built from their value.
 *
 * Split from the flags because the two differ in the only way that matters
 * here: a flag renders as a fixed class this file wrote, a value renders as
 * CSS derived from something a collaborator typed. Every one of these passes
 * through a sanitiser before it reaches the DOM.
 */
export const INLINE_VALUE_MARKS = ['font', 'size', 'color', 'highlight', 'link'];

/** Every character-level attribute. What "clear formatting" has to remove. */
export const INLINE_MARKS = [...INLINE_FLAG_MARKS, ...INLINE_VALUE_MARKS];

/**
 * Attributes that describe a whole line, stored on its trailing newline.
 * Shared with the document model rather than restated -- the sync bindings
 * need the same list to stop typed text inheriting them.
 */
export const LINE_MARKS = LINE_ATTRIBUTES;

const flagDecoration = new Map(
  INLINE_FLAG_MARKS.map((name) => [name, Decoration.mark({ class: `cm-fmt-${name}` })]));

/**
 * Decorations for value-carrying attributes, cached by `name:value`.
 *
 * Cached because `build` runs on every document change and CodeMirror compares
 * decorations by identity when it diffs -- constructing a fresh
 * `Decoration.mark` per run per keystroke would make every styled range look
 * changed and force it to redraw the DOM for text that did not move.
 *
 * `null` is cached too: an unsafe value should be rejected once, not on every
 * rebuild for as long as it sits in the document.
 */
const valueDecoration = new Map();

function decorationFor(name, value) {
  const key = `${name}:${value}`;
  if (valueDecoration.has(key)) return valueDecoration.get(key);

  let spec = null;
  switch (name) {
    case 'font': {
      const css = safeFont(value);
      if (css) spec = Decoration.mark({ attributes: { style: `font-family: ${css}` } });
      break;
    }
    case 'size': {
      const size = safeSize(value);
      // A line's height has to grow with its text or a large run overlaps the
      // line above it -- CodeMirror lays lines out from the content's own box.
      if (size) spec = Decoration.mark({ attributes: { style: `font-size: ${size}px; line-height: 1.35` } });
      break;
    }
    case 'color': {
      const color = safeColor(value);
      if (color) spec = Decoration.mark({ attributes: { style: `color: ${color}` } });
      break;
    }
    case 'highlight': {
      const color = safeColor(value);
      if (color) spec = Decoration.mark({ attributes: { style: `background-color: ${color}` } });
      break;
    }
    case 'link': {
      const href = safeLink(value);
      if (href) {
        // A class, not an <a>. CodeMirror owns the DOM inside the content and
        // a real anchor would let the browser navigate on a plain click,
        // taking the editor with it mid-edit. The href rides along as a data
        // attribute and `linkClicks` below opens it deliberately.
        spec = Decoration.mark({ class: 'cm-fmt-link', attributes: { 'data-href': href } });
      }
      break;
    }
    default: break;
  }

  valueDecoration.set(key, spec);
  return spec;
}

/**
 * An image, drawn over the single character that represents it.
 *
 * `Decoration.replace` rather than a `widget` beside the text: the character
 * IS the image (ADR-013), so it must not also render as a visible object
 * replacement glyph next to the picture.
 */
class ImageWidget extends WidgetType {
  constructor(src, alt, width) {
    super();
    this.src = src;
    this.alt = alt;
    this.width = width;
  }

  /**
   * CodeMirror reuses a widget's DOM when `eq` says two are the same. Without
   * this the <img> is rebuilt on every keystroke anywhere in the document,
   * which re-requests the picture and makes it flicker while you type.
   */
  eq(other) {
    return other.src === this.src && other.alt === this.alt && other.width === this.width;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-embed-image';
    const img = document.createElement('img');
    img.src = this.src;
    // Set as a property, so it can never become markup.
    img.alt = this.alt;
    img.style.width = `${this.width}%`;
    img.draggable = false;
    // A broken URL must not collapse to a zero-height box that cannot be
    // selected or deleted -- the character is still there and the user needs
    // somewhere to click.
    img.addEventListener('error', () => { wrap.classList.add('is-broken'); });
    wrap.appendChild(img);
    return wrap;
  }

  /** Clicks belong to the editor: this is a character, and it is selectable. */
  ignoreEvent() { return false; }
}

const imageDecoration = new Map();

function imageDecorationFor(attrs) {
  const src = safeImageSrc(attrs.image);
  if (!src) return null;
  const alt = safeAlt(attrs.alt);
  const width = safeImageWidth(attrs.width);
  const key = `${src}|${alt}|${width}`;
  if (!imageDecoration.has(key)) {
    imageDecoration.set(key, Decoration.replace({ widget: new ImageWidget(src, alt, width) }));
  }
  return imageDecoration.get(key);
}

/**
 * Cells are placed into an explicit grid column rather than laid out in order.
 *
 * The obvious implementation -- a flex row whose children are the cells -- has
 * a hole in it: an EMPTY cell has no range, so it produces no element, and the
 * column silently collapses. Adding a zero-length widget to stand in for it
 * looked right and was worse: removing that widget as the cell stops being
 * empty moves the caret, so typing the second character of a value in an empty
 * cell put it on the next line. Reproducible, and invisible until you type
 * more than one character.
 *
 * With `grid-template-columns` the tracks exist whether or not anything is in
 * them, so an empty cell needs no element at all and there is nothing to
 * remove out from under the caret.
 */
const cellDecoration = cachedByColumn('cm-cell');
const cellSepDecoration = cachedByColumn('cm-cell-sep');

function cachedByColumn(className) {
  // Cached for the reason `valueDecoration` is: `build` runs on every change,
  // and CodeMirror compares decorations by identity when it diffs.
  const cache = new Map();
  return (column) => {
    if (!cache.has(column)) {
      cache.set(column, Decoration.mark({
        class: className,
        attributes: { style: `grid-column: ${column + 1}` },
        // The cell must be the OUTERMOST span over its range, because it is
        // the grid item. A bold cell has an inline mark covering exactly the
        // same characters, and whichever of the two ends up outside becomes
        // the item -- with the bold span outside, it has no `grid-column`, and
        // auto-placement drops the whole cell onto its own row. Marking the
        // cell inclusive on both sides widens it by a hair, which is enough to
        // make it strictly contain anything sharing its range.
        inclusiveStart: true,
        inclusiveEnd: true,
      }));
    }
    return cache.get(column);
  };
}

/**
 * Ctrl/Cmd-click opens a link.
 *
 * Modifier-click rather than plain click, for the same reason word processors
 * do it: inside an editor a click is how you put the caret somewhere, and
 * stealing that from the middle of a sentence makes the text hard to edit.
 *
 * The href is re-checked here even though nothing unsafe can be in the
 * attribute -- it was sanitised on the way in. Cheap, and it means the safety
 * of this handler does not depend on a promise made in another function.
 */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(event) {
    if (!event.metaKey && !event.ctrlKey) return false;
    const el = event.target instanceof Element ? event.target.closest('[data-href]') : null;
    const href = el && safeLink(el.getAttribute('data-href'));
    if (!href) return false;
    event.preventDefault();
    // noopener: the opened page must not get a handle on this one.
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  },
});

/**
 * The classes describing one line, from the attributes on its trailing
 * newline. Returns the class string and, for a numbered item, the number to
 * render -- which the caller computes, because it depends on the lines above.
 */
function lineClassesFor(attrs) {
  if (!attrs) return null;
  const classes = [];

  const header = Number(attrs.header);
  if (header >= 1 && header <= 3) classes.push(`cm-fmt-header-${header}`);
  if (attrs.quote) classes.push('cm-fmt-quote');

  // `list` is the current model; `bullet: true` is what documents written
  // before ordered lists existed still carry. Both render.
  const list = safeList(attrs.list) ?? (attrs.bullet ? 'bullet' : null);
  if (list) classes.push(`cm-fmt-list-${list}`);

  const align = safeAlign(attrs.align);
  if (align) classes.push(`cm-fmt-align-${align}`);

  const spacing = safeSpacing(attrs.spacing);
  if (spacing) classes.push(`cm-fmt-spacing-${spacing}`);

  const indent = safeIndent(attrs.indent, MAX_INDENT);
  if (indent) classes.push(`cm-fmt-indent-${indent}`);

  // A table row is just a line that says which table it belongs to. Whether it
  // is the FIRST or LAST row of that table is a fact about its neighbours, so
  // it is decided in `build` where they are visible -- the same shape as
  // ordered-list numbering.
  const table = safeTableId(attrs.table);
  if (table) classes.push('cm-fmt-table-row');

  return classes.length ? { classes: classes.join(' '), list, indent, table } : null;
}

/**
 * Build the decoration set for one document state.
 *
 * Collected into an array and sorted at the end rather than pushed through a
 * `RangeSetBuilder`, which requires strictly ascending order and throws
 * otherwise.
 *
 * The builder was fine while every decoration came from one ascending pass. It
 * stopped being fine with tables: a row's cell decorations span the whole
 * line, and the inline marks for the runs inside that row then start again at
 * the line's beginning -- which is an ordering violation the moment a cell
 * contains anything formatted. It surfaced as "Ranges must be added sorted by
 * from position" from putting an image inside a table cell, and it would have
 * surfaced just as well from bolding a word in one.
 *
 * `Decoration.set(ranges, true)` sorts by position AND by side, which is the
 * part that is easy to get wrong by hand -- a replace and a mark starting at
 * the same offset are not interchangeable.
 */
function build(doc, rich) {
  /** @type {import('@codemirror/state').Range[]} */
  const ranges = [];
  const add = (from, to, decoration) => ranges.push(decoration.range(from, to));
  if (!rich) return Decoration.none;

  // ---- line decorations, in line order -----------------------------------
  // Collected first and merged below, so that everything is still emitted in
  // one ascending pass.
  const lineInfo = new Map();
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    // The attributes of the newline that ends this line. The final line of a
    // document usually has none, which is why applying a heading there inserts
    // one first -- see applyLine in format-commands.js.
    const attrs = line.to < doc.length ? attributesAt(rich, line.to) : undefined;
    const info = lineClassesFor(attrs);
    if (info) lineInfo.set(n, info);
  }

  // ---- ordered-list numbering --------------------------------------------
  // A number is a fact about the lines ABOVE a line, not about the line, so it
  // cannot come from the attribute alone. Counting restarts when the run of
  // numbered items at this indent level is broken -- otherwise two separate
  // lists further apart in the document share one sequence, and the second one
  // starts at 7.
  for (let n = 1; n <= doc.lines; n++) {
    const info = lineInfo.get(n);
    if (info?.list !== 'number') continue;
    const above = lineInfo.get(n - 1);
    info.number = (above?.list === 'number' && above.indent === info.indent)
      ? (above.number ?? 1) + 1
      : 1;
  }

  // ---- table geometry -----------------------------------------------------
  // Column count is uniform across a table and taken from its widest row, so a
  // short row renders trailing empty space rather than wider cells. It is a
  // RENDERING rule, not a stored one -- two replicas mid-edit can briefly
  // disagree about a row without disagreeing about the document (ADR-013).
  const widest = new Map();
  for (let n = 1; n <= doc.lines; n++) {
    const info = lineInfo.get(n);
    if (!info?.table) continue;
    const cells = countCells(doc.line(n).text);
    widest.set(info.table, Math.max(widest.get(info.table) ?? 1, cells));
  }
  for (let n = 1; n <= doc.lines; n++) {
    const info = lineInfo.get(n);
    if (!info?.table) continue;
    info.columns = widest.get(info.table);
    if (lineInfo.get(n - 1)?.table !== info.table) info.classes += ' cm-fmt-table-first';
    if (lineInfo.get(n + 1)?.table !== info.table) info.classes += ' cm-fmt-table-last';
  }

  // ---- interleave line and inline decorations, ascending ------------------
  const runs = rich.runs;
  let runIndex = 0;
  let runStart = 0;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const info = lineInfo.get(n);
    if (info) {
      // The marker text is passed as a custom property rather than generated
      // by a CSS counter: a counter cannot be restarted from here, and the
      // restart is the whole reason the numbering is computed above.
      const styles = [];
      if (info.number) styles.push(`--list-n: "${info.number}"`);
      if (info.columns) styles.push(`--cols: ${info.columns}`);
      const spec = styles.length
        ? { class: info.classes, attributes: { style: styles.join('; ') } }
        : { class: info.classes };
      add(line.from, line.from, Decoration.line(spec));
    }

    // ---- cells --------------------------------------------------------------
    // Emitted before the inline marks on this line so everything stays in
    // ascending order. Cells and separators do not overlap: each cell covers
    // the text between two separators, and each separator is its own one-
    // character mark. Overlapping them would make CodeMirror split one cell
    // into two sibling spans, and the row is a flex container whose children
    // are exactly its cells.
    if (info?.table) {
      const text = line.text;
      let cellStart = 0;
      let column = 0;
      for (let i = 0; i <= text.length; i++) {
        if (i < text.length && text[i] !== CELL_SEPARATOR) continue;
        // Nothing is emitted for an empty cell. Its column exists anyway,
        // because the track is declared on the line.
        if (i > cellStart) {
          add(line.from + cellStart, line.from + i, cellDecoration(column));
        }
        if (i < text.length) {
          // The separator character renders AS the column divider, sharing the
          // track of the cell it follows and pinned to its right edge. It stays
          // a real caret position, so arrow keys still walk the row one
          // character at a time and Home/End still mean what they always meant.
          add(line.from + i, line.from + i + 1, cellSepDecoration(column));
        }
        cellStart = i + 1;
        column++;
      }
    }

    // Emit the inline marks that fall inside this line.
    while (runIndex < runs.length && runStart < line.to) {
      const run = runs[runIndex];
      const runEnd = runStart + run.text.length;
      const from = Math.max(runStart, line.from);
      const to = Math.min(runEnd, line.to);

      // An image replaces its character outright, so none of the character
      // formatting below applies to it -- bolding an image means nothing.
      if (to > from && run.attributes?.image) {
        const decoration = imageDecorationFor(run.attributes);
        if (decoration) {
          add(from, to, decoration);
          if (runEnd > line.to) break;
          runStart = runEnd;
          runIndex++;
          continue;
        }
      }

      if (to > from && run.attributes) {
        for (const name of INLINE_FLAG_MARKS) {
          if (run.attributes[name]) add(from, to, flagDecoration.get(name));
        }
        for (const name of INLINE_VALUE_MARKS) {
          const value = run.attributes[name];
          if (value == null) continue;
          const decoration = decorationFor(name, value);
          // No decoration means the value did not survive its sanitiser. The
          // text still renders; only the formatting is dropped.
          if (decoration) add(from, to, decoration);
        }
      }
      if (runEnd > line.to) break;   // this run continues onto the next line
      runStart = runEnd;
      runIndex++;
    }
  }

  return Decoration.set(ranges, true);
}

/** How many cells a row's text describes. One more than its separators. */
function countCells(text) {
  let cells = 1;
  for (const ch of text) if (ch === CELL_SEPARATOR) cells++;
  return cells;
}

/** Attributes of the character at `index`. */
function attributesAt(rich, index) {
  let at = 0;
  for (const run of rich.runs) {
    const end = at + run.text.length;
    if (index < end) return run.attributes;
    at = end;
  }
  return undefined;
}

/**
 * The decoration field. Holds the RichText alongside the built set so that a
 * plain typing transaction can rebuild positions without waiting for the sync
 * layer to hand back a new document.
 */
export const richMarks = StateField.define({
  create() {
    return { rich: null, decorations: Decoration.none };
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setRichDoc)) {
        return { rich: effect.value, decorations: build(tr.state.doc, effect.value) };
      }
    }
    if (tr.docChanged && value.rich) {
      // Text moved but no new RichText has arrived yet. Rebuilding against the
      // stale runs would put marks at the wrong offsets, so map the existing
      // set forward instead and let the next setRichDoc correct it.
      return { rich: value.rich, decorations: value.decorations.map(tr.changes) };
    }
    return value;
  },

  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Everything the editor needs to render formatting. */
export const richTextExtensions = [richMarks, linkClicks];

/**
 * The line attributes of line `n`, for commands that act on several lines at
 * once and cannot assume they all start from the same formatting.
 *
 * Indent is the reason this exists: "indent further" means +1 from whatever
 * each line already has, so applying one value to the whole selection would
 * flatten a nested list into a straight one.
 */
export function lineAttributes(state, n) {
  const { rich } = state.field(richMarks, false) ?? {};
  if (!rich) return {};
  const line = state.doc.line(n);
  if (line.to >= state.doc.length) return {};
  return pick(attributesAt(rich, line.to) ?? {}, LINE_MARKS);
}

/** The attributes currently under the caret -- what the toolbar highlights. */
export function activeAttributes(state) {
  const { rich } = state.field(richMarks, false) ?? {};
  if (!rich) return {};
  const sel = state.selection.main;
  // Inline marks come from the character before the caret -- which, at the
  // start of a line, is the PRECEDING line's newline and therefore carries
  // that line's block formatting. Taking only the inline keys is what stops a
  // bulleted line above from reporting the line below as bulleted too, which
  // would make the toolbar button toggle the wrong way.
  const inline = attributesAt(rich, sel.empty ? Math.max(0, sel.from - 1) : sel.from) ?? {};
  const line = state.doc.lineAt(sel.from);
  const lineAttrs = (line.to < state.doc.length ? attributesAt(rich, line.to) : undefined) ?? {};
  return { ...pick(inline, INLINE_MARKS), ...pick(lineAttrs, LINE_MARKS) };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] != null) out[k] = obj[k];
  return out;
}
