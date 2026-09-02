/**
 * Word and character count, under the page.
 *
 * Counted from the sync layer's text rather than from CodeMirror's, for the
 * same reason everything else reads from there: CodeMirror's document is a
 * projection, and during a remote update there is a window in which it has not
 * caught up. A count that flickers while somebody else types looks broken.
 *
 * Selection is the exception -- a selection is a property of THIS editor and
 * exists nowhere else, so it comes from the view.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { EMBED_CHAR, CELL_SEPARATOR } from '@collab/ot';

/**
 * Words, the way a word processor means it.
 *
 * Not `split(/\s+/).length`, which counts the empty string on either side of
 * leading or trailing whitespace and reports 1 for an empty document. Matching
 * runs of non-whitespace counts nothing when there is nothing.
 */
export function countWords(text) {
  // The two block characters have to be dealt with first (ADR-013). Neither is
  // whitespace as far as a regex is concerned, so left alone a cell separator
  // welds two cells into one word and an image counts as a word of its own.
  const prose = text
    .split(CELL_SEPARATOR).join(' ')
    .split(EMBED_CHAR).join('');
  const matches = prose.match(/\S+/g);
  return matches ? matches.length : 0;
}

export function StatusBar({ sync, viewRef, version }) {
  const [text, setText] = useState(() => sync.getText());

  useEffect(() => {
    const update = () => setText(sync.getText());
    update();
    const off = [sync.on('doc', update), sync.on('rich', update)];
    return () => off.forEach((fn) => fn());
  }, [sync]);

  // `version` is bumped by the editor on every selection change; it is what
  // makes this component re-read a selection React cannot observe.
  void version;
  const view = viewRef?.current;
  const selection = view?.state.selection.main;
  const selected = selection && !selection.empty
    ? view.state.doc.sliceString(selection.from, selection.to)
    : null;

  const stats = useMemo(() => ({
    words: countWords(text),
    characters: text.length,
  }), [text]);

  const selectedStats = useMemo(() => (selected
    ? { words: countWords(selected), characters: selected.length }
    : null), [selected]);

  return (
    <div className="statusbar">
      {selectedStats ? (
        <span className="statusbar-main">
          <strong>{fmt(selectedStats.words)}</strong> of {fmt(stats.words)} words selected
          <span className="statusbar-sep">·</span>
          {fmt(selectedStats.characters)} characters
        </span>
      ) : (
        <span className="statusbar-main">
          <strong>{fmt(stats.words)}</strong> {stats.words === 1 ? 'word' : 'words'}
          <span className="statusbar-sep">·</span>
          {fmt(stats.characters)} characters
        </span>
      )}
      <span className="statusbar-hint">
        Ctrl+F to find
      </span>
    </div>
  );
}

const fmt = (n) => n.toLocaleString();
