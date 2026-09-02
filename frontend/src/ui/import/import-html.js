/**
 * Turning HTML into a document here, whatever the HTML came from.
 *
 * ONE SOURCE, and it is the fragile one: importing means picking the document
 * out of your Drive, and the Picker needs a Cloud project, an API key, an
 * enabled Picker API and -- until the app is verified -- an account named as
 * a test user.
 *
 *   Drive    picked through Google, exported as HTML   (google/picker.js)
 *
 * The conversion does not know that. `importFromDrive` exports the file as
 * HTML and hands it to `importHtml` below, so the loss report, the link
 * unwrapping and the "defaults are not formatting" rule live in one place
 * whatever hands them a string. That is also why `htmlToRichText` takes a
 * string rather than talking to Drive: the interesting part of this feature is
 * the conversion, and tying it to a source that can be switched off by a
 * console setting would be the wrong dependency.
 */
import { htmlToRichText, describeImportLoss } from './html-to-rich.js';
import { createDoc, importIntoDoc } from '../../api.js';

/**
 * Convert HTML and make it a document.
 *
 * The document is created LAST, after the conversion has succeeded. Creating
 * it first would be shorter and would leave an empty "Untitled" behind every
 * time somebody pastes something that turns out not to be a document.
 *
 * @param {string} engine
 * @param {string} html
 * @param {string} [preferredTitle] what the source called it, if it knows
 * @returns {Promise<{docId: string, title: string, loss: string}>}
 */
export async function importHtml(engine, html, preferredTitle) {
  const { rich, loss, title } = htmlToRichText(html);
  if (!rich.length) throw new Error('there was no text in that');

  const name = (preferredTitle || title || '').trim() || 'Imported document';
  const made = await createDoc(engine, name);
  const docId = made.doc.docId;
  await importIntoDoc(engine, docId, rich.toJSON());
  return { docId, title: made.doc.title, loss: describeImportLoss(loss) };
}
