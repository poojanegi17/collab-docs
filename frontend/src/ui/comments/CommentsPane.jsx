/**
 * The comments sidebar.
 *
 * Threads are listed in document order where they still have one, and orphans
 * fall to the bottom -- an orphaned thread has no position, so any ordering
 * that pretends otherwise is a lie about where its text used to be.
 */
import React, { useEffect, useRef, useState } from 'react';
import { avatarLabel, displayName } from '../identity.js';

const RELATIVE = [
  [60_000, 'just now', () => 'just now'],
  [3_600_000, null, (ms) => `${Math.floor(ms / 60_000)}m ago`],
  [86_400_000, null, (ms) => `${Math.floor(ms / 3_600_000)}h ago`],
  [Infinity, null, (ms) => `${Math.floor(ms / 86_400_000)}d ago`],
];

function ago(at) {
  const ms = Date.now() - at;
  for (const [limit, , fmt] of RELATIVE) if (ms < limit) return fmt(ms);
  return '';
}

/**
 * `avatarLabel`, not initials taken here.
 *
 * This computed its own and got "UN" for every unnamed participant -- which
 * looks like a person's initials, is the SAME two letters for all of them, and
 * says nothing. The shared rule gives a dash instead: there is somebody here
 * and we do not know who. It also means a comment avatar and the header avatar
 * for the same person cannot disagree, which is what happened while both
 * surfaces owned a copy of this.
 */
function Avatar({ author }) {
  return (
    <span className="comment-avatar" style={{ background: author?.color || 'var(--muted)' }}>
      {avatarLabel(author?.name)}
    </span>
  );
}

export function CommentsPane({
  threads, activeId, onSelect, onReply, onResolve, onDelete, onDeleteComment,
  canEdit, pending, onCancelPending, onSubmitPending, currentUserId, error,
  onClose,
}) {
  // Orphans last; everything else by where it sits in the document.
  const ordered = [...threads].sort((a, b) => {
    if (!a.range && !b.range) return a.created - b.created;
    if (!a.range) return 1;
    if (!b.range) return -1;
    return a.range.from - b.range.from;
  });

  const open = ordered.filter((t) => !t.resolved);
  const done = ordered.filter((t) => t.resolved);

  return (
    <aside className="comments-pane">
      <div className="comments-head">
        <span className="comments-title">Comments</span>
        <span className="comments-count">{open.length} open</span>
        {/* On a narrow screen this pane covers the document, so it needs a way
            out that is not the header button hidden behind it. */}
        {onClose && (
          <button type="button" className="pane-close" onClick={onClose} title="Close comments">
            &times;
          </button>
        )}
      </div>

      {error && <div className="comments-error">{error}</div>}

      {pending && (
        <NewThread
          quote={pending.quote}
          onCancel={onCancelPending}
          onSubmit={onSubmitPending}
        />
      )}

      {open.length === 0 && !pending && (
        <p className="comments-empty">
          Select some text and press <strong>Comment</strong> to start a thread.
        </p>
      )}

      {open.map((t) => (
        <Thread
          key={t.id} thread={t} active={t.id === activeId}
          onSelect={onSelect} onReply={onReply} onResolve={onResolve}
          onDelete={onDelete} onDeleteComment={onDeleteComment}
          canEdit={canEdit} currentUserId={currentUserId}
        />
      ))}

      {done.length > 0 && (
        <details className="comments-resolved">
          <summary>{done.length} resolved</summary>
          {done.map((t) => (
            <Thread
              key={t.id} thread={t} active={t.id === activeId}
              onSelect={onSelect} onReply={onReply} onResolve={onResolve}
              onDelete={onDelete} onDeleteComment={onDeleteComment}
              canEdit={canEdit} currentUserId={currentUserId}
            />
          ))}
        </details>
      )}
    </aside>
  );
}

function NewThread({ quote, onCancel, onSubmit }) {
  const [body, setBody] = useState('');
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const submit = (e) => {
    e?.preventDefault();
    const text = body.trim();
    if (text) onSubmit(text);
  };

  return (
    <form className="comment-thread comment-new" onSubmit={submit}>
      <blockquote className="comment-quote">{quote}</blockquote>
      <textarea
        ref={ref} value={body} rows={3}
        placeholder="Comment or add others with @"
        onChange={(e) => setBody(e.target.value)}
        // Enter submits, Shift+Enter breaks the line. A comment is one or two
        // sentences; making the common case need a mouse is the wrong default.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="comment-actions">
        <button type="submit" className="btn-primary" disabled={!body.trim()}>Comment</button>
        <button type="button" className="btn-quiet" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function Thread({
  thread, active, onSelect, onReply, onResolve, onDelete, onDeleteComment,
  canEdit, currentUserId,
}) {
  const [replying, setReplying] = useState(false);
  const [body, setBody] = useState('');

  const submit = (e) => {
    e?.preventDefault();
    const text = body.trim();
    if (!text) return;
    onReply(thread.id, text);
    setBody('');
    setReplying(false);
  };

  return (
    <article
      className={'comment-thread'
        + (active ? ' is-active' : '')
        + (thread.orphaned ? ' is-orphaned' : '')
        + (thread.resolved ? ' is-resolved' : '')}
      onClick={() => onSelect(thread.id)}
    >
      <blockquote className="comment-quote">{thread.quote}</blockquote>

      {thread.orphaned && (
        // Said plainly rather than hidden. The alternative -- quietly
        // re-anchoring -- would attach the note to text it was never about
        // (ADR-012 decision 3).
        <p className="comment-orphaned">
          The text this was about has been deleted.
        </p>
      )}

      {thread.comments.map((c) => (
        <div className="comment" key={c.id}>
          <div className="comment-meta">
            <Avatar author={c.author} />
            <span className="comment-author">{displayName(c.author?.name)}</span>
            <span className="comment-time">{ago(c.created)}</span>
            {canEdit && (c.author?.id == null || c.author.id === currentUserId) && (
              <button
                type="button" className="comment-x" title="Delete this comment"
                onClick={(e) => { e.stopPropagation(); onDeleteComment(thread.id, c.id); }}
              >×</button>
            )}
          </div>
          <p className="comment-body">{c.body}</p>
        </div>
      ))}

      {canEdit && (
        <div className="comment-actions" onClick={(e) => e.stopPropagation()}>
          {replying ? (
            <form onSubmit={submit} className="comment-reply">
              <textarea
                autoFocus value={body} rows={2} placeholder="Reply"
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) submit(e);
                  if (e.key === 'Escape') setReplying(false);
                }}
              />
              <button type="submit" className="btn-primary" disabled={!body.trim()}>Reply</button>
            </form>
          ) : (
            <>
              <button type="button" className="btn-quiet" onClick={() => setReplying(true)}>
                Reply
              </button>
              <button
                type="button" className="btn-quiet"
                onClick={() => onResolve(thread.id, !thread.resolved)}
              >
                {thread.resolved ? 'Re-open' : 'Resolve'}
              </button>
              <button type="button" className="btn-quiet" onClick={() => onDelete(thread.id)}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
