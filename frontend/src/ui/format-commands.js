/**
 * The formatting commands, lifted out of the toolbar.
 *
 * They started as two closures inside Toolbar.jsx, which was fine while the
 * only way to bold something was to click a button. Ctrl+B has to do exactly
 * the same thing -- including the line-attribute subtlety below, which is not
 * obvious and would be reimplemented slightly differently the second time --
 * so it lives in one place and both callers use it.
 *
 * Every command ends at `sync.format(from, to, attributes)`. Nothing here
 * knows which engine is mounted; that is the seam, and it is why the same
 * toolbar drives CRDT and OT.
 */
import { MAX_INDENT, EMBED_CHAR, CELL_SEPARATOR } from '@collab/ot';
import { activeAttributes, lineAttributes, INLINE_MARKS, LINE_MARKS } from './marks.js';
import {
  normaliseLinkInput, safeIndent, safeImageSrc, safeTableId,
} from './attribute-values.js';

/**
 * Read the formatting again at COMMAND time rather than trusting a value
 * captured during render.
 *
 * The caret can move between render and click -- arrow keys, a click in the
 * text, a peer's edit shifting things. Toggling against a stale reading
 * inverts the command: pressing Bullet on an unbulleted line would REMOVE a
 * bullet, because the line the reading came from had one. It goes wrong only
 * on fast input, which is the worst kind of bug to reproduce by hand.
 */
export const currentAttributes = (view) => (view ? activeAttributes(view.state) : {});

/**
 * Toggle an inline attribute over the selection.
 *
 * "Un-bold" is expressed as `{ bold: null }`; null means remove, and it is a
 * real value in the protocol rather than an absence, because "stop being bold"
 * and "do not care about boldness" are different instructions. See
 * shared/ot/src/attributes.js.
 *
 * @returns {boolean} whether anything was done -- the keymap needs this to
 *   decide if the key was handled or should fall through.
 */
export function toggleInline(sync, view, attr) {
  if (!view) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;      // nothing selected, nothing to format
  const now = currentAttributes(view);
  sync.format(sel.from, sel.to, { [attr]: now[attr] ? null : true });
  view.focus();
  return true;
}

/**
 * Apply a line attribute to every line the selection touches.
 *
 * Line attributes live on the newline that ENDS the line, so formatting a line
 * means formatting one character the user never selected.
 *
 * The last line of a document usually has no trailing newline, and therefore
 * nowhere to carry the attribute. Rather than making headings silently fail
 * there -- which looks exactly like a broken button -- we append one first and
 * format it on the next tick, once the insert has gone through the sync layer
 * and the positions are settled.
 *
 * @param {*} value the attribute's value, or null to clear it outright
 *   (the style dropdown's "Normal text" needs to clear rather than toggle:
 *   choosing it while on an H2 must not toggle H2 back on).
 */
export function applyLine(sync, view, attr, value, { toggle = true } = {}) {
  if (!view) return false;
  const sel = view.state.selection.main;
  const first = view.state.doc.lineAt(sel.from).number;
  const last = view.state.doc.lineAt(sel.to).number;
  const turningOff = toggle && currentAttributes(view)[attr] === value;

  const targets = [];
  let needsNewline = false;
  for (let n = first; n <= last; n++) {
    const line = view.state.doc.line(n);
    if (line.to < view.state.doc.length) targets.push(line.to);
    else needsNewline = true;
  }

  const attrs = { [attr]: turningOff || value === null ? null : value };
  for (const at of targets) sync.format(at, at + 1, attrs);

  if (needsNewline) {
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, to: end, insert: '\n' } });
    queueMicrotask(() => sync.format(end, end + 1, attrs));
  }
  view.focus();
  return true;
}

/**
 * Set an inline attribute to a VALUE over the selection, rather than toggling.
 *
 * Font, size, colour and highlight are chosen, not switched on: picking 14pt
 * while already at 14pt must leave you at 14pt, where a toggle would silently
 * take the size off. Pass `null` to remove.
 */
export function setInline(sync, view, attr, value) {
  if (!view) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  sync.format(sel.from, sel.to, { [attr]: value });
  view.focus();
  return true;
}

/**
 * Attach a link to the selection, or remove one.
 *
 * The URL is normalised here rather than in the dialog so that every route to
 * a link -- toolbar, paste, a future shortcut -- goes through one check. An
 * unusable URL removes the link instead of writing something the renderer will
 * refuse to display, which would leave text that claims to be a link and is
 * not.
 */
export function setLink(sync, view, raw) {
  const href = normaliseLinkInput(raw);
  return setInline(sync, view, 'link', href || null);
}

/**
 * Indent or outdent every line the selection touches, by one step.
 *
 * Read per line, not once for the selection: "indent further" is relative, and
 * applying a single computed value to all of them would flatten a nested list
 * the moment somebody selected across two levels.
 */
export function adjustIndent(sync, view, delta) {
  if (!view) return false;
  const sel = view.state.selection.main;
  const first = view.state.doc.lineAt(sel.from).number;
  const last = view.state.doc.lineAt(sel.to).number;

  for (let n = first; n <= last; n++) {
    const line = view.state.doc.line(n);
    // The last line of the document has no trailing newline to carry a line
    // attribute. `applyLine` handles that by appending one; here the simpler
    // answer is right -- an indent nobody can see on a line with no content
    // after it is not worth inserting a newline for.
    if (line.to >= view.state.doc.length) continue;
    const now = safeIndent(lineAttributes(view.state, n).indent, MAX_INDENT);
    const next = Math.max(0, Math.min(MAX_INDENT, now + delta));
    if (next === now) continue;
    sync.format(line.to, line.to + 1, { indent: next || null });
  }
  view.focus();
  return true;
}

/**
 * Copy the formatting under the caret, to be applied elsewhere -- the "paint
 * format" brush.
 *
 * Returns an ABSOLUTE attribute set including explicit nulls, so applying it
 * makes the target match the source rather than merely gaining its marks. Without
 * the nulls, painting plain text onto bold text would leave it bold, which is
 * the opposite of what copying formatting means.
 */
export function copyFormatting(view) {
  if (!view) return null;
  const now = activeAttributes(view.state);
  const out = {};
  for (const name of [...INLINE_MARKS, ...LINE_MARKS]) out[name] = now[name] ?? null;
  return out;
}

/** Apply a set captured by `copyFormatting`. */
export function pasteFormatting(sync, view, captured) {
  if (!view || !captured) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;

  // Inline marks go on the selected characters; line marks belong on each
  // line's trailing newline, and sending them over the selection instead would
  // write `header` onto ordinary characters -- where nothing renders it and
  // `inlineOnly` has to strip it back out on every subsequent keystroke.
  const inline = {};
  for (const name of INLINE_MARKS) inline[name] = captured[name] ?? null;
  sync.format(sel.from, sel.to, inline);

  const line = {};
  for (const name of LINE_MARKS) line[name] = captured[name] ?? null;
  const first = view.state.doc.lineAt(sel.from).number;
  const last = view.state.doc.lineAt(sel.to).number;
  for (let n = first; n <= last; n++) {
    const at = view.state.doc.line(n);
    if (at.to < view.state.doc.length) sync.format(at.to, at.to + 1, line);
  }

  view.focus();
  return true;
}

/** Strip every mark this editor knows how to apply, over the selection. */
export function clearFormatting(sync, view) {
  if (!view) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  // Every mark set to null: the operation says "remove", not "ignore".
  const cleared = {};
  for (const name of INLINE_MARKS) cleared[name] = null;
  for (const name of LINE_MARKS) cleared[name] = null;
  sync.format(sel.from, sel.to, cleared);
  view.focus();
  return true;
}

/**
 * The keyboard half of the toolbar.
 *
 * The bindings people try without being told, and nothing else. Mod-z is
 * deliberately absent: undo belongs to the sync layer (Y.UndoManager binds it
 * in yjs-sync.js), because undoing a peer's edit is not undo, it is vandalism.
 *
 * Returned as plain binding objects so Editor.jsx can put them in the ONE
 * keymap it already builds, ahead of `defaultKeymap` -- Mod-i and Mod-u are
 * unbound there, but Mod-b is not, and order decides.
 */
export function formattingKeymap(sync, viewRef, { onLinkRequested } = {}) {
  // `viewRef.current` rather than a captured view: the command must act on the
  // live one, and this keymap is built once at mount.
  const cmd = (key, run) => ({ key, preventDefault: true, run: () => { run(viewRef.current); return true; } });
  const flag = (key, attr) => cmd(key, (v) => toggleInline(sync, v, attr));
  const line = (key, attr, value) => cmd(key, (v) => applyLine(sync, v, attr, value));

  return [
    flag('Mod-b', 'bold'),
    flag('Mod-i', 'italic'),
    flag('Mod-u', 'underline'),
    flag('Mod-Shift-x', 'strike'),
    flag('Mod-e', 'code'),

    // The list and alignment bindings are the word processor ones,
    // deliberately -- these are muscle memory, and there is nothing to gain
    // from a better-reasoned set of keys that nobody's hands already know.
    line('Mod-Shift-7', 'list', 'number'),
    line('Mod-Shift-8', 'list', 'bullet'),
    line('Mod-Shift-9', 'quote', true),
    line('Mod-Shift-l', 'align', null),
    line('Mod-Shift-e', 'align', 'center'),
    line('Mod-Shift-r', 'align', 'right'),
    line('Mod-Shift-j', 'align', 'justify'),

    cmd('Mod-]', (v) => adjustIndent(sync, v, +1)),
    cmd('Mod-[', (v) => adjustIndent(sync, v, -1)),

    // Tab moves between cells, and does nothing outside a table -- returning
    // false there matters, because Tab in ordinary prose should stay whatever
    // CodeMirror makes of it rather than being swallowed by a table feature.
    {
      key: 'Tab',
      run: () => moveCell(sync, viewRef.current, +1),
    },
    {
      key: 'Shift-Tab',
      run: () => moveCell(sync, viewRef.current, -1),
    },

    // Ctrl+K needs somewhere to type a URL, which is the toolbar's business
    // and not this file's. The binding is only installed when a handler was
    // supplied, so the key falls through to CodeMirror in the lab's editors
    // rather than swallowing it and doing nothing.
    ...(onLinkRequested ? [cmd('Mod-k', () => onLinkRequested())] : []),

    cmd('Mod-\\', (v) => clearFormatting(sync, v)),
  ];
}

// ---- blocks (ADR-013) ------------------------------------------------------
//
// Both of these insert TEXT through CodeMirror and then format it through the
// seam. That is deliberate and not a shortcut: it means an image and a table
// travel to other clients as an ordinary insert plus an ordinary format, so
// they arrive, merge, undo and replay through code that was written before
// either existed.

/**
 * Insert an image at the caret.
 *
 * The image is one character (`EMBED_CHAR`) carrying the source as an
 * attribute. Formatting is applied in a microtask because `sync.format` takes
 * document positions, and the position of the character we just inserted is
 * only true once CodeMirror's change has reached the sync layer's binding.
 *
 * @param {string} src  already normalised; sanitised again at render time
 */
export function insertImage(sync, view, src, { alt = '' } = {}) {
  if (!view) return false;
  const url = normaliseLinkInput(src);
  if (!url || !safeImageSrc(url)) return false;

  const at = view.state.selection.main;
  view.dispatch({ changes: { from: at.from, to: at.to, insert: EMBED_CHAR } });
  queueMicrotask(() => {
    sync.format(at.from, at.from + 1, { image: url, alt: alt || null, width: 100 });
    view.focus();
  });
  return true;
}

/**
 * Insert a table of `rows` x `columns` empty cells at the caret.
 *
 * A table is a run of lines that agree on a `table` id, with cells separated
 * by `CELL_SEPARATOR`. Building it is therefore string construction, and the
 * only formatting call is the one that marks each row's newline.
 */
export function insertTable(sync, view, rows = 3, columns = 3) {
  if (!view) return false;
  const height = Math.min(20, Math.max(1, Math.round(rows)));
  const width = Math.min(10, Math.max(1, Math.round(columns)));
  const id = 't' + Math.random().toString(36).slice(2, 8);

  const at = view.state.selection.main;
  const line = view.state.doc.lineAt(at.from);

  // A table has to start its own line. Inserting mid-sentence would make the
  // rest of that sentence the first cell.
  const prefix = at.from === line.from ? '' : '\n';
  const row = Array(width).fill('').join(CELL_SEPARATOR);
  // A trailing newline so there is somewhere to type AFTER the table -- with
  // the last row ending the document there is no way to escape it.
  const body = prefix + Array(height).fill(row).join('\n') + '\n';

  view.dispatch({ changes: { from: at.from, to: at.to, insert: body } });

  queueMicrotask(() => {
    // Mark the newline ENDING each row, which is where line attributes live
    // (ADR-006). The final newline is the one after the last row, so it is
    // included: it terminates row `height`.
    let cursor = at.from + prefix.length;
    for (let r = 0; r < height; r++) {
      const end = cursor + row.length;
      sync.format(end, end + 1, { table: id });
      cursor = end + 1;
    }
    // Put the caret in the first cell.
    const firstCell = at.from + prefix.length;
    view.dispatch({ selection: { anchor: firstCell } });
    view.focus();
  });
  return true;
}

/**
 * Move the caret to the next or previous cell.
 *
 * Tab, because that is how everyone fills in a table and has been since word
 * processors had tables. It also sidesteps a real awkwardness: vertical caret
 * movement inside a flex-laid-out row is computed from geometry, and geometry
 * is exactly what a table changes.
 *
 * Tab out of the last cell of the last row ADDS a row, which is the behaviour
 * every word processor has and the only way to grow a table without reaching
 * for the toolbar. Tab outside a table returns false so the key falls through
 * to whatever CodeMirror would have done with it.
 *
 * @param {number} direction +1 for next, -1 for previous
 */
export function moveCell(sync, view, direction) {
  if (!view) return false;
  const attrs = currentAttributes(view);
  const id = safeTableId(attrs.table);
  if (!id) return false;

  const { doc } = view.state;
  const head = view.state.selection.main.head;
  const line = doc.lineAt(head);

  if (direction > 0) {
    // The next separator on this line, if there is one.
    const at = line.text.indexOf(CELL_SEPARATOR, head - line.from);
    if (at >= 0) {
      select(view, line.from + at + 1);
      return true;
    }
    // End of the row: go to the first cell of the next row, if it is ours.
    if (line.number < doc.lines && rowId(view, line.number + 1) === id) {
      select(view, doc.line(line.number + 1).from);
      return true;
    }
    // Last cell of the last row: grow the table.
    return addTableRow(sync, view);
  }

  // Backwards: the previous separator on this line.
  const before = line.text.slice(0, Math.max(0, head - line.from - 1));
  const at = before.lastIndexOf(CELL_SEPARATOR);
  if (head - line.from > 0) {
    select(view, line.from + (at >= 0 ? at + 1 : 0));
    return true;
  }
  // Start of the row: the END of the previous row, if it is ours.
  if (line.number > 1 && rowId(view, line.number - 1) === id) {
    select(view, doc.line(line.number - 1).to);
    return true;
  }
  return true;
}

const select = (view, anchor) => {
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
  view.focus();
};

/**
 * The table id of a line, or null.
 *
 * `lineAttributes` takes a line NUMBER, not a position -- passing it an offset
 * asks for a line that usually does not exist, and the RangeError comes out of
 * a key handler where it silently kills the binding.
 */
function rowId(view, lineNumber) {
  if (lineNumber < 1 || lineNumber > view.state.doc.lines) return null;
  return safeTableId(lineAttributes(view.state, lineNumber)?.table);
}

/**
 * Add a row below the one the caret is in, if it is in a table.
 *
 * A structural edit expressed as an insert, which is the entire claim of
 * ADR-013: "add a row" needs no transform case of its own because it is a
 * newline like any other.
 */
export function addTableRow(sync, view) {
  if (!view) return false;
  const attrs = currentAttributes(view);
  const id = safeTableId(attrs.table);
  if (!id) return false;

  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const columns = line.text.split(CELL_SEPARATOR).length;
  const row = Array(columns).fill('').join(CELL_SEPARATOR);

  view.dispatch({ changes: { from: line.to, to: line.to, insert: '\n' + row } });
  queueMicrotask(() => {
    // Which newline needs the attribute is worth being careful about. The
    // insert goes in BEFORE the newline that ended the current row, so that
    // original newline -- which already carries the table id -- now
    // terminates the NEW row. The freshly inserted newline at `line.to` is
    // the one terminating the current row, and it is the one with no
    // attributes yet.
    sync.format(line.to, line.to + 1, { table: id });
    view.dispatch({ selection: { anchor: line.to + 1 } });
    view.focus();
  });
  return true;
}
