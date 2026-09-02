import React, { useEffect, useRef, useState } from 'react';
import { signIn, signUp, signOut, signInWithGoogle, whoami } from '../../api.js';
import { googleEnabled, renderGoogleButton, releaseGoogleButton } from '../../google/gis.js';

/**
 * Session state, shared by every surface that needs to know who you are.
 *
 * Identity is checked against ONE engine's server (the CRDT one by default)
 * even though both are running, because accounts are shared between them --
 * see backend/src/storage/accounts.js. Asking both would be two round trips to
 * learn the same fact.
 */
export function useSession(engine = 'yjs') {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    whoami(engine).then((u) => {
      if (cancelled) return;
      setUser(u);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [engine]);

  return { user, setUser, ready };
}

/**
 * Sign in, sign up, and the signed-in chip -- one component because they are
 * one control in three states, and splitting them would mean the caller has to
 * know which state it is in before it can render anything.
 */
export function AccountBar({ engine = 'yjs', user, onUser, startOpen = false }) {
  // `startOpen` is for the share dialog, where the form IS the content of the
  // panel. Collapsing it to a "Sign in" button there would mean asking someone
  // who just clicked Share to click twice more before they can type anything.
  const [open, setOpen] = useState(startOpen);
  const [mode, setMode] = useState('in');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Starts true when configured and goes false only if the script will not
  // load, so the divider and the button disappear together.
  const [googleReady, setGoogleReady] = useState(googleEnabled());
  const emailRef = useRef(null);
  const googleRef = useRef(null);

  useEffect(() => { if (open) emailRef.current?.focus(); }, [open, mode]);

  /**
   * Google's button, rendered into a div this component owns.
   *
   * Effect rather than markup because the button is not ours to draw: GIS
   * injects it, and it has to be re-registered whenever the panel reopens,
   * since `google.accounts.id.initialize` keeps exactly one callback globally.
   *
   * A failure here is deliberately quiet. The script is a third-party request
   * that a tracker blocker or an offline moment will refuse, and the email and
   * password form beside it still works -- so the button simply does not
   * appear. Turning somebody's ad blocker into a red error message on a sign-in
   * panel would be reporting our problem as their failure.
   */
  useEffect(() => {
    if (!open || !googleEnabled() || !googleRef.current) return undefined;
    let cancelled = false;
    renderGoogleButton(googleRef.current, async (credential) => {
      setBusy(true);
      setError(null);
      try {
        onUser(await signInWithGoogle(engine, credential));
        setOpen(false);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    }).catch(() => {
      if (!cancelled) setGoogleReady(false);
    });
    return () => { cancelled = true; releaseGoogleButton(); };
  }, [open, engine, onUser]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = mode === 'in'
        ? await signIn(engine, { email, password })
        : await signUp(engine, { email, name, password });
      onUser(u);
      setOpen(false);
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return (
      <div className="account">
        <span className="account-chip" title={user.email}>
          <span className="account-swatch" style={{ background: user.color }} />
          {user.name}
        </span>
        <button
          className="link-btn"
          onClick={async () => { await signOut(engine); onUser(null); }}
        >
          Sign out
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="account">
        <button className="account-btn" onClick={() => { setMode('in'); setOpen(true); }}>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="account">
      <form className="account-form" onSubmit={submit}>
        <div className="account-tabs">
          <button
            type="button"
            className={mode === 'in' ? 'on' : ''}
            onClick={() => { setMode('in'); setError(null); }}
          >
            Sign in
          </button>
          <button
            type="button"
            className={mode === 'up' ? 'on' : ''}
            onClick={() => { setMode('up'); setError(null); }}
          >
            Create account
          </button>
        </div>

        <input
          ref={emailRef}
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {mode === 'up' && (
          <input
            type="text"
            placeholder="Display name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          type="password"
          placeholder={mode === 'up' ? 'Password (8+ characters)' : 'Password'}
          autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <p className="account-error" role="alert">{error}</p>}

        <div className="account-actions">
          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? 'Working...' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
          {!startOpen && (
            <button type="button" className="link-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          )}
        </div>

        {/* Below the password form, not above it. Google is one way in of two,
            and leading with it makes the accounts this project actually owns
            look like the fallback. Both tabs show it: for somebody who has
            only ever signed in with Google, "Sign in" and "Create account" are
            the same button, and the server treats them that way too. */}
        {googleReady && (
          <div className="account-or" aria-hidden="true"><span>or</span></div>
        )}
        <div
          className="account-google"
          hidden={!googleReady}
          // Google draws the button and owns everything inside this node, so
          // React is given nothing here to reconcile against.
          ref={googleRef}
        />
      </form>
    </div>
  );
}
