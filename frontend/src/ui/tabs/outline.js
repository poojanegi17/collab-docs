/**
 * The headings of a document, in order, with where each one starts.
 *
 * Engine-agnostic by construction, like `export-markdown.js`: it is handed a
 * RichText and never learns which engine produced it. That matters more here
 * than it looks — this runs on every keystroke, and it must not be the one
 * place in the UI that has to ask what a document is made of.
 *
 * Line attributes ride on the newline ENDING a line (ADR-006), so a heading is
 * found by walking to a line terminator and reading `header` off it, not by
 * reading the first run of the line. The last line of a document has no
 * terminator and therefore nowhere to carry a line attribute — but that is not
 * a gap in this walk, because `applyLine` appends a newline before formatting
 * there, precisely so a heading on the last line is not silently impossible.
 */

/** Headings deeper than this are still headings; the panel just stops indenting. */
const MAX_DEPTH = 6;

/**
 * @param {import('@collab/ot').RichText} rich
 * @param {{ limit?: number }} [opts]
 * @returns {{ level: number, text: string, from: number }[]}
 *   `from` is the character offset the heading's line starts at, which is what
 *   the editor needs to scroll to it.
 */
export function outlineOf(rich, { limit = 300 } = {}) {
  const out = [];
  if (!rich?.runs) return out;

  let pos = 0;        // absolute offset of the next character
  let lineStart = 0;  // where the line being read began
  let buffer = '';    // its text so far

  for (const run of rich.runs) {
    const text = run.text ?? '';
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf('\n', i);
      if (nl < 0) {
        buffer += text.slice(i);
        pos += text.length - i;
        break;
      }
      buffer += text.slice(i, nl);
      pos += nl - i;

      const level = Number(run.attributes?.header ?? 0);
      // A blank heading is skipped rather than listed as an empty row: pressing
      // Enter at the end of a heading leaves one behind for as long as it takes
      // to type the next one, and an index that flickers a nameless entry into
      // itself on every paragraph break is worse than one that waits.
      const label = buffer.trim();
      if (level > 0 && label) {
        out.push({
          level: Math.min(MAX_DEPTH, level),
          text: label.slice(0, 120),
          from: lineStart,
        });
        if (out.length >= limit) return out;
      }

      pos += 1;          // the newline itself
      lineStart = pos;
      buffer = '';
      i = nl + 1;
    }
  }

  return out;
}
