import React, { useEffect, useState } from 'react';
import { engineLabel, isGuest, avatarLabel } from './identity.js';



/**
 * Document chrome: identity on the left, people and connection on the right.
 *
 * The status pill deliberately shows two different things at once -- the dot is
 * the socket's actual state, the label is what the user asked for. Those differ
 * while reconnecting, and one indicator standing for both would make a click
 * that landed there read as "go offline".
 */
export function Header({
  docId, title, role, engine, user, peers, status, wantOnline,
  onToggleConnection, inspectorOpen, onToggleInspector,
  onRename, onShare, unowned, account, historyOpen, onToggleHistory,
  commentsOpen, commentCount, onToggleComments, onExport,
  tasksOpen, taskCount, onToggleTasks,
  authorshipOn, onToggleAuthorship,
}) {
  // Local copy so typing in the title is not a round trip per keystroke. It
  // is committed on blur or Enter, and re-synced whenever the server sends a
  // different one -- otherwise a rename by a collaborator would be overwritten
  // by whatever this tab happened to have in the field.
  const [draft, setDraft] = useState(title ?? docId);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(title ?? docId); }, [title, docId]);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === title) { setDraft(title ?? docId); return; }
    setSaving(true);
    try { await onRename?.(next); }
    catch { setDraft(title ?? docId); }
    finally { setSaving(false); }
  };

  const people = [
    ...[...peers.entries()].map(([id, p]) => ({
      id,
      name: p.user?.name ?? id,
      color: p.user?.color ?? '#8a8a8e',
      self: false,
    })),
    { id: 'self', name: user.name, color: user.color, self: true },
  ];

  return (
    <header className="header">
      {role === 'viewer' || !onRename ? (
        <span className="doc-title" title={docId}>{title ?? docId}</span>
      ) : (
        <input
          className="doc-title doc-title-input"
          value={draft}
          disabled={saving}
          title={docId}
          aria-label="Document title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setDraft(title ?? docId); e.currentTarget.blur(); }
          }}
        />
      )}
      <span className="badge badge-engine" title={`Concurrency engine: ${engine}`}>
        {engineLabel(engine)}
      </span>
      {role && role !== 'editor' && <span className="badge badge-role">{role}</span>}

      <div className="header-spacer" />

      {/* Name the current tab explicitly. An avatar alone is not enough: with
          several tabs open you cannot tell which one you are typing into, and
          that ambiguity reads as a sync bug when cursors show up. */}
      <span
        className={`whoami${isGuest(user.name) ? ' whoami-guest' : ''}`}
        title={isGuest(user.name)
          ? `This tab is ${user.name} (${user.clientId}) — not signed in, so the document cannot name you`
          : `This tab is ${user.name} (${user.clientId})`}
      >
        <span className="whoami-swatch" style={{ background: user.color }} />
        {user.name}
      </span>

      <div className="avatars">
        {people.map((p) => (
          <span
            key={p.id}
            className={`avatar${p.self ? ' avatar-self' : ''}`}
            style={{ background: p.color }}
            title={p.self ? `${p.name} (you)` : p.name}
          >
            {avatarLabel(p.name)}
          </span>
        ))}
      </div>

      <button
        className={`status status-${status}`}
        onClick={onToggleConnection}
        title="Go offline to edit locally, then come back online and watch it converge"
      >
        <span className="dot" />
        {status}
      </button>

      {onShare && (
        <button
          className="header-btn"
          onClick={onShare}
          /* The button is always Share -- what it opens differs, and that
             difference is explained inside the dialog where there is room for
             it. Renaming it to "Sign in to share" would be a second, worse
             account control sitting next to the real one. */
          title={unowned
            ? 'Share this document. It has no owner yet, so this asks you to sign in and claim it first.'
            : 'Share this document'}
        >
          Share
        </button>
      )}

      {onExport && (
        <button className="header-btn" onClick={onExport} title="Download as Markdown">
          Export
        </button>
      )}

      <button
        className={`header-btn${commentsOpen ? ' on' : ''}`}
        onClick={onToggleComments}
        aria-pressed={!!commentsOpen}
        title="Comments"
      >
        Comments
        {/* Only when there are any. A permanent "0" is noise, and it makes an
            empty document look like it is withholding something. */}
        {commentCount > 0 && <span className="header-badge">{commentCount}</span>}
      </button>

      {onToggleTasks && (
        <button
          className={`header-btn${tasksOpen ? ' on' : ''}`}
          onClick={onToggleTasks}
          aria-pressed={!!tasksOpen}
          title="Shared task list. Anyone who can edit this document can tick anything on it."
        >
          Tasks
          {/* The count is what is LEFT to do, not how many tasks exist. A
              finished list showing "7" would read as seven things outstanding,
              which is the opposite of what it is telling you. */}
          {taskCount > 0 && <span className="header-badge">{taskCount}</span>}
        </button>
      )}

      {onToggleAuthorship && (
        <button
          className={`header-btn${authorshipOn ? ' on' : ''}`}
          onClick={onToggleAuthorship}
          aria-pressed={!!authorshipOn}
          title="Tint the text by who wrote it"
        >
          Authors
        </button>
      )}

      <button
        className={`header-btn${historyOpen ? ' on' : ''}`}
        onClick={onToggleHistory}
        aria-pressed={!!historyOpen}
        title="Version history"
      >
        History
      </button>

      <button
        className="icon-btn"
        onClick={onToggleInspector}
        aria-pressed={inspectorOpen}
        title={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
      >
        {/* Panel-right glyph. Inline so there is no icon dependency. */}
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
          <line x1="10" y1="2.5" x2="10" y2="13.5" stroke="currentColor" />
        </svg>
      </button>

      {/* Sign in without leaving the document, so "sign in to share" is an
          instruction with somewhere to carry it out. */}
      {account && <div className="header-account">{account}</div>}
    </header>
  );
}
