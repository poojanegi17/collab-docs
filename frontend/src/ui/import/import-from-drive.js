/**
 * The whole "import from Drive" journey, as one function.
 *
 * Kept out of the component because it is a five-step sequence with four
 * places it can legitimately stop, and reading it inside a React handler --
 * interleaved with `setBusy` and `setError` -- is how you lose track of which
 * of those steps has already had a side effect.
 *
 * The steps, and who does what:
 *
 *   1. consent        Google      an access token for `drive.file` (picker.js)
 *   2. pick           Google      the user chooses one Doc, in Google's own UI
 *   3. export         Google      that Doc as HTML
 *   4. convert        us          HTML -> RichText, with a loss report
 *   5. create + fill  us          a new document, then POST the runs
 *
 * Nothing is created here until step 5, which matters: cancelling at the
 * Picker, or an export that fails, must not leave an empty untitled document
 * behind in somebody's list. That is the whole reason creation is last rather
 * than first, even though creating first would make the code shorter.
 */
import { requestDriveToken, pickDriveFile, exportDriveFileAsHtml } from '../../google/picker.js';
import { importHtml } from './import-html.js';

/**
 * @param {string} engine
 * @param {(stage: string) => void} [onProgress] told which step is running
 * @param {object} [opts]
 * @param {string} [opts.hint] the signed-in address, to skip the account chooser
 * @returns {Promise<{docId: string, title: string, loss: string}|null>}
 *          null when the user cancelled; otherwise the new document
 */
export async function importFromDrive(engine, onProgress = () => {}, { hint } = {}) {
  onProgress('Waiting for Google…');
  let token;
  try {
    token = await requestDriveToken({ hint });
  } catch (err) {
    // Closing the consent popup is a decision, not an error.
    if (err.cancelled) return null;
    throw err;
  }

  onProgress('Choose a document…');
  const file = await pickDriveFile(token);
  if (!file) return null;

  onProgress(`Fetching “${file.name}”…`);
  const html = await exportDriveFileAsHtml(file.id, token);

  // The Picker's name for the file beats the exported <title>: it is what the
  // user just clicked on, so it is the name they are expecting to see.
  onProgress('Converting…');
  return importHtml(engine, html, file.name);
}
