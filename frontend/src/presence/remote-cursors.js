/**
 * Renders other people's carets and selections.
 *
 * Engine-agnostic on purpose: it consumes a plain
 * `Map<clientId, {user, cursor:{anchor,head}}>` and knows nothing about Yjs.
 * When the OT engine arrives, this file does not change.
 *
 * Known limitation, and an instructive one: positions are plain integer
 * offsets. If a peer inserts text above your caret, the remote caret we draw
 * is stale until their next presence update (~60ms). The real fix is relative
 * positions (Y.RelativePosition under CRDT, offset transformation under OT) --
 * that is a good next exercise, and the fact that both engines need a
 * different fix is exactly why presence takes offsets rather than either.
 */
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { StateEffect, StateField, RangeSet } from '@codemirror/state';
import { displayName } from '../ui/identity.js';

export const setPeers = StateEffect.define();

class CaretWidget extends WidgetType {
  constructor(name, color) { super(); this.name = name; this.color = color; }
  eq(other) { return other.name === this.name && other.color === this.color; }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-peer-caret';
    wrap.style.borderColor = this.color;
    const label = document.createElement('span');
    label.className = 'cm-peer-label';
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    wrap.appendChild(label);
    return wrap;
  }
}

const peersField = StateField.define({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPeers)) return e.value;
    return value;
  },
});

function buildDecorations(view) {
  const peers = view.state.field(peersField, false) ?? [];
  const docLen = view.state.doc.length;
  const ranges = [];

  for (const { user, cursor } of peers) {
    if (!cursor) continue;
    // Clamp: a peer's offset can outrun our local document for a few ms.
    const anchor = Math.max(0, Math.min(cursor.anchor ?? 0, docLen));
    const head = Math.max(0, Math.min(cursor.head ?? anchor, docLen));
    const color = user?.color ?? '#888';
    // Never the client id. A peer whose identity has not arrived yet used to
    // get one printed on a caret label in the middle of the text -- six random
    // characters that read as a name and are not one.
    const name = displayName(user?.name);

    if (anchor !== head) {
      ranges.push(Decoration.mark({
        class: 'cm-peer-selection',
        attributes: { style: `background-color:${color}33` },
      }).range(Math.min(anchor, head), Math.max(anchor, head)));
    }
    ranges.push(Decoration.widget({ widget: new CaretWidget(name, color), side: 1 }).range(head));
  }

  ranges.sort((a, b) => a.from - b.from);
  return RangeSet.of(ranges, true);
}

const peerDecorations = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDecorations(view); }
  update(update) {
    if (update.docChanged || update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setPeers)))) {
      this.decorations = buildDecorations(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

// Caret and label styling lives in ui/styles.css alongside the rest of the
// design tokens, rather than in a CodeMirror baseTheme -- peer colours have to
// stay in step with the avatar stack and the inspector swatches, and splitting
// that across two styling systems is how they drift apart.

export const remoteCursors = () => [peersField, peerDecorations];
