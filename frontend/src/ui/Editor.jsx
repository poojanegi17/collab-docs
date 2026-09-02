import React, { useEffect, useRef } from 'react';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { remoteCursors, setPeers } from '../presence/remote-cursors.js';
import { richTextExtensions, setRichDoc } from './marks.js';
import { authorshipField, setAuthorship } from './authorship.js';
import {
  commentHighlights, commentClickHandler, setCommentRanges, setActiveThread,
} from './comments/highlights.js';
import { formattingKeymap } from './format-commands.js';
import {
  pagination, PAGE_WIDTH, PAGE_HEIGHT, PAGE_MARGIN, PAGE_GAP,
} from './pagination.js';

/**
 * Thin CodeMirror host. It talks to the EditorSync interface only -- it does
 * not import Yjs, which is the point: `?engine=ot` will mount a different sync
 * implementation and this component will not notice.
 */
export function Editor({
  sync, peers, compact = false, viewRef: sharedViewRef, onStateChange, readOnly = false,
  linkRequestRef, commentRanges, activeThreadId, onSelectThread, authorship,
}) {
  const hostRef = useRef(null);
  const localViewRef = useRef(null);
  /**
   * The latest comment ranges, readable synchronously at view-construction
   * time.
   *
   * Same race as the document seed below, and it bites harder: the thread list
   * arrives over HTTP shortly after mount, while the view is built inside an
   * async effect. Opening a document that ALREADY has comments resolves them
   * before there is a view to dispatch to, the effect below fires against a
   * null ref, and -- because `commentRanges` never changes again -- no
   * highlight is ever drawn. Only a comment made in this session arrives late
   * enough for the prop alone to be enough.
   */
  const commentRangesRef = useRef(commentRanges);
  commentRangesRef.current = commentRanges;
  // The toolbar needs the live view to read the caret's formatting, so a
  // parent may hand one in. Falling back to a local ref keeps the lab's
  // several editors working without one.
  const viewRef = sharedViewRef ?? localViewRef;

  useEffect(() => {
    let view;
    let cancelled = false;

    (async () => {
      const syncExtensions = await sync.editorExtensions();
      if (cancelled) return;

      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          // Seed from whatever the sync layer already holds.
          //
          // Both engine bindings apply *changes* only, so a document that
          // finished syncing before this component mounted would render blank
          // forever. Opening an existing document does exactly that -- the
          // socket wins the race against React and the dynamic import. Two
          // tabs typing at each other never hit it, because there the content
          // always arrives after mount.
          //
          // Read synchronously here: there is no await between this and the
          // view construction, so no frame can land in between.
          doc: sync.getText(),
          extensions: [
            // No line numbers, no active-line highlight: this is a document,
            // not code. The instrument framing lives in the chrome around it.
            //
            // CodeMirror's history is mounted ONLY when the sync layer has no
            // undo of its own, which today means OT. Under the CRDT it is
            // actively wrong twice over: it would undo changes that arrived
            // from a peer, and -- since extensions earlier in this array take
            // precedence -- its Ctrl+Z would win over the Y.UndoManager
            // binding that yjs-sync.js adds below. The toolbar's Undo button
            // calls the sync layer, so both in place would leave the button
            // and the shortcut walking two different stacks.
            ...(sync.canUndo ? [] : [history(), keymap.of(historyKeymap)]),
            drawSelection(),
            // Find and replace. Replacements are dispatched as ordinary
            // document changes, so they travel through the sync layer exactly
            // like typing -- Replace All on a shared document is a normal edit
            // that collaborators watch happen, not a bulk rewrite that has to
            // be special-cased anywhere.
            //
            // `top: true` because the default panel is at the bottom, where it
            // covers the status bar.
            search({ top: true }),
            highlightSelectionMatches(),
            // Formatting shortcuts FIRST. Mod-b is bound in `defaultKeymap`
            // (cursorCharLeft, an emacs-ism), and CodeMirror runs bindings in
            // precedence order until one returns true -- put ours second and
            // Ctrl+B moves the caret instead of bolding, which is the kind of
            // wrong that reads as "the toolbar works but the keyboard does
            // not".
            keymap.of([
              // Ctrl+K has to reach the toolbar, which owns the URL field.
              // Read through the ref at press time: the keymap is built once
              // at mount and the handler is registered after it.
              ...formattingKeymap(sync, viewRef, {
                onLinkRequested: linkRequestRef ? () => linkRequestRef.current?.() : undefined,
              }),
              // Before `defaultKeymap`, which binds Ctrl+F to cursorCharRight.
              // Same trap as Ctrl+B, and the same fix.
              ...searchKeymap,
              ...defaultKeymap,
            ]),
            EditorView.lineWrapping,
            // A viewer's edits are rejected by the server anyway. Letting them
            // type first and discarding it afterwards is the worse failure:
            // under the CRDT the text stays on their replica, so they would
            // watch their own words survive locally and reach nobody.
            EditorView.editable.of(!readOnly),
            remoteCursors(),
            // Turns the sync layer's RichText into visible marks, and makes
            // Ctrl-click open a link. Engine agnostic by construction -- both
            // engines produce a RichText.
            ...richTextExtensions,
            // Comment highlights are their own layer, not part of `marks.js`:
            // formatting is a property OF the text, a comment is a property of
            // something attached to it, and they arrive from different places.
            ...commentHighlights,
            // Authorship, for the same reason again: not part of the document,
            // shown only on request, and refreshed on its own schedule.
            authorshipField,
            // Pages. Full-page editor only: the lab tiles several replicas in
            // one screen, and a US Letter sheet inside a 300px pane would put
            // one page break every two lines. There the document IS a text
            // box, which is the one place that framing is correct.
            ...(compact ? [] : pagination),
            ...(onSelectThread ? [commentClickHandler(onSelectThread)] : []),
            ...syncExtensions,
            // Publish our caret whenever it moves. Throttled inside the sync
            // layer -- the editor should not have to know about the network.
            EditorView.updateListener.of((u) => {
              if (!u.selectionSet && !u.docChanged) return;
              const r = u.state.selection.main;
              sync.setLocalCursor({ anchor: r.anchor, head: r.head });
              // The toolbar highlights whatever is under the caret, so it has
              // to re-read on every selection move, not only on edits.
              onStateChange?.();
            }),
            // Prose is sans; every number and machine state elsewhere is mono.
            // Colours come from the CSS custom properties so the editor tracks
            // the light/dark token set rather than defining its own palette.
            EditorView.theme({
              '&': { height: '100%', color: 'var(--fg)', backgroundColor: 'transparent' },
              '.cm-content': {
                fontFamily: 'var(--sans)',
                fontSize: compact ? '13px' : '15px',
                lineHeight: compact ? '1.55' : '1.7',
                caretColor: 'var(--accent)',
                // Only the compact editor's padding is set here. A paginated
                // document's padding IS its page margin, so it is written in
                // the stylesheet against the same custom properties that draw
                // the sheets -- two numbers that have to agree, kept in one
                // place. See `.editor-paged .cm-content`.
                ...(compact ? { padding: '10px 12px' } : null),
              },
              '.cm-scroller': { overflow: 'auto' },
              '.cm-line': { padding: '0' },
              '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
                backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
              },
              '.cm-selectionMatch': { backgroundColor: 'transparent' },
            }),
          ],
        }),
      });
      viewRef.current = view;
      /**
       * A handle on the view, for the harnesses -- the sibling of
       * `window.__sync` in App.jsx and there for the same reason: asserting on
       * where the CARET is after a keypress cannot be done from the DOM, and
       * caret behaviour inside a table is exactly the thing worth testing
       * (ADR-013). Grants nothing that is not already reachable from the
       * console of a page you are running.
       *
       * The full-page editor only. The lab mounts several of these and the
       * last one to render would win, which would make the handle a lie.
       */
      if (!compact) window.__view = view;
      // Seed the marks from whatever the replica already holds, for the same
      // reason the text is seeded above: the socket usually wins the race
      // against React, and decorations only arrive with the next change.
      view.dispatch({ effects: setRichDoc.of(sync.getRichText()) });
      // Seed the highlights for the same reason, from the ref rather than the
      // captured prop -- this closure was created before the fetch landed.
      if (commentRangesRef.current?.length) {
        view.dispatch({ effects: setCommentRanges.of(commentRangesRef.current) });
      }
      if (activeThreadId) {
        view.dispatch({ effects: setActiveThread.of(activeThreadId) });
      }
      onStateChange?.();
    })();

    return () => { cancelled = true; view?.destroy(); viewRef.current = null; };
  }, [sync, compact, readOnly]);

  // Formatting changes move no characters, so they arrive on their own event
  // rather than as a document change. Without this, bolding a word would only
  // become visible the next time somebody typed.
  useEffect(() => {
    const off = sync.on('rich', (rich) => {
      viewRef.current?.dispatch({ effects: setRichDoc.of(rich) });
      onStateChange?.();
    });
    return off;
  }, [sync, onStateChange, viewRef]);

  // Push authorship in, or null to clear the layer.
  //
  // A plain effect on the value rather than a subscription: authorship is
  // fetched by whoever owns the toggle and handed down, because a layer that
  // is off costs nothing and one that is on should not also be deciding when
  // to ask.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setAuthorship.of(authorship ?? null) });
  }, [authorship, viewRef]);

  // Push peer cursors into the editor as a state effect.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const list = [...peers.entries()].map(([id, state]) => ({ id, ...state }));
    view.dispatch({ effects: setPeers.of(list) });
  }, [peers]);

  // Comment ranges, resolved by the sync layer. The editor is handed positions
  // and never asks where they came from -- which is what lets one component
  // draw anchors that are relative positions under one engine and
  // server-transformed indices under the other.
  useEffect(() => {
    if (!commentRanges) return;
    viewRef.current?.dispatch({ effects: setCommentRanges.of(commentRanges) });
  }, [commentRanges, viewRef]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setActiveThread.of(activeThreadId ?? null) });
  }, [activeThreadId, viewRef]);

  // `compact` is the lab: several replicas tiled in one page. It gets a plain
  // box, not the paper treatment -- a drop shadow and rounded corners per pane
  // would make an instrument look like six documents.
  /*
   * The page geometry reaches CSS as custom properties rather than being
   * restated there.
   *
   * The stylesheet has to know the page height to draw the sheets, and
   * `pagination.js` has to know it to decide where the text breaks. Written
   * out twice they would eventually disagree, and the symptom -- every page
   * break landing slightly further from the sheet edge than the one above it
   * -- reads as a rendering bug rather than as two numbers that drifted.
   * Exported from the module that owns them, and handed to CSS here.
   */
  const pageVars = compact ? undefined : {
    '--page-w': `${PAGE_WIDTH}px`,
    '--page-h': `${PAGE_HEIGHT}px`,
    '--page-margin': `${PAGE_MARGIN}px`,
    '--page-gap': `${PAGE_GAP}px`,
  };

  return (
    <div
      className={`editor${compact ? ' editor-compact' : ' editor-paged'}`}
      style={pageVars}
      ref={hostRef}
    />
  );
}
