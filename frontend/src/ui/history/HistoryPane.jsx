import React, { useCallback, useEffect, useState } from 'react';
import { getHistory, getVersion, createCheckpoint, restoreVersion } from '../../api.js';

const when = (ms) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
      + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/**
 * Version history: the list, a preview, and restore.
 *
 * The preview is the part that matters. Restore is destructive-feeling even
 * though it is not -- it is applied as an ordinary edit and the state it
 * replaced is checkpointed first -- and nobody believes that in the moment.
 * Being able to read a version before restoring it is what makes the feature
 * usable rather than frightening.
 *
 * Everything here is HTTP. None of it goes near the sync layer, because none
 * of it changes the document; restore is the exception and it changes the
 * document by asking the server to make an edit, which then arrives through
 * the normal sync path like anyone else's typing.
 */
export function HistoryPane({ engine, docId, canEdit, onClose }) {
  const [state, setState] = useState({ loading: true, checkpoints: [], currentSeq: 0 });
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getHistory(engine, docId);
      setState({ loading: false, ...data });
    } catch (err) {
      setError(err.message);
      setState((s) => ({ ...s, loading: false }));
    }
  }, [engine, docId]);

  useEffect(() => { load(); }, [load]);

  const select = async (cp) => {
    setSelected(cp);
    setPreview(null);
    try {
      setPreview(await getVersion(engine, docId, cp.seq));
    } catch (err) {
      setError(err.message);
    }
  };

  const name = async () => {
    const label = prompt('Name this version');
    if (!label) return;
    setBusy(true);
    try { await createCheckpoint(engine, docId, label); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const restore = async (cp) => {
    setBusy(true);
    setError(null);
    try {
      await restoreVersion(engine, docId, cp.seq);
      // No local document update here on purpose: the server turns the restore
      // into an edit, and it arrives over the socket like any other. Applying
      // it locally too would mean the change lands twice.
      await load();
      setSelected(null);
      setPreview(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="history-pane" aria-label="Version history">
      <header className="history-head">
        <span className="history-title">Version history</span>
        <div className="history-head-actions">
          {canEdit && (
            <button className="link-btn" onClick={name} disabled={busy}>Name this version</button>
          )}
          <button className="icon-btn" onClick={onClose} title="Close history">x</button>
        </div>
      </header>

      {error && <p className="history-error" role="alert">{error}</p>}
      {state.loading && <p className="history-empty">Loading...</p>}

      {!state.loading && state.checkpoints.length === 0 && (
        <p className="history-empty">
          No versions yet. One is taken automatically whenever the update log is
          compacted, or you can name the current state.
        </p>
      )}

      <ul className="history-list">
        {state.checkpoints.map((cp) => (
          <li
            key={cp.id}
            className={`history-item${selected?.id === cp.id ? ' on' : ''}`}
          >
            <button className="history-item-main" onClick={() => select(cp)}>
              <span className="history-label">
                {cp.label ?? 'Autosave'}
                {cp.automatic && <span className="history-auto">auto</span>}
              </span>
              <span className="history-meta">
                {when(cp.createdAt)}
                {cp.author ? ` - ${cp.author.name}` : ''}
                {` - #${cp.seq}`}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selected && (
        <div className="history-preview">
          <div className="history-preview-head">
            <span>Preview of #{selected.seq}</span>
            {canEdit && (
              <button className="primary-btn small" disabled={busy} onClick={() => restore(selected)}>
                Restore this version
              </button>
            )}
          </div>
          <pre className="history-preview-body">
            {preview ? (preview.text || '(empty)') : 'Loading...'}
          </pre>
          <p className="history-note">
            Restoring applies this text as a new edit. The current version is
            checkpointed first, so it can be brought back the same way.
          </p>
        </div>
      )}
    </aside>
  );
}
