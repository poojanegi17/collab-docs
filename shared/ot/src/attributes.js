/**
 * Attribute maps, and the two operations on them that rich-text OT needs.
 *
 * An attribute map is a flat `{ bold: true, header: 2 }` object. Flat is a
 * deliberate constraint: nested attributes have no total order, and without a
 * total order there is no deterministic tie-break, which is exactly the
 * property `transform` depends on.
 *
 * `null` is a value, not an absence. It means "remove this attribute". The
 * distinction is load-bearing:
 *
 *   { bold: null }   un-bold this range
 *   { }              leave boldness alone
 *
 * Collapsing those two would make un-bolding indistinguishable from a no-op,
 * so an operation could never remove formatting it did not itself apply.
 */

/** Nothing rather than `{}` -- an empty map must not appear in a canonical op. */
const orNothing = (obj) => (Object.keys(obj).length ? obj : undefined);

/**
 * Sequential composition, the attribute analogue of `TextOperation.compose`:
 * the result is what you get by applying `a` and then `b`.
 *
 * `keepNull` distinguishes the two callers, and getting it wrong is a silent
 * data bug rather than a crash:
 *
 *   composing two OPERATIONS   keepNull = true
 *     A removal has to survive into the composed operation, or it will not
 *     remove anything when that operation is finally applied.
 *
 *   applying an operation to a DOCUMENT   keepNull = false
 *     Here the removal happens now. A document run must never carry a `null`
 *     attribute -- that would render as a formatting mark named "null".
 */
export function composeAttributes(a, b, keepNull = false) {
  const out = { ...(a ?? {}), ...(b ?? {}) };
  if (!keepNull) {
    for (const key of Object.keys(out)) {
      if (out[key] === null) delete out[key];
    }
  }
  return orNothing(out);
}

/**
 * Concurrent resolution. `a` and `b` were both written against the same
 * document; return the version of `b` that still makes sense after `a` landed.
 *
 * When `priority` is true, `a` wins every key they both touch. Two people
 * bolding the same word is not a conflict (same value, same result), but one
 * bolding it while the other un-bolds it is, and it must resolve the SAME way
 * on every replica or the documents diverge silently -- text identical,
 * formatting different, which is the worst kind of divergence because nothing
 * looks broken.
 *
 * The server is always argument `a`, exactly as in the plain-text transform.
 * That is the same server-authority trade documented in ADR-004: a CRDT
 * resolves this with per-attribute timestamps and needs no central arbiter.
 */
export function transformAttributes(a, b, priority) {
  if (!priority) return orNothing({ ...(b ?? {}) });
  const out = {};
  for (const [key, value] of Object.entries(b ?? {})) {
    if (!(key in (a ?? {}))) out[key] = value;
  }
  return orNothing(out);
}

/**
 * Attributes that describe a LINE, not a character range.
 *
 * They are stored on the newline that ends the line (see rich-text.js), which
 * means the newline is a character carrying formatting that belongs to
 * everything before it -- and that is a trap for anything reading attributes
 * positionally. Two bugs came from it, both fixed by consulting this list:
 *
 *   the toolbar   reading "what is under the caret" at the start of a line
 *                 looks at the character before it, which is the PREVIOUS
 *                 line's newline. A bulleted line above made the button read
 *                 as already-on, so pressing it turned the bullet off instead
 *                 of on.
 *
 *   typing        inserted text inherits the formatting to its left. At the
 *                 start of a line that is again the previous newline, so typed
 *                 characters silently acquired `bullet` or `header`.
 *
 * Kept here rather than in the UI because it is a fact about the document
 * model, and both the editor and the sync bindings need it.
 */
export const LINE_ATTRIBUTES = [
  'header', 'quote', 'bullet', 'list', 'align', 'indent', 'spacing',
  // A table row is an ordinary line carrying this attribute; consecutive lines
  // sharing a table id are one table (ADR-013). It is a LINE attribute for the
  // same reason `header` is -- it describes the line, not the characters.
  'table',
];

/**
 * The single character an image occupies.
 *
 * U+FFFC OBJECT REPLACEMENT CHARACTER, which is what Unicode provides for
 * exactly this: a stand-in for content that is not text. Making an image ONE
 * character is the whole of ADR-013 -- it has one position, so concurrent
 * inserts shift it, deletes remove it, and comment anchors span it, all
 * through machinery that already existed.
 */
export const EMBED_CHAR = String.fromCharCode(0xfffc);

/**
 * The character between two table cells.
 *
 * U+001F UNIT SEPARATOR -- a control character with no width, no meaning to a
 * text renderer, and no chance of being typed. Cells are separated rather than
 * nested, which is what keeps a table out of the document's structure and
 * inside its text (ADR-013).
 */
export const CELL_SEPARATOR = String.fromCharCode(0x1f);

/**
 * `bullet` and `list` both mean "this line is a list item".
 *
 * `bullet: true` came first and is still written by documents created before
 * ordered lists existed, so it is still read. Everything new writes
 * `list: 'bullet' | 'number'`, because ONE key is how mutual exclusion belongs
 * in this model: a line cannot be both kinds of list, and two keys would let
 * concurrent edits produce a line that claims to be both. With one key the
 * existing `transformAttributes` tie-break settles it -- the same way it
 * settles two people setting different headings.
 *
 * No migration: an old `bullet: true` line renders as a bullet, and the first
 * time anyone touches its list formatting it is rewritten as `list`.
 */
export const LIST_KINDS = ['bullet', 'number'];

/**
 * How far a line may be indented. Bounded because the value arrives from
 * another client over the network and ends up as a length in the DOM -- an
 * unbounded one is an easy way to push a line off the page for everybody.
 */
export const MAX_INDENT = 8;

/** Drop line-scoped attributes, keeping the character-level ones. */
export function inlineOnly(attributes) {
  if (!attributes) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!LINE_ATTRIBUTES.includes(key)) out[key] = value;
  }
  return orNothing(out);
}

/** Shallow equality. Used to decide whether two adjacent runs can merge. */
export function attributesEqual(a, b) {
  const ka = Object.keys(a ?? {});
  const kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) return false;
  return ka.every((key) => (a ?? {})[key] === (b ?? {})[key]);
}

/**
 * Drop `null` values, turning an attribute DIFF into an absolute attribute set.
 *
 * Needed where the two meanings meet: a retain's attributes are a diff against
 * whatever the document already had, but an insert's are absolute -- the text
 * is new, so there is nothing for a removal to remove.
 *
 * Allowing a null through to an insert is not a harmless no-op. It reaches the
 * document as a run attribute literally valued `null`, and from there the two
 * transform paths compose it differently and the replicas diverge with
 * identical text and different formatting. The property tests found this
 * within 300 iterations; no human would have written that test by hand.
 */
export function withoutNulls(attributes) {
  if (!attributes) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null) out[key] = value;
  }
  return orNothing(out);
}
