/**
 * What to call an engine, and what to call somebody with no account.
 *
 * Both are decided here, once, because both are answers the whole site has to
 * give the same way: a name that differs between the editor and every other
 * surface is read as two different things rather than as one thing described
 * twice.
 */

/**
 * The engine, in the reader's vocabulary rather than the package's.
 *
 * `engine.toUpperCase()` would put "YJS" -- the name of a dependency -- in the
 * one place on the site where the person looking at it is trying to write
 * something down. Every surface says CRDT and OT: the nav, /engines,
 * the lab toggle and every ADR. The raw id stays available on
 * hover, because the inspector is a debug panel and the distinction matters
 * there.
 */
export const ENGINE_LABEL = { yjs: 'CRDT', ot: 'OT' };

export const engineLabel = (engine) =>
  ENGINE_LABEL[engine] ?? String(engine ?? '').toUpperCase();

/**
 * A signed-out editor is numbered, not named.
 *
 * Handing a guest a plausible human name would put a person who does not
 * exist on a cursor label, an avatar, a comment and an authorship tint that no
 * account stands behind, with no way for a reader to tell it was invented. A
 * document with no account behind it has no authors; it has participants it
 * cannot name, and they are told apart by a number.
 *
 * The ordinal is assigned from presence in App.jsx. This is the shape it takes
 * and the test for recognising it again, kept together so the producer and the
 * parser cannot disagree.
 */
export const GUEST_PREFIX = 'Unknown';
export const GUEST_RE = /^Unknown (\d+)$/;
export const guestName = (n) => `${GUEST_PREFIX} ${n}`;

/** True for both `Unknown` and `Unknown 3` -- the first paint has no number. */
export const isGuest = (name) => /^Unknown(\s|$)/.test(name ?? '');

/**
 * Initials, except for guests.
 *
 * "UN" is not this person's initials any more than "Grace" was their name, so
 * an unnamed participant gets a dash: a mark that says there is somebody here
 * without claiming to know who.
 */
export const initials = (name) => (name ?? '?').slice(0, 2).toUpperCase();
export const avatarLabel = (name) => (isGuest(name) ? '–' : initials(name));

/**
 * What to print where a name is expected and might not be there.
 *
 * Every surface that shows a person had invented its own answer to this: the
 * comments pane said "Guest", the tasks pane said "someone", and a cursor with
 * no identity yet printed the raw client id -- six random characters, on a
 * label sitting in the middle of somebody's text. Three different words for
 * one state, none of them the word the rest of the site uses.
 *
 * `Unknown` unnumbered rather than `Unknown 1`: the ordinal is assigned from
 * presence, and this is the case where there is no presence entry to assign
 * one from. Claiming a specific number here would collide with a real one.
 */
export const displayName = (name) => (name && String(name).trim()) || GUEST_PREFIX;
