/**
 * Import a document from Drive.
 *
 * ONE ROUTE, AND ONE ACTION. The dialog's whole job is "pick the document out
 * of your Drive", so it offers that and nothing beside it: a second way in
 * would be answering a question nobody standing in front of this dialog has
 * asked.
 *
 * WHAT THAT COSTS, STATED PLAINLY. Drive needs a Google Cloud project, an
 * enabled Picker API and an API key, and until the app passes verification it
 * works only for accounts named as test users. `picker.js` reports all of that
 * as one boolean, and with one route there is nothing to fall back to when it
 * is false -- so this dialog says so in place rather than rendering an empty
 * box. See the `driveImportEnabled()` branch below.
 *
 * WHERE THE WORK HAPPENS. Not here. `importFromDrive` exports the picked file
 * as HTML and hands it to `importHtml`, so `import-html.js`, `html-parse.js`
 * and `html-to-rich.js` are what actually turn a document into this editor's
 * formatting vocabulary; this file is the picker and the error message.
 */
import React, { useEffect, useState } from 'react';
import { driveImportEnabled } from '../../google/picker.js';
import { importFromDrive } from './import-from-drive.js';

/**
 * @param {object} props
 * @param {string} props.engine
 * @param {string} [props.userEmail] pre-selects the account in Google's popup
 * @param {(result: {docId: string, loss: string}) => void} props.onImported
 * @param {() => void} props.onClose
 */
export function ImportDialog({ engine, userEmail, onImported, onClose }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  /** One path now, but failure is still reported in one place. */
  const run = async (stage, fn) => {
    setBusy(stage);
    setError(null);
    try {
      const result = await fn();
      // A cancelled Drive picker returns null and is not an error.
      if (result) onImported(result);
      else setBusy(null);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  };

  const enabled = driveImportEnabled();

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="modal import-modal"
        role="dialog"
        aria-label="Import from Google Drive"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <span>Import from Google Drive</span>
          <button className="icon-btn" disabled={Boolean(busy)} onClick={onClose} title="Close">x</button>
        </header>
        <p className="import-lede">
          A <strong>copy</strong> is made. The original is never changed, and the
          two are not kept in sync.
        </p>

        {enabled ? (
          <button
            type="button"
            className="account-btn import-drive-btn"
            disabled={Boolean(busy)}
            onClick={() => run('Waiting for Google…',
              () => importFromDrive(engine, setBusy, { hint: userEmail }))}
          >
            Choose from Google Drive
          </button>
        ) : (
          /*
           * Say why, rather than showing a dead button or an empty dialog.
           *
           * There is no fallback left to offer, so the only useful thing this
           * can do is name the missing configuration. It is deliberately
           * specific: "unavailable" sends somebody to the browser console,
           * whereas the variable names send whoever deployed it to the right
           * place in one step.
           */
          <p className="import-lede import-unavailable">
            Drive import is not configured on this deployment. It needs
            <code> VITE_GOOGLE_CLIENT_ID</code>, <code>VITE_GOOGLE_API_KEY</code>{' '}
            and <code>VITE_GOOGLE_PROJECT_NUMBER</code> at build time, and a
            Google account named as a test user until the app is verified.
          </p>
        )}

        {error && <p className="account-error" role="alert">{error}</p>}

        <div className="modal-actions">
          <span className="import-status" role="status">{busy}</span>
          <button type="button" className="link-btn" disabled={Boolean(busy)} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
