/**
 * Renders "who wrote this" as CodeMirror decorations (ADR-018).
 *
 * Its own layer rather than part of `marks.js`, for the same reason comment
 * highlights are: this is not part of the document. Formatting is content and
 * belongs in the RichText; authorship is a fact *about* the content, it is
 * shown only when somebody asks for it, and folding it into the formatting
 * field would mean every authorship refresh rebuilt every bold range too.
 *
 * Engine-agnostic in the same way `marks.js` is. What arrives here is runs and
 * an identity map, and nothing in this file can tell whether the server got
 * them free from a CRDT's item ids or from the parallel array the OT engine
 * had to be taught to keep. That is the seam doing its job -- the difference
 * ADR-018 is about is entirely on the other side of it.
 */
import { Decoration, EditorView } from '@codemirror/view';
import { StateField, StateEffect } from '@codemirror/state';
import { safeColor } from './attribute-values.js';

/** Push a new authorship payload in, or `null` to turn the layer off. */
export const setAuthorship = StateEffect.define();

/**
 * A fallback palette for authors whose colour we do not have.
 *
 * Under OT an identity is repopulated from presence, so text written by
 * somebody who has since disconnected has a real author id and no colour at
 * all. Hashing the id keeps that text distinguishable from its neighbours --
 * which is the actual question being asked, "did the same person write both of
 * these" -- instead of collapsing every unresolved author into one grey.
 */
const FALLBACK = ['#f87171', '#34d399', '#60a5fa', '#fbbf24', '#c084fc', '#2dd4bf', '#f472b6'];

function colorFor(author, identities) {
  const known = identities?.[author]?.color;
  // Through the same sanitiser every other network-supplied colour goes
  // through. An identity map is written by peers, so a value in it is no more
  // trustworthy than an attribute on a character.
  if (known) {
    const safe = safeColor(known);
    if (safe) return safe;
  }
  let h = 0;
  for (let i = 0; i < String(author).length; i++) {
    h = (h * 31 + String(author).charCodeAt(i)) >>> 0;
  }
  return FALLBACK[h % FALLBACK.length];
}

function nameFor(author, identities) {
  return identities?.[author]?.name || 'Unknown author';
}

/**
 * Build one decoration per run.
 *
 * Runs arrive aligned to the document the SERVER last saw, which is not
 * necessarily the one on screen: the reader may have typed since. So every
 * range is clamped to the current document length and zero-length ranges are
 * dropped. Without the clamp, a run that runs past the end throws inside
 * CodeMirror and takes the editor's whole render with it -- a stale overlay
 * should degrade to a slightly wrong tint, never to a blank page.
 */
function build(doc, payload) {
  if (!payload?.runs?.length) return Decoration.none;
  const { runs, identities } = payload;
  const marks = [];
  let at = 0;
  for (const run of runs) {
    const from = Math.min(at, doc.length);
    const to = Math.min(at + run.length, doc.length);
    at += run.length;
    if (to <= from) continue;
    if (run.author == null) continue; // genuinely unattributed: left untinted
    const color = colorFor(run.author, identities);
    marks.push(Decoration.mark({
      class: 'cm-authorship',
      attributes: {
        // A tooltip rather than a label in the margin: authorship is a
        // question asked about a specific sentence, and a gutter cannot say
        // anything about a range that starts mid-line.
        title: nameFor(run.author, identities),
        style: `--author-color: ${color}`,
      },
    }).range(from, to));
    if (at >= doc.length) break;
  }
  return Decoration.set(marks, true);
}

export const authorshipField = StateField.define({
  create() {
    return { payload: null, decorations: Decoration.none };
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAuthorship)) {
        return effect.value
          ? { payload: effect.value, decorations: build(tr.state.doc, effect.value) }
          : { payload: null, decorations: Decoration.none };
      }
    }
    if (tr.docChanged && value.payload) {
      // Typing moved the text and no fresh authorship has arrived yet. Map the
      // existing set forward rather than rebuilding against stale runs, which
      // is the same trade `marks.js` makes and for the same reason.
      //
      // Note what this deliberately does NOT do: attribute the newly typed
      // characters to the person typing. It looks like an easy win and it is a
      // lie -- the server decides authorship, the client has not been told
      // yet, and under OT the op has not even been transformed. The new text
      // stays untinted until the next refresh says whose it is.
      return { payload: value.payload, decorations: value.decorations.map(tr.changes) };
    }
    return value;
  },

  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Everyone who has written any of the text currently on screen. */
export function authorLegend(payload) {
  if (!payload?.runs?.length) return [];
  const seen = new Map();
  for (const run of payload.runs) {
    if (run.author == null) continue;
    const existing = seen.get(run.author);
    if (existing) existing.chars += run.length;
    else {
      seen.set(run.author, {
        author: run.author,
        name: nameFor(run.author, payload.identities),
        color: colorFor(run.author, payload.identities),
        chars: run.length,
      });
    }
  }
  // Most-written first: a legend is read to find out who did most of this.
  return [...seen.values()].sort((a, b) => b.chars - a.chars);
}
