/**
 * The shared checklist (ADR-015).
 *
 * A side pane like comments, and for the same reason: it is about the document
 * without being in it. The one thing it says that a personal to-do list cannot
 * is WHO ticked each item -- that is the whole difference between a checklist
 * in a shared document and a checklist that happens to be visible to other
 * people, so it is on the row rather than in a tooltip.
 */
import React, { useEffect, useRef, useState } from 'react';
import { displayName } from '../identity.js';

function ago(at) {
  const ms = Date.now() - at;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function TasksPane({
  open, done, error, canEdit, onAdd, onToggle, onEdit, onDelete, onClose,
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  const submit = (e) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    onAdd(text);
    // Keep the caret where it was: adding tasks is something people do several
    // at a time, and a form that loses focus after each one turns a list into
    // a sequence of clicks.
    inputRef.current?.focus();
  };

  return (
    <aside className="tasks-pane">
      <div className="tasks-head">
        <span className="tasks-title">Tasks</span>
        <span className="tasks-count">{open.length} to do</span>
        {onClose && (
          <button type="button" className="pane-close" onClick={onClose} title="Close tasks">
            &times;
          </button>
        )}
      </div>

      {error && <div className="tasks-error" role="alert">{error}</div>}

      {canEdit && (
        <form className="task-new" onSubmit={submit}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a task"
            aria-label="Add a task"
          />
          <button type="submit" className="btn-primary" disabled={!draft.trim()}>Add</button>
        </form>
      )}

      {open.length === 0 && done.length === 0 && (
        <p className="tasks-empty">
          Nothing on the list. Anything you add here is shared with everyone who
          can edit the document, from any tab &mdash; and any of them can tick
          it off.
        </p>
      )}

      <ul className="task-list">
        {open.map((task) => (
          <Task
            key={task.id} task={task} canEdit={canEdit}
            onToggle={onToggle} onEdit={onEdit} onDelete={onDelete}
          />
        ))}
      </ul>

      {done.length > 0 && (
        <details className="tasks-done" open>
          <summary>{done.length} done</summary>
          <ul className="task-list">
            {done.map((task) => (
              <Task
                key={task.id} task={task} canEdit={canEdit}
                onToggle={onToggle} onEdit={onEdit} onDelete={onDelete}
              />
            ))}
          </ul>
        </details>
      )}

      {!canEdit && (open.length > 0 || done.length > 0) && (
        <p className="tasks-note">
          You have view-only access, so the boxes are disabled. The server would
          refuse the change anyway; this says so before you click.
        </p>
      )}
    </aside>
  );
}

function Task({ task, canEdit, onToggle, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.body);
  const ref = useRef(null);

  useEffect(() => { setDraft(task.body); }, [task.body]);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const text = draft.trim();
    if (!text || text === task.body) { setDraft(task.body); return; }
    onEdit(task.id, text);
  };

  return (
    <li className={`task${task.done ? ' is-done' : ''}`}>
      <label className="task-check">
        <input
          type="checkbox"
          checked={task.done}
          disabled={!canEdit}
          onChange={(e) => onToggle(task.id, e.target.checked)}
        />
        <span className="task-box" aria-hidden="true" />
      </label>

      <div className="task-body">
        {editing ? (
          <input
            ref={ref}
            className="task-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') { setDraft(task.body); setEditing(false); }
            }}
          />
        ) : (
          <span
            className="task-text"
            onDoubleClick={() => canEdit && setEditing(true)}
          >
            {task.body}
          </span>
        )}

        <span className="task-meta">
          {task.done && task.doneBy
            // Named, because "who did this" is the question a shared checklist
            // exists to answer and the ACL cannot answer it after the fact.
            ? `done by ${displayName(task.doneBy.name)} ${ago(task.doneAt)}`
            : `added by ${displayName(task.author?.name)} ${ago(task.createdAt)}`}
        </span>
      </div>

      {canEdit && (
        <button
          type="button"
          className="task-x"
          aria-label={`Delete task: ${task.body}`}
          title="Delete"
          onClick={() => onDelete(task.id)}
        >
          &times;
        </button>
      )}
    </li>
  );
}
