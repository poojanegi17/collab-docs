/**
 * Google Identity Services, loaded only when somebody wants to sign in.
 *
 * WHAT THIS GETS, AND WHAT IT DELIBERATELY DOES NOT. This is the
 * AUTHENTICATION half of GIS -- `google.accounts.id` -- which produces an ID
 * token: a signed assertion of who someone is. It carries no authority over
 * any Google API, so signing in here does not give this application access to
 * anybody's Drive. Reading a Drive file is a separate grant with a separate
 * consent, requested through `google.accounts.oauth2` when the import feature
 * asks for it (ADR-020). Keeping the two apart is not tidiness: it is what
 * lets someone sign in without handing over their documents.
 *
 * WHY THE SCRIPT IS LOADED LAZILY. It is a third-party script from
 * accounts.google.com, and putting it in index.html would put a request to
 * Google on the critical path of every page load -- including the landing page,
 * the lab and the offline case, none of which need it. It would also mean the
 * app's first paint waits on a host it does not control, and that the offline
 * persistence harness loads a script that cannot load. So it arrives when the
 * sign-in panel opens and not before.
 *
 * WHY THE CLIENT ID COMES FROM THE BUILD. It is public -- it ships in this
 * bundle either way, because the browser has to present it to Google. Reading
 * it from an environment variable rather than committing it keeps one
 * deployment's id out of another's, and makes "no Google project configured"
 * a state the UI can see: `googleEnabled()` is false, and the button is not
 * rendered at all rather than rendered and broken.
 */

/**
 * Public by nature. Set `VITE_GOOGLE_CLIENT_ID` to switch the feature on.
 *
 * Trimmed, because these values are pasted into a hosting dashboard by hand
 * and a copied line brings its line ending with it. Google then reports
 * `invalid_client` -- "the OAuth client was not found" -- which reads as a
 * deleted client or the wrong project rather than as one invisible character.
 * No leading or trailing space is ever meaningful in a client id.
 */
export const GOOGLE_CLIENT_ID = (import.meta.env?.VITE_GOOGLE_CLIENT_ID ?? '').trim();

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

export const googleEnabled = () => Boolean(GOOGLE_CLIENT_ID);

/** The in-flight or completed load, so N buttons cause one script tag. */
let loading = null;

/**
 * The callback for the CURRENT button.
 *
 * `google.accounts.id.initialize` is global and single-callback: calling it
 * again replaces what came before. React will mount and unmount the sign-in
 * panel repeatedly, so the callback is kept here and re-registered on each
 * render rather than assumed to survive.
 */
let onCredential = null;

function loadScript() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    // A previous load may have left the tag behind even though this module was
    // re-evaluated (hot reload in development does exactly that).
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing && window.google?.accounts?.id) { resolve(window.google.accounts.id); return; }

    const script = existing ?? document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => {
      if (window.google?.accounts?.id) resolve(window.google.accounts.id);
      else reject(new Error('Google Identity Services loaded but exposed nothing'));
    };
    script.onerror = () => {
      // Reset so a later attempt can retry: offline, blocked by an extension,
      // or a tracker blocker are all recoverable and all common.
      loading = null;
      reject(new Error('could not reach Google to sign in'));
    };
    if (!existing) document.head.appendChild(script);
  });
  return loading;
}

/**
 * Render Google's own sign-in button into `element`.
 *
 * `renderButton` rather than `prompt()` (One Tap). One Tap can be suppressed
 * by the browser or by a previous dismissal and then simply does nothing,
 * which from the user's side is a button that does not work. A rendered button
 * always opens the flow. It is also Google's branded button, which their
 * terms require anyway.
 *
 * @param {HTMLElement} element
 * @param {(credential: string) => void} handler  receives the raw ID token
 * @returns {Promise<void>}
 */
export async function renderGoogleButton(element, handler, { width } = {}) {
  if (!googleEnabled()) throw new Error('Google sign-in is not configured');
  const id = await loadScript();
  onCredential = handler;
  id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    // The token goes straight to our own API, which verifies it there. Nothing
    // in this file reads a claim out of it -- a JWT's payload is readable by
    // anyone and proves nothing until the signature has been checked.
    callback: (response) => onCredential?.(response.credential),
    // One Tap's automatic sign-in would sign somebody in on page load without
    // their having asked. This is a button; it should do nothing until pressed.
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  element.replaceChildren();
  id.renderButton(element, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    ...(width ? { width } : {}),
  });
}

/** Forget the registered callback when the panel goes away. */
export function releaseGoogleButton() {
  onCredential = null;
}
