import React, { useEffect, useMemo, useRef, useState } from 'react';
import './mosaic.css';
import { Search, Arrow } from './icons.jsx';
import { InternalsPanel } from './Internals.jsx';
import { FeaturesPanel } from './Features.jsx';
import { AccountBar, useSession } from '../account/Account.jsx';
import { LiveDemo } from './LiveDemo.jsx';
import { IntroDemo } from './IntroDemo.jsx';
import { listDocs, createDoc } from '../../api.js';
import { ImportDialog } from '../import/ImportDialog.jsx';
import { listLocalDocs } from '../../local-docs.js';
import { listable } from '../../listable.js';
import { useDisplayFont } from '../use-display-font.js';

/**
 * Documents on the site are CRDT-only (ADR-009), so this palette searches and
 * creates on one server. The OT server is still running and still complete --
 * the lab is where you meet it, and where the difference is the point rather
 * than a decision forced on someone who just wants to write something down.
 */
const ENGINES = [
  { id: 'yjs', label: 'CRDT', port: 8080 },
];

/**
 * The sections a reader has any business visiting, in the order they make
 * sense read left to right: do the thing, then see how it works, then read why
 * it was built that way.
 *
 * NOT every route in main.jsx, and the omission is the interesting part.
 * `/doc` is a document rather than a section, and you reach it by opening one.
 */
const NAV = [
  { href: '/docs', label: 'Documents', hint: 'Your documents' },
  { href: '/lab', label: 'Lab', hint: 'Partition two replicas and heal them, under either engine' },
  { href: '/engines', label: 'Engines', hint: 'How each engine reconciles concurrent edits' },
  { href: '/decisions', label: 'Decisions', hint: 'Every ADR, in full' },
];

/**
 * Measured by tools/measure-delta.mjs, not estimated.
 *
 * A reconnecting client that is already up to date pays a flat ~322 B
 * regardless of document size, so the saving grows linearly with the document.
 * Bar heights are a log-ish curve because the ratios are exponential; the
 * printed values are the real ones.
 *
 * WHAT THAT 322 B IS. `lastSyncRecv` counts EVERY byte received before the
 * client is synced (see stats in ../../sync/yjs-sync.js): the `MSG_HELLO`
 * envelope and any awareness frame as well as the Yjs exchange. HELLO carries
 * the document title, the tab id and title (ADR-014), the role, the user and
 * whether the document is unowned (ADR-007, ADR-010), so the floor sits where
 * it does because of the join envelope rather than because of delta sync.
 *
 * The claim this panel makes is that the cost is FLAT in document size: 322 B
 * at 1K characters and 322 B at 50K. A richer join envelope moves the floor;
 * it does not change the shape, which is what the chart draws.
 *
 * `h` is a drawing of that shape and may be rescaled to fit the cell. `ratio`
 * is the measurement and may not: tools/landing-test.mjs asserts the rendered
 * figures still match what measure-delta.mjs produced.
 *
 * This panel takes the narrower left column because it is the tile that can.
 * A chart of seven exponential ratios is one of the most compressible things
 * on the page -- narrow the bars and shorten them and the curve still reads,
 * because the shape IS the content and the numbers are printed on it anyway.
 * A photograph of an editor toolbar is the opposite: it degrades into grey
 * noise the moment it is too small to read.
 */
const DELTA = [
  { size: '1K', ratio: 3, h: 28.3 },
  { size: '2K', ratio: 6, h: 53.0 },
  { size: '5K', ratio: 16, h: 86.2 },
  { size: '10K', ratio: 31, h: 108.3 },
  { size: '20K', ratio: 62, h: 133.0 },
  { size: '50K', ratio: 154, h: 154.0 },
  { size: '100K', ratio: 408, h: 173.4 },
];

/**
 * Must stay identical to the stacked-layout breakpoint in mosaic.css. If the
 * two drift, the long placeholder gets rendered into the short field and is
 * visibly truncated -- which is exactly what happened on landscape phones.
 */
const COMPACT_MQ = '(max-width: 700px), (max-height: 520px)';

const newDocId = () => `doc-${Math.random().toString(36).slice(2, 8)}`;

const docHref = (engine, docId) => `/doc?doc=${encodeURIComponent(docId)}`;

export function Landing() {
  // Accounts are shared across engines, so one server can answer who you are.
  const { user, setUser } = useSession('yjs');
  const [docs, setDocs] = useState([]);
  const [query, setQuery] = useState('');
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(COMPACT_MQ).matches);
  const inputRef = useRef(null);

  // The full placeholder is truncated by the narrower mobile field, and a
  // half-visible sentence reads as a layout bug. CSS cannot swap text.
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_MQ);
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // The mosaic owns the root font-size, so the class goes on <html> and is
  // removed on unmount -- the editor and the lab share this document root.
  useEffect(() => {
    document.documentElement.classList.add('mosaic');
    return () => document.documentElement.classList.remove('mosaic');
  }, []);

  // The display face, shared with every other surface that adopts this look.
  // The hook is reference counted because the editor shares the typeface; the
  // lab opts out, so it stays free of the external request.
  useDisplayFont();

  // One-shot entrance, then the animation classes are removed entirely so the
  // page settles back to its static authored styles.
  useEffect(() => {
    const root = document.documentElement;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced || window.__entrancePlayed) {
      clearTimeout(window.__entranceFailsafe);
      root.classList.remove('motion-pending', 'entrance-run');
      return;
    }
    window.__entrancePlayed = true;

    let done = false;
    const start = () => {
      if (done) return;
      done = true;
      clearTimeout(window.__entranceFailsafe);
      root.classList.remove('motion-pending');
      root.classList.add('entrance-run');
      setTimeout(() => root.classList.remove('entrance-run'), 1850);
    };

    // Race font loading against a deadline: a slow font must not hold the page.
    document.fonts?.ready.then(start);
    const deadline = setTimeout(start, 700);
    return () => clearTimeout(deadline);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const all = await Promise.all(ENGINES.map(async (e) => {
        try {
          // Sends the session token, so this is YOUR documents plus the
          // unowned ones -- never a listing of other people's.
          const body = await listDocs(e.id);
          return (body.docs ?? []).map((d) => ({ ...d, engine: e.id, engineLabel: e.label }));
        } catch {
          // A server that is down must not blank the other engine's list.
          return [];
        }
      }));
      // Same rule as the documents page: empty `Untitled` documents and
      // harness scratch pads are left out, so the front page never offers a
      // row the documents page would not list.
      const mine = new Set(listLocalDocs().map((d) => d.docId));
      if (!cancelled) {
        setDocs(all.flat()
          .filter((d) => listable(d, mine))
          .sort((a, b) => b.updatedAt - a.updatedAt));
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  /**
   * The one document Enter would open, or null to create instead.
   *
   * Nothing is rendered from this: the front page does not recite your
   * document titles. It exists so that typing the name of something that
   * already exists opens it rather than making a second one with the same
   * name.
   *
   * Exact title first, then a substring, then the id: a name you typed in full
   * should never lose to something that merely contains it.
   */
  const topMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const label = (d) => (d.title ?? d.docId).toLowerCase();
    return docs.find((d) => label(d) === q)
      ?? docs.find((d) => label(d).includes(q))
      ?? docs.find((d) => d.docId.toLowerCase().includes(q))
      ?? null;
  }, [docs, query]);

  /*
   * Import is a dialog, and it is the SAME dialog /docs opens. A second
   * implementation of the importer would be a second place for the Drive path
   * to be subtly wrong.
   */
  const [importing, setImporting] = useState(false);

  /**
   * What a finished import does, matching DocsPage: go straight to the
   * document. The loss note is stashed for the editor to show, because what
   * the vocabulary could not carry is the one thing the reader needs told, and
   * the editor is where they will be looking (ADR-021).
   */
  const onImported = (result) => {
    if (result.loss) {
      try { sessionStorage.setItem(`import-loss:${result.docId}`, result.loss); }
      catch { /* private mode: the document imported, only the note is lost */ }
    }
    location.href = docHref('yjs', result.docId);
  };

  const open = async (d) => {
    // Creating goes through the API whether or not you are signed in. Signed
    // in the document gets an owner; signed out it is unowned and open to
    // anyone with the link -- but it is a real document either way, with a
    // generated slug id and a title.
    //
    // If the API is unreachable, fall back to opening what you typed as the
    // document id: a document you can open beats an error message, and the
    // socket creates it on connect.
    if (d.create) {
      try {
        const made = await createDoc(d.engine, d.docId);
        location.href = docHref(d.engine, made.doc.docId);
        return;
      } catch {
        location.href = docHref(d.engine, d.docId);
        return;
      }
    }
    location.href = docHref(d.engine, d.docId);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur(); return; }
    if (e.key !== 'Enter') return;
    const q = query.trim();
    if (!q) return;
    e.preventDefault();
    // Open what you named if it exists, make it if it does not.
    open(topMatch ?? { create: true, docId: q, engine: 'yjs' });
  };

  return (
    <div className="mosaic-page">
      {/*
        The site map, and the only place it exists.

        Every other route opens with a "<- collab-docs" link home, which makes
        this page the hub, so the hub carries the map. Without it /engines is
        reachable from nowhere.

        It is a map of SECTIONS, not of routes. See the NAV comment above.

        The panels carry their own calls to action too -- the introduction
        opens /docs, the demo band opens the lab -- and that overlap is
        deliberate: a panel's link is an invitation in context, this is the
        map. What the panels must not do is recite the same list twice, which
        is why none of them enumerate routes.
      */}
      <header className="mosaic-nav">
        <a className="nav-brand" href="/" aria-label="collab-docs, home">
          <span className="nav-mark" aria-hidden="true">
            <i /><i />
          </span>
          collab-docs
        </a>

        <nav className="nav-links" aria-label="Sections">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} title={n.hint}>{n.label}</a>
          ))}
        </nav>

        <AccountBar engine="yjs" user={user} onUser={setUser} />
      </header>

      <main className="stage" aria-label="Project overview">

        {/*
          ---- 1 & 2. what it is built on, and what it does ----

          The left column answers the two questions the introduction raises and
          does not have room for: what is underneath it, and what else it can
          do. Neither belongs in the centre -- a 339-unit box beside a 627-unit
          one is not where the page's most important sentence goes, and that
          sentence is the introduction's.
        */}
        <section className="card internals" aria-label="What it is built on">
          <InternalsPanel />
        </section>

        <section className="card features" aria-label="What it does">
          <FeaturesPanel />
        </section>

        {/*
          ---- 3. the introduction ----

          The centre panel is the largest and the one a reader looks at first,
          so it is the one that introduces the site -- in plain words, not in a
          claim that lands only for someone who already knows what a seam is.
          The engine comparison is the band along the bottom, where it reads as
          the evidence for this claim rather than as the claim itself.

          The search field is here rather than in a panel of its own for the
          same reason: an introduction that ends in "so go and open one" should
          hand you the thing you open it with.
        */}
        <section className="card intro" aria-label="What this is">
          <div className="intro-pad">
            {/* The page's h1, and the only one: every other panel heading is
                an h2, so the document outlines under a subject rather than as
                a flat list of sibling sections.

                It sells, and names the thing while it does it. An About
                sentence ("a collaborative editor, built from the wire up") is
                accurate and gives nobody a reason to click, so this opens with
                the instruction and every clause after it is a thing the reader
                gets rather than a thing the project is. The terms somebody
                would actually search for -- real-time editing, live cursors,
                version history -- stay in, because a benefit nobody can name
                is a benefit nobody can look for. */}
            <h1><span className="g">Real-time editing.</span><br />No turns. No conflicts.</h1>

            {/* Two lines, deliberately. What a longer paragraph would describe
                -- two people typing into one document, live -- is running
                underneath it, and a description of motion cannot compete with
                the motion. */}
            <p className="intro-copy">
              Send a link and start typing. Every cursor shows up, every
              keystroke merges as it lands, and nothing is locked or lost.
            </p>

            <IntroDemo />

            <div className="intro-do">
              <div className="bar-search">
                <span className="mag"><Search /></span>
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={narrow ? 'Search or create…' : 'Search documents, or name a new one…'}
                  aria-label="Search documents, or name a new one"
                />
              </div>

              {/* Not gated on being signed in. Writing something down is the
                  one thing this site does, and putting an account in front of
                  it asks people to commit before they have seen anything. The
                  account is asked for at the point it becomes load-bearing --
                  sharing -- and not before. */}
              <button
                type="button"
                className="intro-new"
                onClick={() => open({ create: true, docId: query.trim() || 'Untitled', engine: 'yjs' })}
              >
                + New document
              </button>
            </div>

            {/*
              The two quiet ways out of this card.

              Import belongs on this row rather than beside "+ New document",
              and that is a measurement rather than a preference: as a third
              control in the action row it squeezes the search field until its
              own placeholder overflows by up to 97px at every viewport. This
              row has the slack; the action bar does not.

              A button, not a link, because it opens a dialog rather than going
              anywhere -- but styled as a link, because it is the same weight
              of offer as the one beside it. Needs no account, like creating
              one: an unowned document can be created and filled by anyone
              (ADR-010).

              No count on the first one. "All 7 documents" is a number that has
              to be right, on a card that does not otherwise care how many
              there are.
            */}
            <div className="intro-links">
              <a className="docs-link" href="/docs">All your documents &rarr;</a>
              <span className="intro-sep" aria-hidden="true">&middot;</span>
              <button
                type="button"
                className="intro-import"
                onClick={() => setImporting(true)}
              >
                Import a doc
              </button>
            </div>
          </div>
        </section>

        {/* ---- 4. delta sync ---- */}
        <section className="card insights" aria-label="Delta sync measurements">
          {/*
            The label names the thing being measured rather than the mechanism
            that does the measuring. "Delta sync" is the implementation's name
            for this and it would be the wrong word in the biggest slot on the
            page: it tells a reader who already knows what a delta is that they
            were right, and tells everyone else nothing. "Reconnect cost" is
            what a visitor is actually looking at.
          */}
          <span className="tag">Reconnect cost</span>
          <h2>408&times;</h2>

          {/*
            The subhead has to name BOTH sides of the ratio, because the number
            above it is a comparison and this is the only line large enough to
            be read before the chart is. Name one side only -- "smaller than
            the document" -- and the figure sits in 37-unit type meaning
            nothing.

            100,000 characters is the last bar, and characters is genuinely
            what tools/measure-delta.mjs fills the document with, so the unit
            is the measured one rather than a friendlier approximation of it.
          */}
          <div className="sub">less to send when you rejoin a 100,000-character document</div>

          <p className="insights-why">
            On reconnect the client says what it already has, and the server
            replies with the missing updates only &mdash; never the whole
            document again, however large it has grown.
          </p>

          <div
            className="chart"
            role="img"
            aria-label="Reconnect cost versus document size: 1K 3 times smaller, 2K 6, 5K 16, 10K 31, 20K 62, 50K 154, 100K 408 times smaller"
          >
            {DELTA.map((d, i) => (
              <div className="col" key={d.size}>
                <div
                  className={`bar${i === DELTA.length - 1 ? ' hot' : ''}`}
                  style={{ height: `${d.h}rem` }}
                >
                  {d.ratio}&times;
                </div>
                <div className="day">{d.size}</div>
              </div>
            ))}
          </div>
        </section>

        {/*
          ---- 5. the demonstration ----

          A band across the foot of the page: real Y.Docs and real
          TextOperation, partitioned and healed. Down here it is the proof of
          the claim the introduction makes above it, which is the job it can
          actually do -- in the centre it would be the claim itself.

          A <section>, not an <a>: the card keeps its whole-surface click
          through `.go`, whose ::after covers it, because a <button> inside an
          <a> is invalid markup and hands a keyboard user one tab stop for two
          different actions.
        */}
        <section className="card demo-strip" aria-label="Two engines, the same partition">
          <div className="strip-lede">
            <h2>Watch it hold together</h2>
            <p>
              The same document, partitioned, through a CRDT and hand-written
              OT at once. Cut the wire &mdash; only one survives.
            </p>
            <a className="go" href="/lab">Open the lab <Arrow /></a>
          </div>

          <LiveDemo />
        </section>

      </main>

      {/*
        ---- is this for me ----

        The panels answer "what is it", "what is it built on", "what does it
        do" and "does it hold together". None of them answers the question a
        visitor is left holding: whether any of this is reachable without
        signing up, and whether the figures are measured or decorative. So it
        is stated rather than implied, and stated at the foot because that is
        where a reader goes looking for it once the page has interested them.

        It costs the composition nothing: the knob is bound by WIDTH at every
        16:10-and-wider viewport, so the extra height comes out of margin that
        would otherwise be empty.

        Deliberately not a link list. The nav above is the only site map on
        this page -- see the header comment -- and a footer that recites it
        again is the second copy that comment exists to prevent.

        Nothing here is invented. There is no pricing, no logo wall and no
        testimonial, because this project has none of those and a fabricated
        one would be the single most expensive thing on the page.
      */}
      {importing && (
        <ImportDialog
          engine="yjs"
          userEmail={user?.email}
          onImported={onImported}
          onClose={() => setImporting(false)}
        />
      )}

      <footer className="mosaic-foot">
        <p>
          Open a document without an account &mdash; every figure on this page
          is produced by a harness in this repository.
        </p>
      </footer>
    </div>
  );
}

/** Exported for the "new document" affordance elsewhere. */
export { newDocId, docHref };
