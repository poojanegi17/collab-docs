/**
 * The vocabulary of the value-carrying attributes, and the sanitisers that
 * make them safe to render.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * `bold: true` renders as a class name and carries no information from the
 * network into the DOM. `color: '#ff0000'` does: the value is written by
 * whoever is editing the document, arrives over the socket, and ends up inside
 * a `style` attribute. So does `link`, which ends up in an `href`. Both are
 * injection sinks, and a collaborator is not a trusted input -- neither is a
 * document restored from a log written months ago by a client version nobody
 * has any more.
 *
 * The rule here is allowlist, never escape: every value is either recognised
 * and emitted in a form this file constructed, or dropped. Nothing the network
 * supplies is ever concatenated into CSS or a URL as-is. A dropped attribute
 * renders as unformatted text, which is the correct failure -- the characters
 * are the document, the formatting is decoration.
 *
 * Shared by the renderer (marks.js) and the toolbar, so the set of fonts the
 * menu offers and the set the renderer will honour cannot drift apart.
 */

/**
 * Font stacks, by key.
 *
 * The document stores the KEY, not the stack. Storing the CSS would put an
 * arbitrary string from the network one step from `style`, and it would freeze
 * today's font list into every document ever written -- changing what "Serif"
 * means later would mean rewriting documents.
 */
export const FONTS = {
  sans: { label: 'Sans', css: 'var(--sans)' },
  serif: { label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Mono', css: 'var(--mono)' },
  system: { label: 'System', css: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  rounded: { label: 'Rounded', css: '"Nunito", "Trebuchet MS", system-ui, sans-serif' },
  condensed: { label: 'Condensed', css: '"Arial Narrow", "Roboto Condensed", sans-serif' },
};

/** Point sizes offered in the menu. Any integer in range is *rendered*. */
export const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36, 48, 60, 72];
export const MIN_SIZE = 6;
export const MAX_SIZE = 96;

/**
 * The colour swatches. Deliberately a small palette rather than a full picker:
 * these are the values that will be read back on a light AND a dark background
 * (the app has both), and an arbitrary picker makes it trivial to write text
 * that is invisible to the person you are sharing with.
 */
export const TEXT_COLORS = [
  '#111318', '#454b57', '#8a8f9a', '#b91c1c', '#c2410c', '#a16207',
  '#15803d', '#0e7490', '#1d4ed8', '#6d28d9', '#be185d',
];

export const HIGHLIGHT_COLORS = [
  '#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff', '#fed7aa', '#e2e8f0',
];

export const ALIGNMENTS = [
  { value: '', label: 'Left', icon: '≡' },
  { value: 'center', label: 'Center', icon: '≡' },
  { value: 'right', label: 'Right', icon: '≡' },
  { value: 'justify', label: 'Justify', icon: '≡' },
];

export const SPACINGS = [
  { value: '', label: 'Single' },
  { value: '115', label: '1.15' },
  { value: '150', label: '1.5' },
  { value: '200', label: 'Double' },
];

// ---- sanitisers -------------------------------------------------------------

/** @returns {string|null} a CSS font stack this file owns, or null. */
export function safeFont(value) {
  return typeof value === 'string' && Object.hasOwn(FONTS, value)
    ? FONTS[value].css
    : null;
}

/**
 * @returns {number|null} an integer point size in range, or null.
 * Bounded rather than merely validated: a 40000pt run written by a buggy or
 * hostile client would make the document unreadable for everyone who opens it.
 */
export function safeSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const size = Math.round(n);
  return size >= MIN_SIZE && size <= MAX_SIZE ? size : null;
}

/**
 * @returns {string|null} a `#rrggbb` literal, or null.
 *
 * Six hex digits and nothing else -- not "a CSS colour". `red` would be
 * harmless; the reason to refuse it is that the moment this accepts arbitrary
 * CSS colour syntax, the next value that looks colour-ish is
 * `red;position:fixed;inset:0` and the check has to become a CSS parser.
 */
export function safeColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : null;
}

/**
 * @returns {string|null} a URL safe to put in an href, or null.
 *
 * Scheme allowlist, because `javascript:` in an href is script execution in
 * the reader's page -- the classic way a shared document becomes an attack on
 * the person it was shared with. `data:` is excluded for the same reason.
 * Parsing with `URL` rather than a regex means the scheme is decided by the
 * same code the browser will use, so tricks like `java\tscript:` cannot make
 * the two disagree.
 */
export function safeLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
}

/** @returns {string} what a link input should become, or '' if unusable. */
export function normaliseLinkInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  // "example.com" is what people type. Assuming https rather than refusing it
  // is the difference between a link box that works and one that feels broken.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  return safeLink(withScheme) ?? '';
}

/** @returns {'bullet'|'number'|null} */
export function safeList(value) {
  return value === 'bullet' || value === 'number' ? value : null;
}

/** @returns {'center'|'right'|'justify'|null} -- left is the absence of a value. */
export function safeAlign(value) {
  return ['center', 'right', 'justify'].includes(value) ? value : null;
}

/** @returns {'115'|'150'|'200'|null} -- single spacing is the absence of a value. */
export function safeSpacing(value) {
  const key = String(value);
  return ['115', '150', '200'].includes(key) ? key : null;
}

/** @returns {number} 0..MAX_INDENT. Out-of-range clamps rather than dropping. */
export function safeIndent(value, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, max);
}

/**
 * @returns {string|null} a URL safe to put in an img src, or null.
 *
 * The same scheme allowlist as `safeLink`, minus `mailto:` (meaningless here)
 * and still without `data:`. Refusing `data:` is not about script execution --
 * a data URI in `img[src]` cannot run anything. It is about the update log: a
 * pasted screenshot is hundreds of kilobytes that would be logged, replayed on
 * every cold start and carried in every snapshot forever, and the storage
 * layer cannot tell that payload apart from a document. See ADR-013.
 */
export function safeImageSrc(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
}

/** Alt text. Bounded, and rendered as text content rather than as markup. */
export function safeAlt(value) {
  return typeof value === 'string' ? value.slice(0, 300) : '';
}

/**
 * Display width, as a percentage of the page.
 *
 * A percentage rather than pixels because the editor is responsive and a
 * pixel width set on a desktop is an overflowing image on a phone. Bounded
 * for the same reason `safeIndent` is: the value came off the network and
 * ends up as a length in the DOM.
 */
export function safeImageWidth(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(10, n));
}

/**
 * A table id. Opaque, and only ever compared for equality -- consecutive lines
 * carrying the same one are one table.
 */
export function safeTableId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : null;
}
