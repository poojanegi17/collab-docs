/**
 * Comment ranges -> CodeMirror decorations.
 *
 * The sibling of `marks.js`, and deliberately separate from it. Formatting is
 * a property OF the text and arrives with the document; a comment highlight is
 * a property of something ATTACHED to the text and arrives from an entirely
 * different place (an HTTP list, plus anchors the sync layer resolves). Folding
 * them together would mean a comment could not be drawn until the document
 * changed.
 *
 * Engine-agnostic, like everything above the seam: it is handed resolved
 * `{from, to}` pairs and never learns whether they came from a relative
 * position or from a server-transformed index (ADR-012).
 */
import { EditorView, Decoration } from '@codemirror/view';
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';

/** Resolved anchors, newest wins. `[{id, from, to, resolved}]` */
export const setCommentRanges = StateEffect.define();

/** Which thread is selected in the sidebar, so its highlight can be stronger. */
export const setActiveThread = StateEffect.define();

const highlight = Decoration.mark({ class: 'cm-comment-range' });
const highlightResolved = Decoration.mark({ class: 'cm-comment-range cm-comment-resolved' });
const highlightActive = Decoration.mark({ class: 'cm-comment-range cm-comment-active' });

/**
 * Ranges and the active id in ONE field rather than two.
 *
 * Two fields would each need to read the other to build decorations, and a
 * StateField cannot see a sibling's value in the same transaction it is being
 * updated in -- so clicking a thread would highlight it one keystroke late.
 */
const commentState = StateField.define({
  create() {
    return { ranges: [], activeId: null, decorations: Decoration.none };
  },

  update(value, tr) {
    let { ranges, activeId } = value;
    let touched = false;

    for (const effect of tr.effects) {
      if (effect.is(setCommentRanges)) { ranges = effect.value; touched = true; }
      if (effect.is(setActiveThread)) { activeId = effect.value; touched = true; }
    }

    // A document change moves every range, and the authoritative new positions
    // arrive moments later from the sync layer. Mapping through the change in
    // the meantime keeps highlights attached to the words while you type,
    // instead of letting them lag a frame behind the text.
    if (!touched && tr.docChanged) {
      ranges = ranges
        .map((r) => ({
          ...r,
          from: tr.changes.mapPos(r.from, 1),
          to: tr.changes.mapPos(r.to, -1),
        }))
        .filter((r) => r.to > r.from);
      touched = true;
    }

    if (!touched) return value;
    return { ranges, activeId, decorations: build(ranges, activeId, tr.state.doc.length) };
  },

  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

function build(ranges, activeId, docLength) {
  const builder = new RangeSetBuilder();
  // RangeSetBuilder requires ascending order and rejects anything else at
  // runtime; the sidebar sorts by creation time, not by position.
  const sorted = [...ranges]
    .filter((r) => r && r.from < r.to && r.to <= docLength)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  for (const r of sorted) {
    const deco = r.id === activeId ? highlightActive
      : r.resolved ? highlightResolved
      : highlight;
    builder.add(r.from, r.to, deco);
  }
  return builder.finish();
}

/**
 * Click inside a highlight to select its thread.
 *
 * Innermost wins: comments nest, and the one you meant is the smallest one
 * under the caret. Without that rule a comment on a whole paragraph swallows
 * every click aimed at a comment on one word inside it.
 */
export function commentClickHandler(onSelect) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const { ranges } = view.state.field(commentState);
      const hits = ranges.filter((r) => pos >= r.from && pos <= r.to);
      if (hits.length === 0) return false;
      hits.sort((a, b) => (a.to - a.from) - (b.to - b.from));
      onSelect(hits[0].id);
      // Not handled: the caret should still move to where the user clicked.
      return false;
    },
  });
}

export const commentHighlights = [commentState];
