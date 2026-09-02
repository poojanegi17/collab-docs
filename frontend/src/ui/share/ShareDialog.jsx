import React, { useCallback, useEffect, useState } from 'react';
import { listCollaborators, share, unshare, claimDoc } from '../../api.js';
import { AccountBar } from '../account/Account.jsx';

/**
 * Sharing, by email.
 *
 * Two roles, not four. "Editor" and "viewer" are the distinction the server
 * actually enforces -- commenter would need comments to exist, and offering a
 * role the backend treats as something else is worse than not offering it.
 *
 * Note the owner row has no remove button. Revoking the owner would leave a
 * document nobody can share or delete, and the server refuses it anyway; a
 * control that always fails is not a control.
 *
 * ---------------------------------------------------------------------------
 * THIS DIALOG IS ALSO THE PRODUCT'S ONE SIGN-IN WALL.
 *
 * Creating and editing a document needs no account. Sharing does, and not as a
 * policy bolted on to collect emails -- it is forced by what sharing *is*.
 * Granting access writes a row naming a person, so there has to be a person to
 * name on both ends: an owner to grant it, an account to grant it to. An
 * unowned document has neither.
 *
 * So the wall stands exactly here, and it is a ramp rather than a door: sign
 * in, claim what you already wrote, then share it. Each step is offered in
 * place, in the document, with the work still on screen -- nobody is bounced to
 * a login page and back.
 */
export function ShareDialog({
  engine, docId, isOwner, unowned = false, user = null, onUser, onClaimed, onClose,
}) {
  const [people, setPeople] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    // An unowned document has an empty access list by definition. Asking is a
    // round trip whose answer is already known, and signed out on an OWNED
    // document it is a 403 -- which would paint an error into a dialog whose
    // actual message is "sign in".
    if (unowned) { setPeople([]); return; }
    try { setPeople((await listCollaborators(engine, docId)).collaborators); }
    catch (err) { setError(err.message); }
  }, [engine, docId, unowned]);

  useEffect(() => { load(); }, [load]);

  /**
   * Escape closes it.
   *
   * The backdrop click and the X were already here, so this was the one modal
   * on the site you could not dismiss from the keyboard -- and it is the one
   * with a password field in it, where reaching for the mouse is exactly what
   * you do not want to have to do. Everything else already agreed: the
   * confirm-delete dialog on the documents page binds Escape, and so does
   * every toolbar popover. Same idiom as ConfirmDelete, deliberately.
   */
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await share(engine, docId, email, role);
      setEmail('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId) => {
    setBusy(true);
    try { await unshare(engine, docId, userId); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const { doc } = await claimDoc(engine, docId);
      await onClaimed?.(doc);
      await load();
    } catch (err) {
      // 409 is somebody else claiming it first, which is a real outcome in a
      // document two guests are sharing a link to. Say what happened rather
      // than "request failed".
      setError(err.status === 409
        ? 'Someone else claimed this document first. Reload to see who owns it.'
        : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Share document" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span>Share</span>
          <button className="icon-btn" onClick={onClose} title="Close">x</button>
        </header>

        {/* ---- the ramp: sign in, then claim, then share ---- */}
        {unowned && !user && (
          <div className="share-gate">
            <p className="history-note">
              This document has no owner, so anyone with the link can edit it.
              Sharing it with a particular person means naming that person --
              which needs an account on both ends. Sign in and the document
              becomes yours; nothing you have written is lost.
            </p>
            <AccountBar engine={engine} user={null} onUser={onUser} startOpen />
          </div>
        )}

        {unowned && user && (
          <div className="share-gate">
            <p className="history-note">
              Signed in as <strong>{user.name}</strong>. Claim this document to
              become its owner -- then you can decide who else gets in. Anyone
              currently editing it anonymously will be asked to sign in.
            </p>
            <button className="primary-btn" onClick={claim} disabled={busy}>
              {busy ? 'Claiming...' : 'Claim this document'}
            </button>
          </div>
        )}

        {!unowned && isOwner && (
          <form className="share-add" onSubmit={add}>
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="editor">can edit</option>
              <option value="viewer">can view</option>
            </select>
            <button type="submit" className="primary-btn" disabled={busy}>Share</button>
          </form>
        )}

        {error && <p className="account-error" role="alert">{error}</p>}

        <ul className="share-list">
          {people.map((c) => (
            <li key={c.userId}>
              <span className="account-swatch" style={{ background: c.user.color }} />
              <span className="share-name">{c.user.name}</span>
              <span className="share-email">{c.user.email}</span>
              <span className="share-role">{c.role}</span>
              {isOwner && c.role !== 'owner' && (
                <button className="link-btn" onClick={() => remove(c.userId)} disabled={busy}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        {!unowned && !isOwner && (
          <p className="history-note">Only the owner can change who has access.</p>
        )}
      </div>
    </div>
  );
}
