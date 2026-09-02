import React, { useEffect, useRef, useState } from 'react';

/**
 * The product, photographed.
 *
 * Nobody reads a feature list to decide they want something, least of all on
 * a page selling an editor whose whole appeal is visual. So the surfaces worth
 * seeing are shown rather than described, and the shots are photographs of the
 * real application: `tools/capture-shots.mjs` drives it in Chrome the way the
 * UI harnesses do, typing a real document, applying real formatting through
 * the real toolbar and posting a real comment.
 *
 * Nothing here is a mockup. A picture of a UI that does not exist is the most
 * expensive kind of decoration, because the person who checks is the person
 * you were trying to impress.
 *
 * The panel carries no heading of its own -- it would read "What it does" over
 * a list of what it does, and the <section> in Landing.jsx already gives it an
 * accessible name.
 *
 * Real-time editing is deliberately NOT one of these rows: it is what the
 * introduction demonstrates live, one panel to the right, and a screenshot of
 * it would be a still photograph of motion.
 */

const SHOTS = [
  {
    id: 'editing',
    name: 'Rich text',
    note: 'headings, lists, tables, images, colour, links',
    alt: 'The editor toolbar above a document with a heading and an italic run of text.',
  },
  {
    id: 'comments',
    name: 'Comments',
    note: 'pinned to the words, not to an offset',
    alt: 'A highlighted phrase in the document with its comment thread open beside it.',
  },
  {
    id: 'history',
    name: 'Version history',
    note: 'restore any point, and undo the restore',
    alt: 'The version history pane listing two named versions and an automatic one.',
  },
  {
    id: 'tabs',
    name: 'Tabs & outline',
    note: 'several documents under one title and one link',
    alt: 'The tab rail showing two tabs, the open one expanded into its headings.',
  },
  /*
   * Import is last, and it is here at all because it answers the question a
   * reader arrives with that none of the others do: not "what can this do"
   * but "can I bring what I already have". Everything above is a reason to
   * like the editor; this is the reason it is reachable at all for somebody
   * whose writing lives somewhere else.
   *
   * The note names Drive because Drive is the only route, and that makes this
   * the one row on the card advertising something a reader may not be able to
   * do: the picker needs a Google Cloud project and, until the app passes
   * verification, a named test user. The dialog says so in place rather than
   * failing silently.
   */
  {
    id: 'import',
    name: 'Import from Drive',
    note: 'pick a document — formatting comes with it',
    alt: 'The import dialog offering to choose a document from Google Drive.',
  },
];

/** Long enough to read the caption and then look at the picture. */
const CYCLE_MS = 4200;

export function FeaturesPanel() {
  const [at, setAt] = useState(0);
  /*
   * Set by the first hover, focus or click. The carousel is an invitation to
   * look, not something to fight: once somebody has chosen a row, it stays on
   * that row.
   */
  const [pinned, setPinned] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (pinned) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    timer.current = setInterval(() => setAt((i) => (i + 1) % SHOTS.length), CYCLE_MS);
    return () => clearInterval(timer.current);
  }, [pinned]);

  const pick = (i) => { setAt(i); setPinned(true); };

  return (
    <>
      {/*
        Every image is in the DOM and cross-faded, rather than one <img> whose
        src is swapped. A swapped src decodes on first switch, which on a cold
        cache is a blank frame in the middle of the panel -- and at 40 KB each
        this only front-loads a fetch the reader was going to make four seconds
        later anyway.
      */}
      <div className="feat-shot">
        {SHOTS.map((s, i) => (
          <img
            key={s.id}
            className={`feat-img${i === at ? ' is-on' : ''}`}
            src={`/shots/${s.id}.webp`}
            alt={i === at ? s.alt : ''}
            aria-hidden={i === at ? undefined : true}
            draggable="false"
          />
        ))}
      </div>

      <ul className="feat-list">
        {SHOTS.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={`feat${i === at ? ' is-on' : ''}`}
              aria-pressed={i === at}
              onMouseEnter={() => pick(i)}
              onFocus={() => pick(i)}
              onClick={() => pick(i)}
            >
              <b>{s.name}</b>
              <span className="feat-note">{s.note}</span>
            </button>
          </li>
        ))}
      </ul>

      {/* The rest, in one line rather than five more rows. Every one of them
          is real; none is worth a photograph of a sidebar.

          ONE LINE, and it has to stay one line. The rows above spend what
          slack this cell has: at two lines this paragraph rises into the last
          feature row and the two draw on top of each other. */}
      <p className="feat-also">
        Also: live cursors, sharing &amp; roles, full-text search, offline editing.
      </p>

      {/* No "why each of these works this way" link. The header nav carries
          Decisions on every page, so it would be a second route to the same
          place paid for out of the one cell with no room left. */}
    </>
  );
}

