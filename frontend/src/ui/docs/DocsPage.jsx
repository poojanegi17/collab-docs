import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountBar, useSession } from '../account/Account.jsx';
import { ShareDialog } from '../share/ShareDialog.jsx';
import {
  listDocs, createDoc, renameDoc, deleteDoc, listTrash, undeleteDoc, getToken, getDoc,
  searchDocs, MATCH_START, MATCH_END, DOCUMENT_ENGINE,
} from '../../api.js';
import { ImportDialog } from '../import/ImportDialog.jsx';
import { listLocalDocs, forgetLocalDoc } from '../../local-docs.js';
import { listable } from '../../listable.js';
import { useDisplayFont } from '../use-display-font.js';

/**
 * The document home: browse everything you can reach, and manage it.
 *
 * ONE LIST with a scope selector, not a stack of panels. The kinds of document
 * still differ in what you may do with them --
 *
 *   yours    rename, share, delete
 *   shared   someone else's; you get a role badge and their name
 *   unowned  open to whoever has the link, and this browser has opened it
 *
 * -- but that is a property of the row (see `capsFor`), not of the section it
 * sits in, so it does not need a section. The selector switches which set is
 * showing and carries a count for each, which is what makes one list safe: a
 * scope you are not looking at is invisible, and the numbers keep "it is not
 * here" apart from "it is not anywhere".
 *
 * The one thing the list never shows is somebody ELSE'S unowned document --
 * the lab's scratch pads and every harness's leavings. See `listable`.
 */

/**
 * One engine, deliberately.
 *
 * Documents on the site are CRDT-only (ADR-009). Querying both servers and
 * merging would mean a person had to pick a concurrency-control algorithm
 * before they could write anything -- a choice with real consequences (an OT
 * document discards your offline edits on reconnect) and no way for them to
 * evaluate it. The comparison lives in the lab, where it is the subject rather
 * than a prerequisite.
 */
const ENGINE = { id: DOCUMENT_ENGINE, label: 'CRDT' };

/**
 * What this person may do to this document, from the document itself.
 *
 * From the ROW, never from which scope is showing. One list mixes the kinds
 * freely, and a scope was only ever a proxy for a property of the document
 * anyway.
 *
 * Rename covers unowned documents this browser opened as well as owned ones:
 * the server allows renaming anything unowned, and those are the ones a guest
 * has any business naming. Delete stays owner-only, because the endpoint is,
 * and a button that always 403s is not a button.
 */
function capsFor(doc, mine) {
  const own = doc.role === 'owner';
  const localUnowned = doc.unowned && mine.has(doc.docId);
  return {
    canRename: own || localUnowned,
    canShare: !doc.unowned || localUnowned,
    // An unowned document on this device can be deleted too. Nobody owns it,
    // so there is no owner being overruled -- and without this a guest could
    // make documents and never remove one.
    canDelete: own || localUnowned,
  };
}

function ago(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const docHref = (docId) => `/doc?doc=${encodeURIComponent(docId)}`;

const SCOPES = {
  all: {
    label: 'All',
    of: (x) => [...x.yours, ...x.shared, ...x.device],
    empty: 'Nothing yet. Type a name above and create one.',
  },
  yours: {
    label: 'Your documents',
    of: (x) => x.yours,
    empty: 'Nothing yet. Type a name above and create one.',
  },
  shared: {
    label: 'Shared with you',
    of: (x) => x.shared,
    empty: 'Nothing has been shared with you yet.',
  },
  trash: {
    label: 'Trash',
    of: (x) => x.trash,
    subtitle: 'Deleted documents, and the log behind them, are kept. Restoring one '
      + 'puts it back exactly as it was, including its version history and '
      + 'everyone it was shared with.',
    empty: 'Nothing deleted.',
  },
};

/**
 * The scopes a signed-in person can switch between.
 *
 * Signed OUT there is nothing to switch: no documents are owned by you and
 * none can have been shared with you, so every scope but one is empty by
 * definition and the selector is a control with a single meaningful setting.
 * That page shows the unowned documents this browser has opened, and says so
 * in a line under the heading instead.
 */
const SWITCHABLE = ['all', 'yours', 'shared', 'trash'];

const SORTS = {
  updated: { label: 'Recently updated', cmp: (a, b) => b.updatedAt - a.updatedAt },
  created: { label: 'Recently created', cmp: (a, b) => b.createdAt - a.createdAt },
  title: {
    label: 'Name (A\u2013Z)',
    // `localeCompare` so accented titles sort where a reader expects, and
    // `numeric` so "Draft 2" precedes "Draft 10".
    cmp: (a, b) => (a.title || a.docId).localeCompare(
      b.title || b.docId, undefined, { numeric: true, sensitivity: 'base' }),
  },
};

export function DocsPage() {
  useDisplayFont();
  const { user, setUser, ready } = useSession('yjs');
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  /**
   * Which set the single list is showing.
   *
   * `all` rather than `yours`, so a signed-out visitor lands on a list that
   * already contains the documents this browser made -- with one list, a scope
   * holding everything you have is the only landing that is never empty for
   * somebody who has written something.
   */
  const [scope, setScope] = useState('all');
  /*
   * Trash is a scope like any other, so "collapsed" is just "not selected".
   *
   * Note what does NOT decide whether a document is hidden: its name. A regex
   * over harness prefixes ("checklist-", "lab-") is wrong within one screen --
   * "toggle-", "zz-probe-" and "brand-new-" all sail through it, and every new
   * harness needs another alternation. Ownership is the real signal and it is
   * already in the data.
   */
  const [trash, setTrash] = useState([]);
  /** Content matches from the server. Title matches are still filtered locally. */
  const [hits, setHits] = useState([]);
  const [searchingBody, setSearchingBody] = useState(false);
  const [sharing, setSharing] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  /** Whether the import dialog is open. It owns its own progress state. */
  const [importing, setImporting] = useState(false);
  /**
   * Every id the server returned, before the empty ones were dropped.
   *
   * The device-document restore below needs to tell two absences apart: a
   * document the server never sent (it fell outside the unowned window, and
   * putting it back is the whole point) from one the server sent and this page
   * chose not to list (it is empty). Without this they look identical, and the
   * restore quietly undid the empty filter for exactly the documents most
   * likely to be empty -- a guest's.
   */
  const [returned, setReturned] = useState(() => new Set());
  const [sort, setSort] = useState('updated');
  /** The document a Delete click is waiting on confirmation for. */
  const [confirming, setConfirming] = useState(null);
  const firstMatchRef = useRef(null);

  /*
   * A snapshot of localStorage, not live state -- re-reading it on every
   * render would churn the memo below for no new information.
   *
   * State rather than a memo, because this page can now CHANGE it: deleting
   * an unowned document purges it, and the list has to let go in the same
   * breath. Left as a mount-time memo, the row came straight back on the next
   * load, restored from an entry pointing at a document that no longer exists.
   */
  const [localDocs, setLocalDocs] = useState(() => listLocalDocs());
  const localIds = useMemo(() => new Set(localDocs.map((d) => d.docId)), [localDocs]);

  const load = useCallback(async () => {
    try {
      const body = await listDocs(ENGINE.id);
      /*
       * Empty documents are not listed, and neither is anybody else's
       * unowned one. See `listable`.
       *
       * This application makes them very easily: the search box creates on
       * Enter, the lab makes a scratch document per visit, and every harness
       * run leaves a handful. In a listing they are indistinguishable from
       * real ones and they crowd out what somebody actually wrote.
       *
       * `chars` comes from the search projection rather than the update log's
       * size, because merely opening a document persists engine state: a byte
       * count answers "has this ever been connected to", not "is there
       * anything in it".
       *
       * A named-but-empty document is not spared either: an empty one is
       * discarded outright when its room is evicted, so listing it would mean
       * listing something about to stop existing.
       */
      const all = body.docs ?? [];
      setReturned(new Set(all.map((d) => d.docId)));
      setDocs(all
        .filter((d) => listable(d, localIds))
        .map((d) => ({ ...d, engine: ENGINE.id, engineLabel: ENGINE.label })));

      // Only with a session. The trash is owner-scoped, so signed out there
      // is nothing it could return -- and asking anyway would put a
      // guaranteed 401 in the console on every anonymous page load.
      const deleted = getToken() ? await listTrash(ENGINE.id) : { docs: [] };
      setTrash((deleted.docs ?? []).map((d) => ({ ...d, engine: ENGINE.id })));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [localIds]);

  useEffect(() => { if (ready) load(); }, [ready, load]);

  /**
   * Ask the server what the local filter cannot answer.
   *
   * The listing has always been filterable, but a listing only carries
   * titles -- the text lives in engine-specific bytes the browser has never
   * seen. So the two halves of "search" have genuinely different homes: the
   * title filter below stays local and instant and works signed out, and this
   * asks the server about CONTENT.
   *
   * Debounced at 250ms and skipped under two characters. A search box wired
   * straight to onChange sends a request per keystroke, and every one of them
   * is a full-text query against somebody's whole account.
   *
   * `cancelled` guards the response, not the request: replies can arrive out
   * of order, and without it a slow answer for "aq" can land after the fast
   * one for "aqueduct" and replace the right results with stale ones.
   */
  useEffect(() => {
    const q = query.trim();
    if (!getToken() || q.length < 2) { setHits([]); setSearchingBody(false); return; }
    let cancelled = false;
    setSearchingBody(true);
    const t = setTimeout(async () => {
      try {
        const body = await searchDocs(ENGINE.id, q);
        if (!cancelled) setHits(body.results ?? []);
      } catch {
        // A failed content search must not blank the page. The local title
        // filter is still showing real results next to it.
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearchingBody(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const sections = useMemo(() => {
    /*
     * Documents this browser opened that the listing did not come back with.
     *
     * The server caps the unowned pile it returns (OPEN_LIMIT) and orders it
     * by recency, so a guest's own document drops out of the response as soon
     * as fifty other unowned documents have been touched since. This list is
     * the only place an unowned document surfaces, so falling out of that
     * window would mean disappearing from the site.
     *
     * The browser already knows these -- id and title, in localStorage -- so
     * it can put them back itself. They carry `local: true` because a row
     * rebuilt from a convenience list cannot honestly claim a live edit time
     * or who is in it.
     */
    const restored = localDocs
      /*
       * Not passed through `listable` -- a document the server did not send
       * has no `chars` to test -- and not trusted blindly either.
       *
       * There are two reasons an entry can be missing from the listing, and
       * they want opposite treatment: the document fell outside the unowned
       * window and should be put back, or the server discarded it and it must
       * not be. Nothing local can tell those apart, so the effect below asks
       * the server about each one instead of guessing. Until it answers, the
       * row is shown -- the risk being guarded against is somebody losing
       * their own work, and a row that disappears a moment later is the
       * cheaper mistake.
       */
      .filter((d) => !returned.has(d.docId))
      .map((d) => ({
        docId: d.docId,
        title: d.title,
        engine: ENGINE.id,
        role: 'editor',
        unowned: true,
        local: true,
        updatedAt: d.at ?? 0,
        createdAt: d.at ?? 0,
        tabs: 1,
        online: 0,
      }));
    const known = [...docs, ...restored];

    const q = query.trim().toLowerCase();
    const match = (d) => !q
      || (d.title ?? '').toLowerCase().includes(q)
      || d.docId.toLowerCase().includes(q);

    const cmp = (SORTS[sort] ?? SORTS.updated).cmp;
    const visible = known.filter(match).sort(cmp);
    // Trash keeps its own order: what you want there is the thing you deleted
    // by mistake a moment ago, which is never "Aardvark notes".
    const visibleTrash = trash.filter(match).sort((a, b) => b.deletedAt - a.deletedAt);
    // Unowned documents this browser made, lifted out of the anonymous pile.
    // Without this a guest's own document sits collapsed among the harnesses'
    // scratch pads, indistinguishable from them -- which is the same as losing
    // it. See frontend/src/local-docs.js for why the server cannot do this.
    const device = visible.filter((d) => d.unowned && localIds.has(d.docId));
    /*
     * Unowned documents this browser has NOT opened are dropped here and never
     * reappear -- not in a section, not in the selector, not in a search.
     *
     * That pile is the lab's scratch pads and every test harness's leavings.
     * Hiding a real document is worse than showing clutter, but nobody using
     * the site has any relationship to somebody else's unowned document: it is
     * not theirs, it was not shared with them, and they have never opened it.
     * The server still returns them, because it cannot tell which this browser
     * knows
     * -- that is the whole reason `local-docs.js` exists.
     */
    return {
      yours: visible.filter((d) => d.role === 'owner'),
      shared: visible.filter((d) => !d.unowned && d.role !== 'owner'),
      device,
      trash: visibleTrash,
    };
  }, [docs, localDocs, returned, trash, query, localIds, sort]);

  /**
   * Drop on-device entries whose document is no longer there.
   *
   * These accumulate honestly: an unowned document is remembered when it is
   * opened, and the server deletes the ones that were never written in. The
   * entry outlives the document, and the page would otherwise rebuild a row
   * from it -- an untitled empty document that comes back on every load, no
   * matter how many other routes to one are closed.
   *
   * Asks rather than infers. `GET /api/docs/:id` answers for a single
   * document, and only the ones missing from the listing are asked about --
   * usually none, and never more than the fifty this list holds.
   */
  useEffect(() => {
    if (loading) return undefined;
    const missing = localDocs.filter((d) => !returned.has(d.docId));
    if (missing.length === 0) return undefined;

    let cancelled = false;
    (async () => {
      const gone = [];
      for (const d of missing) {
        try {
          const body = await getDoc(ENGINE.id, d.docId);
          if (!body?.doc) gone.push(d.docId);
        } catch {
          // A network failure is not evidence the document is gone. Leaving
          // the entry is the safe direction: the row stays, and the next load
          // asks again.
        }
      }
      if (cancelled || gone.length === 0) return;
      for (const id of gone) forgetLocalDoc(id);
      setLocalDocs(listLocalDocs());
    })();

    return () => { cancelled = true; };
  }, [localDocs, returned, loading]);

  const create = async () => {
    const title = query.trim() || 'Untitled';
    setCreating(true);
    setError(null);
    try {
      const made = await createDoc(ENGINE.id, title);
      location.href = docHref(made.doc.docId);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  };

  /**
   * A document was imported, whatever it came from (ADR-021).
   *
   * The loss report is carried to the editor in `sessionStorage` rather than
   * shown here, because this page is about to be replaced by the document and
   * a message on a page nobody is looking at any more is not a message. The
   * editor picks it up on load.
   */
  const onImported = (result) => {
    if (result.loss) {
      try { sessionStorage.setItem(`import-loss:${result.docId}`, result.loss); }
      catch { /* private mode: the document still imported, only the note is lost */ }
    }
    location.href = docHref(result.docId);
  };

  /**
   * Enter in the search box.
   *
   * The placeholder offers to name a new document, and the key did nothing at
   * all -- the only way to create one was to go and find the button.
   * This is the same bargain the landing page's field already makes: Enter
   * opens the top match if the text matches something, and creates otherwise,
   * so the field answers both halves of its own placeholder.
   */
  const onSearchKeyDown = (e) => {
    if (e.key === 'Escape') { setQuery(''); return; }
    if (e.key !== 'Enter' || !query.trim()) return;
    e.preventDefault();
    const top = firstMatchRef.current;
    if (top) location.href = docHref(top.docId);
    else create();
  };

  const commitRename = async (doc, title) => {
    setRenaming(null);
    if (!title.trim() || title === doc.title) return;
    try { await renameDoc(doc.engine, doc.docId, title.trim()); await load(); }
    catch (err) { setError(err.message); }
  };

  /**
   * Asks first, with a dialog of our own rather than `confirm()`.
   *
   * A native dialog would be the one piece of chrome on this page drawn by the
   * browser rather than the product -- unstyled, unpositioned, and impossible
   * to read past on a page that already owns a modal (`ShareDialog`). It also
   * blocks the event loop, which makes it a hazard for the very harnesses that
   * drive this page.
   *
   * What it warns about is not that the delete is unrecoverable -- it is
   * restorable from here. It is the part that IS immediate and that restoring
   * does not undo: everyone in the room is disconnected the moment it returns.
   */
  const remove = (doc) => setConfirming(doc);

  const confirmRemove = async () => {
    const doc = confirming;
    setConfirming(null);
    if (!doc) return;
    try {
      await deleteDoc(doc.engine, doc.docId);
      // An unowned document is purged rather than binned, so the on-device
      // list has to let go of it too -- otherwise the page restores it from
      // localStorage on the next load and it comes back as a row pointing at
      // nothing.
      if (doc.unowned) { forgetLocalDoc(doc.docId); setLocalDocs(listLocalDocs()); }
      await load();
    } catch (err) { setError(err.message); }
  };

  const restore = async (doc) => {
    try { await undeleteDoc(doc.engine, doc.docId); await load(); }
    catch (err) { setError(err.message); }
  };

  // Searching should find everything, including the unowned pile -- hiding
  // results from an explicit query is how people conclude a document is gone.
  const searching = query.trim().length > 0;

  /**
   * The scopes on offer, with how many each holds right now.
   *
   * The counts are what make one list safe: a scope you are not looking at is
   * invisible, so without them "it is not here" and "it is not anywhere" are
   * the same picture.
   *
   * Empty for a signed-out visitor, which is what hides the selector: the sets
   * it would switch between are "documents you own", "documents shared with
   * you" and "deleted documents", and without an account none of those can
   * contain anything. A control whose every setting but one is empty by
   * definition is not a choice.
   */
  const scopeOptions = useMemo(() => (user
    ? SWITCHABLE.map((id) => ({
      id,
      label: SCOPES[id].label,
      count: SCOPES[id].of(sections).length,
    }))
    : []), [sections, user]);

  // A scope can stop being offered underneath you -- empty the trash while you
  // are looking at it. Signed out there is one list and no way to change it.
  const activeScope = user && scopeOptions.some((o) => o.id === scope) ? scope : 'all';
  const scopeDef = SCOPES[activeScope];

  /*
   * Search reaches every document, whatever the selector says.
   *
   * The selector is for browsing. Making it filter the search as well would
   * mean a query could return nothing while the thing you asked for sat one
   * scope over -- and hiding results from an explicit query is exactly how
   * people conclude a document is gone.
   */
  const listed = searching
    ? [...sections.yours, ...sections.shared, ...sections.device, ...sections.trash]
    : scopeDef.of(sections);

  const subtitle = searching
    ? 'Every document you can reach.'
    // Signed out, the whole list is documents this browser opened without an
    // account. That needs saying once, under the heading, and no more than
    // once: the offer is the point and the caveat fits in the same breath.
    : (!user
        ? 'Create and share without logging in. Anyone with the link can edit, '
          + 'and this list lives in this browser only.'
        : scopeDef.subtitle);

  const emptyText = searching
    ? `Nothing matches \u201c${query.trim()}\u201d.`
    : (!user
        ? 'Nothing yet. Type a name above and create one \u2014 no account needed.'
        : scopeDef.empty);

  // What Enter in the search box would open. Read through a ref so the key
  // handler above does not have to be rebuilt on every keystroke.
  firstMatchRef.current = sections.yours[0] ?? sections.shared[0]
    ?? sections.device[0] ?? null;

  return (
    <div className="docs-page">
      <header className="docs-header">
        <a className="docs-brand" href="/">collab-docs</a>
        <div className="docs-search">
          <input
            type="text"
            placeholder="Search your documents, or name a new one"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            aria-label="Search documents, or type a name to create one"
          />
        </div>
        <AccountBar engine="yjs" user={user} onUser={(u) => { setUser(u); load(); }} />
      </header>

      {error && <p className="docs-error" role="alert">{error}</p>}

      <main className="docs-main">
        <section className="docs-hero wash wash-lime">
          <div>
            <h1>{user ? `Welcome back, ${user.name}` : 'Your documents'}</h1>
            <p>
              Every document here is a CRDT. Edits merge, offline work survives,
              and nothing needs a server to agree on an order.{' '}
              <a href="/lab">Open the lab</a> to watch OT resolve the same
              conflicts differently.
            </p>
          </div>
        </section>


        {/*
          One list, one selector.

          What stood here was five `<Section>` cards stacked down the page.
          Four of them were empty or collapsed on a typical visit, so the page
          read as a column of headings with apologies underneath -- and the one
          you wanted was never the one at the top.
        */}
        <section className="docs-section wash wash-cream">
          <div className="docs-section-head">
            <div className="docs-scope">
              {/*
                The select IS the heading, so there is no second copy of the
                word next to it. The real heading is kept for the document
                outline and for anyone navigating by heading, where a <select>
                is not a landmark.
              */}
              <h2 className="sr-only">
                {searching ? 'Search results' : user ? scopeDef.label : 'Your documents'}
              </h2>

              {searching ? (
                <span className="docs-scope-searching">
                  Results for &ldquo;{query.trim()}&rdquo;
                </span>
              ) : !user ? (
                /*
                  Nothing. Signed out there is one list and no way to change
                  it, so a heading over it only repeats the page it is on --
                  the card holds the controls that DO something (sort, and the
                  button that makes a document) and the line underneath says
                  what the list is.
                */
                null
              ) : (
                <select
                  className="docs-scope-select"
                  aria-label="Which documents to show"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  {scopeOptions.map(({ id, label, count }) => (
                    <option key={id} value={id}>{label} ({count})</option>
                  ))}
                </select>
              )}

              {/* Only while searching. The rest of the time the selected
                  option already carries its own count, and printing it twice
                  a centimetre apart just invites you to check they agree. */}
              {searching && (
                <span className="docs-count">
                  {listed.length} {listed.length === 1 ? 'match' : 'matches'}
                </span>
              )}

              {/*
                Sort sits beside the scope now rather than on a bar of its own
                above the card. They are the two questions you ask of one list
                -- which documents, in what order -- and they belong together.
                Hidden below two rows, where an order cannot differ.
              */}
              {listed.length > 1 && (
                <>
                  <label className="docs-sort-label" htmlFor="docs-sort">Sort</label>
                  <select
                    id="docs-sort"
                    className="docs-sort"
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                  >
                    {Object.entries(SORTS).map(([id, o]) => (
                      <option key={id} value={id}>{o.label}</option>
                    ))}
                  </select>
                </>
              )}
            </div>

            {/*
              Always present, whatever the selector is showing, and always
              offered -- the dialog decides what it can do.

              Import needs Drive, so on a deployment with no Google Cloud
              project this opens a dialog that can only explain itself. Shown
              anyway, because a control that vanishes depending on build-time
              configuration is harder to reason about than one that tells you
              what it is missing.
            */}
            <button
              className="account-btn"
              disabled={creating}
              onClick={() => setImporting(true)}
              title="Import a document. A copy is made; the original is untouched."
            >
              Import
            </button>

            <button className="primary-btn" disabled={creating} onClick={create}>
              {searching ? `Create \u201c${query.trim()}\u201d` : '+ New document'}
            </button>
          </div>

          {subtitle && <p className="docs-subtitle">{subtitle}</p>}

          {listed.length === 0 ? (
            <p className="docs-empty">
              {loading ? 'Loading\u2026' : emptyText}
            </p>
          ) : (
            <ul className="docs-list">
              {listed.map((d) => (
                <DocRow
                  key={`${d.engine}:${d.docId}`}
                  doc={d}
                  caps={d.deletedAt ? null : capsFor(d, localIds)}
                  renaming={renaming?.docId === d.docId && renaming?.engine === d.engine}
                  onRename={setRenaming}
                  onCommitRename={commitRename}
                  onShare={setSharing}
                  onDelete={remove}
                  onRestore={d.deletedAt ? restore : null}
                  // The role is worth a badge everywhere except the one view
                  // where every row has the same one.
                  showRole={scope !== 'yours'}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Content matches. Only while searching, and only when the server
            found something the title filter could not have. A document whose
            TITLE matched is already listed above, and repeating it here would
            make one document look like two results. */}
        {searching && (
          <BodyMatches
            hits={hits.filter((h) => h.matchedIn.includes('body'))}
            loading={searchingBody}
            signedIn={!!user}
          />
        )}
      </main>

      {confirming && (
        <ConfirmDelete
          doc={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={confirmRemove}
        />
      )}

      {importing && (
        <ImportDialog
          engine={ENGINE.id}
          // Only a hint for Google's account chooser. Importing needs no
          // account at all -- an unowned document can be created and filled by
          // anyone (ADR-010).
          userEmail={user?.email}
          onImported={onImported}
          onClose={() => setImporting(false)}
        />
      )}

      {sharing && (
        <ShareDialog
          engine={sharing.engine}
          docId={sharing.docId}
          isOwner={sharing.role === 'owner'}
          unowned={!!sharing.unowned}
          user={user}
          onUser={(u) => { setUser(u); load(); }}
          // Reload rather than patch `sharing` in place: claiming changes the
          // row's role AND which section it belongs to, and the listing is the
          // thing that decides both.
          onClaimed={async () => { await load(); setSharing((s) => s && { ...s, role: 'owner', unowned: false }); }}
          onClose={() => { setSharing(null); load(); }}
        />
      )}
    </div>
  );
}

/**
 * "Are you sure", in the product's own chrome.
 *
 * Built from the same `.modal` the share dialog uses, so there is one modal
 * treatment on the site rather than one plus whatever the browser draws.
 * Escape and a backdrop click both cancel; the destructive button is not
 * focused on open, because a dialog that deletes on an unlucky Enter is worse
 * than no dialog.
 */
function ConfirmDelete({ doc, onCancel, onConfirm }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-label={`Delete ${doc.title || doc.docId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Delete &ldquo;{doc.title || doc.docId}&rdquo;?</h2>
          <button className="icon-btn" onClick={onCancel} title="Cancel">x</button>
        </header>
        {/*
          Two different promises, so two different warnings. An owned document
          goes to a Trash its owner can open; an unowned one has no owner, so
          there is no trash to scope it to and it is gone for good. Saying
          "you can restore it" in that case would be a lie.
        */}
        <p className="history-note">
          {doc.unowned
            ? 'This document has no owner, so there is no Trash to put it in. '
              + 'It is deleted permanently, along with its history, and anyone '
              + 'in it is disconnected immediately.'
            : 'Anyone in the document is disconnected immediately, and that part '
              + 'is not undone by restoring it. The document itself is kept \u2014 '
              + 'you can put it back from Trash, with its history and everyone it '
              + 'was shared with.'}
        </p>
        <div className="modal-actions">
          <button ref={cancelRef} className="link-btn" onClick={onCancel}>Cancel</button>
          <button className="primary-btn danger-btn" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Documents whose TEXT matched, with the matching run shown in place.
 *
 * This is the section that could not exist before ADR-017: everything else on
 * this page is a filter over a listing the browser already had.
 */
function BodyMatches({ hits, loading, signedIn }) {
  if (!signedIn) return null;
  if (!loading && hits.length === 0) return null;
  return (
    <section className="docs-section wash wash-cream">
      <div className="docs-section-head">
        <div>
          <h2>In document text</h2>
          <p className="docs-subtitle">
            Found inside the documents themselves, not in their titles.
          </p>
        </div>
      </div>
      {loading && hits.length === 0 ? (
        <p className="docs-empty">Searching...</p>
      ) : (
        <ul className="docs-list">
          {hits.map((h) => (
            <li className="docs-row docs-row-hit" key={h.docId}>
              <a
                className="docs-name"
                href={h.tabId ? `${docHref(h.docId)}&tab=${encodeURIComponent(h.tabId)}` : docHref(h.docId)}
              >
                {h.title || h.docId}
              </a>
              <Snippet text={h.snippet} />
              <span className="docs-when">{ago(h.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Render a server snippet, highlighting the matched run.
 *
 * The server delimits the match with two control characters rather than with
 * markup, precisely so this function can build elements instead of a renderer
 * having to trust a string assembled from somebody's document. Splitting on
 * them yields alternating plain/matched segments -- odd indices are the
 * matches -- and React escapes every one of them on the way in.
 */
function Snippet({ text }) {
  if (!text) return null;
  const parts = String(text).split(new RegExp(`[${MATCH_START}${MATCH_END}]`));
  return (
    <span className="docs-snippet">
      {parts.map((part, i) => (
        i % 2 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>
      ))}
    </span>
  );
}

/**
 * A page, at thumbnail size, with the document's own opening on it.
 *
 * Not a rendered screenshot -- there is no headless browser here and a
 * server-side render job for a listing would be a large piece of machinery for
 * a small picture. This is the real text, set on a page-shaped white tile and
 * clipped, which is what makes a document recognisable from across a grid: the
 * shape of its first paragraph, whether it is a list or prose, whether it has
 * been started at all.
 *
 * The text comes from the search projection (ADR-017), so no new storage and
 * no new write path -- a second reader of a table that already exists.
 *
 * `aria-hidden`, because it is a picture of the thing the link next to it
 * already names. A screen reader announcing the first 180 characters of every
 * document on the page would be worse than announcing none of them.
 */
function Thumb({ doc }) {
  const text = (doc.preview ?? '').trim();
  return (
    <span className="docs-thumb" aria-hidden="true">
      <span className="docs-page">
        {text
          ? <span className="docs-page-text">{text}</span>
          : <span className="docs-page-blank">Empty</span>}
      </span>
    </span>
  );
}

function DocRow({
  doc, renaming, onRename, onCommitRename, onShare, onDelete, onRestore,
  caps, showRole = true,
}) {
  // `caps` is null for a deleted row, which has exactly one action and takes
  // the branch below before any of this matters.
  const { canRename, canShare, canDelete } = caps ?? {};
  const [menu, setMenu] = useState(false);
  const [draft, setDraft] = useState(doc.title);
  const inputRef = useRef(null);
  const menuBtnRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => { setDraft(doc.title); }, [doc.title]);
  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);

  /*
   * Close on an outside click -- without it, opening one row's menu and then
   * another leaves both on screen -- and on Escape.
   *
   * Escape matters because the menu can be opened from the keyboard, and a
   * menu with no keyboard way out is the one combination that traps somebody.
   * Focus goes back to the button that opened it, since the row it belonged to
   * is otherwise lost.
   */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMenu(false);
      menuBtnRef.current?.focus();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Move into the menu when it opens, so Tab and Escape act on the thing that
  // just appeared rather than on whatever follows it in the document.
  useEffect(() => {
    if (menu) menuRef.current?.querySelector('a, button')?.focus();
  }, [menu]);

  /**
   * A deleted document is not a row with one option greyed out.
   *
   * Its title is not a link, because the socket will refuse the room and the
   * editor would open on an error; Share and Rename are not offered, because
   * the server checks a role that `roleFor` reports as null for anything
   * deleted. The single action it has is the only one that is true of it, so
   * it is a button rather than something to go looking for behind a menu.
   */
  if (doc.deletedAt) {
    return (
      <li className="docs-row docs-row-deleted">
        <Thumb doc={doc} />
        <span className="docs-name docs-name-deleted">{doc.title || doc.docId}</span>
        <div className="docs-foot">
          <span className="docs-when">deleted {ago(doc.deletedAt)}</span>
          <button
            className="link-btn"
            onClick={() => onRestore(doc)}
            aria-label={`Restore ${doc.title || doc.docId}`}
          >
            Restore
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="docs-row">
      {/* The whole tile is the link, so the click target is the page you are
          looking at rather than the few words above it. */}
      <a className="docs-thumb-link" href={docHref(doc.docId)} tabIndex={-1}>
        <Thumb doc={doc} />
      </a>

      {renaming ? (
        <input
          ref={inputRef}
          className="docs-rename"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitRename(doc, draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') { setDraft(doc.title); onRename(null); }
          }}
        />
      ) : (
        <a className="docs-name" href={docHref(doc.docId)}>
          {doc.title || doc.docId}
        </a>
      )}

      <div className="docs-foot">

      {/* No engine badge: with one engine it labels every row identically,
          which is noise rather than information. The lab is where the engine
          is worth naming.

          The role badge goes the same way inside "Your documents". That
          section is `role === 'owner'` by construction, so the badge was on
          every row of it and said nothing -- the same argument, one section
          over. It stays everywhere it can vary. */}
      {showRole && doc.role && doc.role !== 'editor'
        && <span className="badge badge-role">{doc.role}</span>}
      {doc.owner && doc.role !== 'owner' && (
        <span className="docs-owner">by {doc.owner.name}</span>
      )}
      {/* Only past one. Every document has at least one tab, so "1 tab" on
          every row is a column of noise saying nothing (ADR-014). */}
      {doc.tabs > 1 && (
        <span className="docs-tabs" title={`${doc.tabs} tabs`}>{doc.tabs} tabs</span>
      )}
      {doc.online > 0 && (
        <span className="docs-online" title={`${doc.online} connected`}>
          <span className="dot" /> {doc.online}
        </span>
      )}

      <span className="docs-when">{ago(doc.updatedAt)}</span>

      </div>

      <div className="docs-menu-wrap">
        <button
          ref={menuBtnRef}
          className="icon-btn docs-menu-btn"
          aria-label={`Actions for ${doc.title}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
        >
          &#8943;
        </button>
        {menu && (
          <div
            ref={menuRef}
            className="docs-menu"
            role="menu"
            aria-label={`Actions for ${doc.title}`}
            onClick={(e) => e.stopPropagation()}
          >
            <a role="menuitem" href={docHref(doc.docId)}>Open</a>
            {canShare && (
              <button role="menuitem" onClick={() => { setMenu(false); onShare(doc); }}>
                Share
              </button>
            )}
            {canRename && (
              <button role="menuitem" onClick={() => { setMenu(false); onRename(doc); }}>
                Rename
              </button>
            )}
            {canDelete && (
              <button
                role="menuitem"
                className="danger"
                onClick={() => { setMenu(false); onDelete(doc); }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
