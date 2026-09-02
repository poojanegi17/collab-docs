/**
 * Choosing a file from Drive, and fetching it as HTML.
 *
 * THIS IS THE AUTHORISATION HALF OF GIS, and it is a different grant from the
 * one that signs somebody in. `gis.js` gets an ID TOKEN -- an assertion of who
 * a person is, carrying no authority over any Google API. This gets an ACCESS
 * TOKEN for `drive.file`, which is authority and nothing else: it says what may
 * be read, not who is reading. Signing in does not grant it, and holding it
 * does not sign anybody in. Somebody can import a file without ever having an
 * account here, and can have an account here without this application ever
 * being able to see a single file of theirs (ADR-021).
 *
 * WHY `drive.file` AND THE PICKER, RATHER THAN `drive.readonly`.
 * `drive.readonly` is a RESTRICTED scope: shipping it means Google's OAuth
 * verification plus an annual third-party security assessment costing
 * thousands of dollars a year. `drive.file` is non-sensitive, needs neither,
 * and grants access only to files the user hand-picks through Google's own
 * Picker. So the cheap path and the least-privilege path are the same path,
 * which is a pleasant thing to be able to write down.
 *
 * WHY NO REFRESH TOKEN, AND THEREFORE NO BACKEND. The obvious design is the
 * server-side authorization-code flow, which yields a refresh token: durable
 * authority to read somebody's Drive while they are not there. That is what
 * you need for background sync, and this is not background sync -- the user is
 * sitting in front of the page, clicks Import, picks a file, and it is over in
 * a few seconds. An access token they just consented to covers that
 * completely. Taking a refresh token instead would mean holding a long-lived
 * key to a stranger's Drive to do a job that finishes immediately, plus
 * encryption at rest, revocation, and a secret on the server. So: nothing is
 * stored, this server never talks to Google at all, and the token dies on its
 * own in about an hour.
 *
 * The visible cost is that a second import next week asks for consent again.
 * For one-shot import that is invisible; for the sync feature we are not
 * building it would be the wrong trade.
 */
import { GOOGLE_CLIENT_ID, googleEnabled } from './gis.js';

/** Non-sensitive. Grants access to picked files only -- see the header. */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/**
 * The Picker needs an API key and the project NUMBER in addition to the client
 * id -- the number is what associates a picked file with this application, so
 * that `drive.file` recognises it afterwards. Both are public.
 */
/*
 * Both trimmed, for the reason `gis.js` gives about the client id -- and the
 * failures here are worse, because they do not name themselves. A newline on
 * the key is a 401 from the Picker; a newline on the app id is an `appId` that
 * matches no project, so the picked file is not associated with this
 * application and `drive.file` does not cover it. That surfaces as a 404 on
 * export: "that file could not be read", about a file the user just chose.
 */
export const GOOGLE_API_KEY = (import.meta.env?.VITE_GOOGLE_API_KEY ?? '').trim();
export const GOOGLE_PROJECT_NUMBER = (import.meta.env?.VITE_GOOGLE_PROJECT_NUMBER ?? '').trim();

/** Everything the Picker needs, or the import button should not be offered. */
export const driveImportEnabled = () =>
  googleEnabled() && Boolean(GOOGLE_API_KEY) && Boolean(GOOGLE_PROJECT_NUMBER);

const GAPI_SRC = 'https://apis.google.com/js/api.js';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

const loaded = new Map();

/** Load a script once, resolving when it is there. */
function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src);
  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.ready === 'true') { resolve(); return; }
    const script = existing ?? document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => { script.dataset.ready = 'true'; resolve(); });
    script.addEventListener('error', () => {
      // Cleared so a later attempt can retry: offline and tracker blockers are
      // both recoverable and both common.
      loaded.delete(src);
      reject(new Error('could not reach Google'));
    });
    if (!existing) document.head.appendChild(script);
  });
  loaded.set(src, promise);
  return promise;
}

/** `gapi.load` is callback-shaped and predates promises. */
function loadPickerModule() {
  return new Promise((resolve, reject) => {
    window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('picker failed to load')) });
  });
}

/**
 * Ask Google for an access token, showing the consent popup.
 *
 * A fresh token every time rather than one cached in a module variable. It
 * would be valid for about an hour, and caching it would mean holding
 * authority over somebody's Drive for fifty-nine minutes after the four
 * seconds it was needed for -- readable, like anything else in the page, by
 * any script that gets in. The popup is only shown again when the user
 * actually asks to import again.
 *
 * @returns {Promise<string>} an access token
 */
export async function requestDriveToken({ hint } = {}) {
  if (!googleEnabled()) throw new Error('Google is not configured');
  await loadScript(GIS_SRC);
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      // Somebody who signed in with Google has already told us which account
      // they are, and asking again makes one grant look like two logins. The
      // hint pre-selects that account, so what they see is the permission
      // question -- which IS a second question, and a real one -- without the
      // account chooser in front of it.
      //
      // A hint and nothing stronger: it selects, it does not authorise. If the
      // address does not match a session in the browser Google falls back to
      // asking, which is the correct behaviour rather than a failure.
      ...(hint ? { hint } : {}),
      callback: (response) => {
        if (response.access_token) resolve(response.access_token);
        else reject(new Error(response.error_description || 'no access token'));
      },
      error_callback: (err) => {
        // Closing the consent popup is a decision, not a failure, and must not
        // surface as a red error on the page.
        reject(err?.type === 'popup_closed'
          ? Object.assign(new Error('cancelled'), { cancelled: true })
          : new Error(err?.message || 'Google would not grant access'));
      },
    });
    client.requestAccessToken();
  });
}

/**
 * Open the Picker and resolve with the chosen file, or null if cancelled.
 *
 * @param {string} token an access token from `requestDriveToken`
 * @returns {Promise<{id: string, name: string, mimeType: string}|null>}
 */
export async function pickDriveFile(token) {
  await loadScript(GAPI_SRC);
  await loadPickerModule();

  return new Promise((resolve) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCUMENTS)
      // Google Docs only. The converter reads the HTML that Docs exports, and
      // offering a spreadsheet or a PDF here would be offering an import that
      // is going to fail after the user has already chosen.
      .setMimeTypes('application/vnd.google-apps.document')
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);

    const picker = new window.google.picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(GOOGLE_API_KEY)
      // Without the app id, a file picked here is not associated with this
      // application, and the `drive.file` grant will not cover it -- the
      // export below then fails with a 404 that looks like a missing file.
      .setAppId(GOOGLE_PROJECT_NUMBER)
      .addView(view)
      .setCallback((data) => {
        const { Action, Response, Document } = window.google.picker;
        if (data[Response.ACTION] === Action.CANCEL) { resolve(null); return; }
        if (data[Response.ACTION] !== Action.PICKED) return;
        const file = data[Response.DOCUMENTS]?.[0];
        resolve(file ? {
          id: file[Document.ID],
          name: file[Document.NAME],
          mimeType: file[Document.MIME_TYPE],
        } : null);
      })
      .build();
    picker.setVisible(true);
  });
}

/**
 * Export one Google Doc as HTML.
 *
 * `alt=media` on the export endpoint returns the bytes rather than metadata.
 * The response is Google's own HTML flavour -- boldness in a stylesheet, links
 * behind the click redirector -- which is precisely what `htmlToRichText` is
 * written against.
 *
 * @param {string} fileId
 * @param {string} token
 * @returns {Promise<string>}
 */
export async function exportDriveFileAsHtml(fileId, token) {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`
    + '/export?mimeType=text%2Fhtml';
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // 403 here is nearly always the export size limit (10MB) rather than
    // permission, because the Picker just granted permission a moment ago.
    if (res.status === 403) throw new Error('Google refused to export that file - it may be too large');
    if (res.status === 404) throw new Error('that file could not be read');
    throw new Error(`Google returned ${res.status} exporting that file`);
  }
  return res.text();
}
