/**
 * The document index: tabs down the left-hand side, each one opening into its
 * own headings.
 *
 * It is one control doing two jobs that are the same job. A tab is a document
 * (ADR-014), and the headings inside a tab are its sections, so "where in this
 * document am I" has two levels and the panel shows both: tabs at the top
 * level, that tab's outline underneath.
 *
 * Two things it deliberately does not do:
 *
 *   - It does not show the outline of a tab that is not open. Those headings
 *     are in a document this client has not loaded, and fetching four other
 *     tabs to fill in a sidebar is a lot of network for a list nobody asked
 *     to see. Clicking into a tab is what expands it.
 *   - It does not track scroll position to highlight "the section you are in".
 *     That needs a scroll listener per frame to answer a question the caret
 *     already answers, so the active heading is the one the CARET is inside.
 *
 * Collapsing it is remembered, because the people who want the width back want
 * it back on every document, not once.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { outlineOf } from './outline.js';

const COLLAPSE_KEY = 'collab.index.collapsed';

/**
 * Collapsed to start with on a narrow screen, expanded on a wide one.
 *
 * The stored preference still wins whenever there is one -- this only decides
 * what happens the FIRST time somebody opens a document, where there is
 * nothing to go on but the size of the screen. A 216px column out of 412px of
 * phone is half the window spent on a list of one tab, and it left the
 * document itself too narrow to read.
 *
 * The breakpoint is the one styles.css uses for the same decision about every
 * other panel; if the two drift, the index expands into a window the
 * stylesheet has already decided is too narrow for it.
 */
const NARROW = '(max-width: 900px)';

const readCollapsed = () => {
  try {
    const stored = localStorage.getItem(COLLAPSE_KEY);
    if (stored !== null) return stored === '1';
  } catch { /* private mode: fall through to the screen-size default */ }
  return window.matchMedia?.(NARROW).matches ?? false;
};
const writeCollapsed = (v) => {
  try { localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0'); } catch { /* private mode */ }
};

/** Chevron, inline so there is no icon dependency. Rotated by CSS when open. */
function Chevron({ className = '' }) {
  return (
    <svg className={className} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TabIndex({
  tabs, activeId, onSelect, canEdit, onAdd, onRename, onMove, onDelete, error,
  // The live document and where the caret is, for the outline. Both come from
  // the editor rather than from a fetch: this is the tab that is already open.
  rich, caret, onGoTo,
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [renaming, setRenaming] = useState(null);
  const [menuFor, setMenuFor] = useState(null);

  useEffect(() => { writeCollapsed(collapsed); }, [collapsed]);

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const outline = useMemo(() => outlineOf(rich), [rich]);

  /**
   * The heading the caret is inside: the last one at or before it.
   *
   * Cheaper than it looks and correct by construction — `outlineOf` returns
   * headings in document order, so this is a scan for the last one that starts
   * before the caret, not a search.
   */
  const activeHeading = useMemo(() => {
    if (caret == null) return -1;
    let found = -1;
    for (let i = 0; i < outline.length; i++) {
      if (outline[i].from <= caret) found = i;
      else break;
    }
    return found;
  }, [outline, caret]);

  if (!tabs.length) return null;

  if (collapsed) {
    return (
      <nav className="tab-index is-collapsed" aria-label="Document index">
        <button
          type="button"
          className="tab-index-toggle"
          title={`Show the index (${tabs.length} tab${tabs.length === 1 ? '' : 's'})`}
          aria-expanded={false}
          onClick={() => setCollapsed(false)}
        >
          <Chevron />
        </button>
        {/* The count is the only thing worth keeping visible when there is no
            room for names: it is what tells you there is more of this document
            than the part you are reading. */}
        {tabs.length > 1 && <span className="tab-index-count">{tabs.length}</span>}
      </nav>
    );
  }

  return (
    <nav className="tab-index" aria-label="Document index">
      <div className="tab-index-head">
        <span className="tab-index-title">Tabs</span>
        <button
          type="button"
          className="tab-index-toggle"
          title="Hide the index"
          aria-expanded
          onClick={() => setCollapsed(true)}
        >
          <Chevron className="is-open" />
        </button>
      </div>

      <ul className="tab-index-list">
        {tabs.map((tab, i) => {
          const active = tab.tabId === activeId;
          return (
            <li key={tab.tabId} className={`index-tab${active ? ' is-active' : ''}`}>
              <div className="index-tab-row">
                {/* Expanding an unopened tab means opening it -- its headings
                    live in a document this client has not loaded. Saying that
                    with the same control that opens it keeps the panel honest
                    about what it knows. */}
                <button
                  type="button"
                  className="index-tab-chevron"
                  aria-label={active ? `${tab.title} sections` : `Open ${tab.title}`}
                  onClick={() => onSelect(tab.tabId)}
                >
                  <Chevron className={active ? 'is-open' : ''} />
                </button>

                {renaming === tab.tabId ? (
                  <TabName
                    value={tab.title}
                    onCommit={(next) => {
                      setRenaming(null);
                      if (next !== tab.title) onRename(tab.tabId, next);
                    }}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <button
                    type="button"
                    className="doc-tab-btn"
                    aria-current={active ? 'true' : undefined}
                    title={tab.title}
                    onClick={() => onSelect(tab.tabId)}
                    onDoubleClick={() => canEdit && setRenaming(tab.tabId)}
                  >
                    {tab.title}
                  </button>
                )}

                {canEdit && (
                  <div className="doc-tab-menu-wrap">
                    <button
                      type="button"
                      className="doc-tab-more"
                      aria-label={`Actions for ${tab.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuFor((v) => (v === tab.tabId ? null : tab.tabId));
                      }}
                    >
                      &#8942;
                    </button>
                    {menuFor === tab.tabId && (
                      <div className="doc-tab-menu" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setMenuFor(null); setRenaming(tab.tabId); }}>
                          Rename
                        </button>
                        <button
                          disabled={i === 0}
                          onClick={() => { setMenuFor(null); onMove(tab.tabId, i - 1); }}
                        >
                          Move up
                        </button>
                        <button
                          disabled={i === tabs.length - 1}
                          onClick={() => { setMenuFor(null); onMove(tab.tabId, i + 1); }}
                        >
                          Move down
                        </button>
                        {/* Absent, not disabled, on the last remaining tab: the
                            server refuses it (a document needs somewhere to put
                            its text), and a permanently dead menu item is a
                            worse explanation than no item. */}
                        {tabs.length > 1 && (
                          <button
                            className="danger"
                            onClick={() => {
                              setMenuFor(null);
                              // The content survives -- the tab is soft-deleted
                              // and its update log untouched -- but nothing in
                              // the UI can bring it back, so this asks.
                              if (confirm(`Delete the tab "${tab.title}"? Everyone loses sight of what is in it.`)) {
                                onDelete(tab.tabId);
                              }
                            }}
                          >
                            Delete tab
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {active && (
                <Outline
                  headings={outline}
                  activeIndex={activeHeading}
                  onGoTo={onGoTo}
                />
              )}
            </li>
          );
        })}
      </ul>

      {canEdit && (
        <button
          type="button"
          className="tab-index-add"
          title="Add a tab. It is a document of its own -- own history, own comments, same sharing."
          onClick={() => onAdd('Untitled tab')}
        >
          + Add tab
        </button>
      )}

      {error && <p className="tab-index-error" role="alert">{error}</p>}
    </nav>
  );
}

/**
 * One tab's headings.
 *
 * Indented by level rather than nested in a tree, because the document is not
 * a tree (ADR-013) and building one here would mean inventing structure the
 * text does not have — an H3 following an H1 is not inside anything, and a
 * renderer that pretends otherwise has to decide what to do with an H4 that
 * comes first.
 */
function Outline({ headings, activeIndex, onGoTo }) {
  if (!headings.length) {
    return (
      <p className="tab-index-empty">
        No headings yet. Style a line as a heading and it appears here.
      </p>
    );
  }

  return (
    <ul className="tab-outline">
      {headings.map((h, i) => (
        <li key={`${h.from}:${h.text}`}>
          <button
            type="button"
            className={`outline-item${i === activeIndex ? ' is-here' : ''}`}
            style={{ paddingLeft: `${10 + (h.level - 1) * 11}px` }}
            title={h.text}
            onClick={() => onGoTo(h.from)}
          >
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TabName({ value, onCommit, onCancel }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef(null);
  useEffect(() => { ref.current?.select(); }, []);
  return (
    <input
      ref={ref}
      className="doc-tab-rename"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft.trim() || value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') { setDraft(value); onCancel(); }
      }}
    />
  );
}
