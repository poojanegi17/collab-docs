/**
 * Pages, instead of one sheet that grows downwards forever.
 *
 * A document is a thing you print, and every word processor shows it as a
 * stack of sheets with a gap between them. This editor showed one continuous
 * white column, which reads as a text box rather than as a document -- and it
 * meant nothing on screen corresponded to what "page 2" means.
 *
 * WHAT THIS IS NOT: it is not a print layout. There is no page size negotiated
 * with a printer, no headers or footers, no widow and orphan control. It is
 * the page GEOMETRY -- US Letter at 96dpi -- applied to the editor so that the
 * text breaks where a page would break and the sheets are drawn behind it.
 *
 * THE LIMIT WORTH KNOWING: pages break BETWEEN paragraphs, never inside one.
 * A paragraph is a single line to CodeMirror -- wrapping is a rendering
 * detail, not a document one -- and a block widget can only be placed between
 * lines. So a paragraph that does not fit on the rest of a page moves onto the
 * next one whole, and the page it left ends early. On a wide screen that is a
 * few lines of white; on a phone, where a paragraph can be fifteen lines tall,
 * it can be a third of a page. A word processor splits the paragraph instead,
 * and doing the same here would mean breaking a line into fragments the
 * document model does not have -- which would put a rendering concern inside
 * the text, exactly where ADR-006 and marks.js keep it out.
 *
 * The mechanism has two halves, and they are deliberately different kinds of
 * thing:
 *
 *   the sheets   a repeating background on the content. Pages are scenery:
 *                they are not in the document, nothing can select them, and
 *                they cost nothing to paint. Drawing them as real elements
 *                would mean N more DOM nodes that exist only to be white.
 *
 *   the breaks   real block widgets, because they have to take up space. This
 *                is the half that makes it honest: a line that would straddle
 *                the boundary is PUSHED onto the next page, rather than being
 *                allowed to sit across the gap with the sheet edge through the
 *                middle of it.
 *
 * Engine-agnostic, like `marks.js` and for the same reason: it reads geometry
 * and knows nothing about where the text came from.
 */
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';

/**
 * US Letter at 96dpi -- 8.5in x 11in with 1in margins.
 *
 * In CSS pixels rather than inches because everything else about this editor
 * is in pixels and a unit change here would be a unit change in six places.
 * Exported so the stylesheet's page width and this file's page height cannot
 * drift apart: the sheet is drawn from PAGE_HEIGHT and the text is broken from
 * CONTENT_HEIGHT, and if those two disagree the break lands in the wrong place
 * on every page after the first.
 */
export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
export const PAGE_MARGIN = 96;
/** The visible channel between two sheets. */
export const PAGE_GAP = 26;
/** How much text one page holds. */
export const CONTENT_HEIGHT = PAGE_HEIGHT - PAGE_MARGIN * 2;
/** Bottom margin, gap, top margin: what a break has to cross at minimum. */
const BREAK_BASE = PAGE_MARGIN + PAGE_GAP + PAGE_MARGIN;

/**
 * The space between the last line of one page and the first line of the next.
 *
 * Its height is the only thing about it that matters, so `eq` compares heights
 * and nothing else -- CodeMirror reuses a widget's DOM when `eq` says two are
 * the same, and a break that rebuilt on every keystroke would drop and re-add
 * a block on every keystroke, which the height map then has to re-measure.
 */
class PageBreak extends WidgetType {
  constructor(height) {
    super();
    this.height = height;
  }

  /** Sub-pixel differences are not worth a re-render, and they are constant. */
  eq(other) { return Math.abs(other.height - this.height) < 0.5; }

  /**
   * CodeMirror needs a height for a block it has not drawn yet, to place the
   * scrollbar and decide what is in the viewport. Without this it assumes a
   * default line height, so every break below the fold is assumed to be ~24px
   * and the scrollbar lies until you scroll into it.
   */
  get estimatedHeight() { return this.height; }

  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-page-break';
    el.style.height = `${this.height}px`;
    // Scenery. A screen reader announcing "page break" between every two
    // paragraphs would be reading out the furniture.
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  /** Nothing here is interactive; clicks belong to the text around it. */
  ignoreEvent() { return true; }
}

/**
 * Where the breaks go.
 *
 * Walks the document once, adding up line heights, and starts a new page when
 * the next line would not fit on this one. The heights come from CodeMirror's
 * height map, which is the only thing that knows how tall a wrapped paragraph
 * or an image actually is.
 *
 * `spacers` is the set of breaks the PREVIOUS pass placed, keyed by the
 * position they sit at. It exists to solve a feedback loop: a break is a block
 * in the height map, so once one is placed the lines below it report a larger
 * `top`, and a second pass that measured naively would treat the space the
 * break already inserted as content and break again immediately -- pages that
 * get shorter every time you type. Subtracting the breaks we placed ourselves
 * recovers the line's own height, which is the quantity this walk needs.
 */
function computeBreaks(view, spacers) {
  const { doc } = view.state;
  const breaks = [];
  let used = 0;

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const block = view.lineBlockAt(line.from);
    // The block for a line that carries a break reports both heights together,
    // so take ours back out.
    const height = block.height - (spacers.get(line.from) ?? 0);

    // A line taller than a whole page -- a very large image -- cannot be made
    // to fit by moving it. Give it the page it is already on and carry on,
    // rather than pushing it forward forever and never terminating.
    if (height > CONTENT_HEIGHT) {
      used = CONTENT_HEIGHT;
      continue;
    }

    // `used > 0` matters: without it, a page that begins with an over-tall
    // line would emit a break before the very first line of the document.
    if (used > 0 && used + height > CONTENT_HEIGHT) {
      breaks.push({ at: line.from, height: BREAK_BASE + (CONTENT_HEIGHT - used) });
      used = 0;
    }
    used += height;
  }

  /*
   * Pad the last page out to a whole sheet.
   *
   * Without this the content box ends wherever the text happened to stop and
   * the background -- which paints a full page every period -- is clipped
   * mid-sheet, so the document trails off instead of ending on a page.
   *
   * The `+ PAGE_MARGIN` is the last page's BOTTOM margin. Filling only to
   * CONTENT_HEIGHT ends the box at the bottom of the text area, one margin
   * short of the paper's edge, which cost the final sheet its bottom border
   * and nothing else -- the kind of gap that looks like the page is still
   * loading.
   */
  const tail = Math.max(0, CONTENT_HEIGHT - used) + PAGE_MARGIN;
  breaks.push({ at: doc.length, height: tail, tail: true });
  return breaks;
}

/** A freshly measured set of breaks, on its way into the field below. */
const setPageBreaks = StateEffect.define();

function decorationsFor(list) {
  const ranges = list.map(({ at, height, tail }) => Decoration.widget({
    widget: new PageBreak(height),
    // A page break belongs BEFORE the line it pushes down, and the trailing
    // pad belongs after the last character. `side` is what says which.
    side: tail ? 1 : -1,
    block: true,
  }).range(at));
  return Decoration.set(ranges, true);
}

/**
 * The breaks, as state.
 *
 * A StateField and not the ViewPlugin that measures them, because CodeMirror
 * refuses block decorations from a plugin -- "Block decorations may not be
 * specified via plugins". The reason is structural rather than fussy: a block
 * widget changes the height of the document, the viewport is computed from
 * those heights, and plugins are re-run when the viewport changes. Letting one
 * of them insert blocks makes that circular. State is settled before layout,
 * so the same information as a field is safe.
 *
 * Which leaves the measuring, which genuinely needs the rendered view. So the
 * two are split: the plugin below measures and DISPATCHES, this field holds
 * the result and renders it. The loop is closed by only dispatching when the
 * numbers actually changed -- see `sameBreaks`.
 */
const pageBreakField = StateField.define({
  create: () => ({ list: [], decorations: Decoration.none }),

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPageBreaks)) {
        // Clamped to the document this transaction produces. The measurement
        // was taken against the document as it was one microtask ago, and a
        // keystroke can land in between -- a position past the end throws
        // inside CodeMirror and takes the whole render with it. Same defence,
        // and the same reasoning, as the clamp in `authorship.js`.
        const len = tr.newDoc.length;
        const list = effect.value
          .filter((b) => b.at <= len)
          .map((b) => ({ ...b, at: Math.min(b.at, len) }));
        return { list, decorations: decorationsFor(list) };
      }
    }
    if (tr.docChanged) {
      // Typing has moved the text and the next measurement has not arrived.
      // Map the breaks forward rather than dropping them: dropping makes every
      // page below the caret jump up and back on each keystroke, which is the
      // same trade `marks.js` makes for exactly the same reason.
      const list = value.list.map((b) => ({ ...b, at: tr.changes.mapPos(b.at) }));
      return { list, decorations: value.decorations.map(tr.changes) };
    }
    return value;
  },

  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Have the pages actually moved? Sub-pixel drift is not a reason to redraw. */
function sameBreaks(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.at === b[i].at && Math.abs(x.height - b[i].height) < 0.5);
}

/**
 * The measuring half.
 *
 * Runs on `geometryChanged` as well as on document changes, because that is
 * the update that fires when a line's measured height replaces its estimate --
 * an image finishing loading, a font swapping in, the window being resized.
 * Those move the page breaks without changing a character.
 *
 * The work goes through `requestMeasure` rather than being done in `update`:
 * reading heights mid-update is what forces a layout in the middle of
 * CodeMirror's own, and dispatching from there is not allowed at all. The read
 * phase measures, the write phase dispatches, and `key` keeps a burst of
 * updates to one measurement.
 *
 * The pass is O(lines) with a height-map lookup each, which is fine for a
 * document somebody is reading and would not be for a machine-generated one of
 * a hundred thousand lines. The honest limit is stated rather than guarded:
 * this is a word processor, and the failure mode is a slow keystroke, not a
 * wrong document.
 */
const paginator = ViewPlugin.fromClass(class {
  constructor(view) { this.measure(view); }

  update(update) {
    if (update.docChanged || update.geometryChanged || update.viewportChanged) {
      this.measure(update.view);
    }
  }

  measure(view) {
    view.requestMeasure({
      key: this,
      read: (v) => {
        /*
         * Keyed by the START OF THE LINE the break belongs to, not by the
         * break's own position, because that is how `computeBreaks` looks it
         * up -- and the two are not always the same position.
         *
         * The trailing pad is the case that proves it. It sits at
         * `doc.length`, which is inside the LAST line, so CodeMirror hands it
         * back as part of that line's block. Keyed by its own position it was
         * never found, the last line measured as its own height plus the
         * whole pad -- 663px for a one-line paragraph -- which is taller than
         * a page, so the walk took the over-tall branch and recomputed a
         * different pad every pass. The document grew by a few pixels every
         * time it was measured.
         */
        const spacers = new Map();
        const { doc } = v.state;
        for (const b of v.state.field(pageBreakField).list) {
          const key = doc.lineAt(Math.min(b.at, doc.length)).from;
          spacers.set(key, (spacers.get(key) ?? 0) + b.height);
        }
        return computeBreaks(v, spacers);
      },
      write: (list, v) => {
        // The fixed point. Once the measured breaks agree with the ones
        // already on screen nothing is dispatched, and the loop -- measure,
        // insert blocks, geometry changes, measure again -- stops here.
        if (sameBreaks(v.state.field(pageBreakField).list, list)) return;
        /*
         * Deferred by a microtask, because the measure cycle still counts as
         * "during an update" and CodeMirror refuses a dispatch from inside
         * one ("Calls to EditorView.update are not allowed while an update is
         * in progress"). The check is repeated inside, since another
         * measurement can settle the same question first.
         */
        queueMicrotask(() => {
          if (!v.dom.isConnected) return;      // the view was torn down
          if (sameBreaks(v.state.field(pageBreakField).list, list)) return;
          v.dispatch({ effects: setPageBreaks.of(list) });
        });
      },
    });
  }
});

/**
 * Pagination, as one extension to drop into the editor.
 *
 * The field and the plugin are useless apart: the field renders breaks nobody
 * computes, the plugin computes breaks nobody renders. Exported as a pair so a
 * caller cannot mount half of it.
 */
export const pagination = [pageBreakField, paginator];
