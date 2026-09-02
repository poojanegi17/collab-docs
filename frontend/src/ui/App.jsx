import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '@codemirror/view';
import { YjsSync } from '../sync/yjs-sync.js';
import { OTSync } from '../sync/ot-sync.js';
import { Editor } from './Editor.jsx';
import { Header } from './Header.jsx';
import { Inspector } from './Inspector.jsx';
import { Toolbar } from './Toolbar.jsx';
import { HistoryPane } from './history/HistoryPane.jsx';
import { CommentsPane } from './comments/CommentsPane.jsx';
import { TabIndex } from './tabs/TabIndex.jsx';
import { useTabs } from './tabs/use-tabs.js';
import { TasksPane } from './tasks/TasksPane.jsx';
import { useTasks } from './tasks/use-tasks.js';
import { StatusBar } from './StatusBar.jsx';
import { toMarkdown, describeLoss, downloadMarkdown, filenameFor } from './export-markdown.js';
import { useComments } from './comments/use-comments.js';
import { ShareDialog } from './share/ShareDialog.jsx';
import { AccountBar } from './account/Account.jsx';
import { getToken, wsBase, renameDoc, getAuthorship } from '../api.js';
import { authorLegend } from './authorship.js';
import { forgetLocalDoc, rememberLocalDoc } from '../local-docs.js';
import { useDisplayFont } from './use-display-font.js';
import { GUEST_PREFIX, GUEST_RE, guestName } from './identity.js';

const COLORS = ['#f87171', '#34d399', '#60a5fa', '#fbbf24', '#c084fc', '#2dd4bf', '#f472b6'];



/**
 * This guest's ordinal: the one it already has if that is still free, else the
 * lowest nobody in the room is using.
 *
 * Deliberately derived from presence rather than from the client id. A hash
 * gives every guest a number without looking, and two guests hashing to the
 * same one is precisely the collision the FNV note below was written about.
 * Reading the room costs one pass over the peer map and cannot collide with
 * anyone already here.
 *
 * FIRST COME KEEPS ITS NUMBER. A guest's comments and authorship runs are
 * labelled with this name, so a number that moved under its holder would hand
 * their work to somebody else. An established "Unknown 1" keeps its number
 * when a peer with a smaller random id arrives; the newcomer takes a free
 * one instead.
 *
 * `peers` never contains this client, so a number in `taken` is always
 * somebody else's. Two guests arriving in the same instant can still both see
 * an empty room and both pick 1; the id comparison settles that one case
 * without negotiation, and only that one -- whoever sorts higher moves on.
 * Both sides compute the same answer from the same presence map, so it
 * converges on the next frame rather than oscillating.
 */
function guestOrdinalFor(peers, self, current) {
  const taken = new Map();
  for (const [id, p] of peers) {
    const m = GUEST_RE.exec(p?.user?.name ?? '');
    if (m) taken.set(Number(m[1]), { id, since: p?.user?.since ?? 0 });
  }

  if (current !== null) {
    const rival = taken.get(current);
    // Uncontested: keep it. This is the ordinary case on every presence update
    // after the first, and it is what makes the name stable.
    if (rival === undefined) return current;
    // Contested. Whoever was in the room first keeps the number.
    //
    // `since` is stamped once when the tab connects and travels in presence,
    // so the comparison is about arrival rather than the roll of a random
    // client id. The id is the final tie-break, because two tabs CAN stamp the
    // same millisecond and something has to be decidable; both sides evaluate
    // the same expression over the same presence map, so exactly one of them
    // stands down.
    if (self.since < rival.since) return current;
    if (self.since === rival.since && self.id < rival.id) return current;
  }

  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/** How often to ask the server for its own view of this document. */
const DEBUG_POLL_MS = 1000;

/**
 * FNV-1a, for picking a colour out of a client id.
 *
 * A cheap hash over short strings collides absurdly easily -- `sum of char
 * codes % 7` puts "alice" and "bob" on the same colour -- and two tabs that
 * look identical are worse than no identity at all: you cannot tell whose
 * cursor you are looking at, or which tab you are typing in.
 */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Everything session-scoped comes off the URL, so opening N tabs is the demo. */
function sessionConfig() {
  const params = new URLSearchParams(location.search);
  const explicitClient = params.get('client');
  const clientId = explicitClient ?? Math.random().toString(36).slice(2, 8);
  const h = hash(clientId);

  /**
   * A tab's content lives under `<document>~<tab>` (ADR-014), so a link to a
   * tab can be pasted into either parameter and still work. `?doc=` naming a
   * tab is what a copied address bar produces before `?tab=` is written to it,
   * and refusing that link would make sharing "the tab I am looking at" a
   * thing that silently opens something else.
   */
  const asked = params.get('doc') ?? 'demo';
  const at = asked.indexOf('~');
  const docId = at > 0 ? asked.slice(0, at) : asked;
  const tabId = params.get('tab') ?? (at > 0 ? asked : docId);

  return {
    docId,
    tabId,
    engine: params.get('engine') ?? 'yjs',
    clientId,
    user: {
      // If you named the tab, that name is what you expect to see: `?name=`
      // and `?client=` win, and are what the lab and every harness use. With
      // nothing to go on this is a guest, and `null` says so rather than
      // inventing a person -- the ordinal is filled in from presence once the
      // room is visible.
      name: params.get('name')
        ?? (explicitClient
          ? explicitClient.charAt(0).toUpperCase() + explicitClient.slice(1)
          : null),
      color: params.get('color') ?? COLORS[(h >>> 8) % COLORS.length],
    },
    url: params.get('server') ?? wsBase(params.get('engine') ?? 'yjs'),
    // Identity comes from the session when there is one. `?client=` is what
    // the lab and the harnesses use, but on a document with an owner the
    // server ignores it -- see server.js.
    token: getToken(),
  };
}

export function App() {
  useDisplayFont();
  const cfg = useMemo(sessionConfig, []);

  // The seam. This is the ONLY place in the UI that names an engine -- the
  // editor, the inspector and presence all talk to the EditorSync interface.
  //
  // `?engine=ot` is honoured here even though nothing in the product offers
  // it. Documents on the site are CRDT-only (ADR-009), but the OT engine is
  // fully implemented and has to stay reachable through a real editor: the lab
  // mounts it, and tools/browser-test.mjs --engine=ot drives this very route.
  // Without the branch, half the project has no way to be tested.
  /**
   * Which tab is open, and therefore which document the socket is connected to.
   *
   * This is the whole cost of ADR-014 on the client: a tab is a document, so
   * switching one tears down a connection and builds another. The alternative
   * -- several live sockets, one per tab -- would keep every tab in a document
   * loaded, syncing and counted in presence for as long as it stayed open,
   * which is a person appearing to read five things at once and paying for it
   * in bandwidth on all five.
   */
  const [activeTabId, setActiveTabId] = useState(cfg.tabId);

  const sync = useMemo(() => {
    // `activeTabId`, not `cfg.docId`: the socket is opened against the TAB's
    // id, because that is where its content lives. Everything about the
    // document -- title, sharing, tasks -- still keys off `cfg.docId`.
    const opts = { url: cfg.url, docId: activeTabId, clientId: cfg.clientId, token: cfg.token };
    switch (cfg.engine) {
      // `persist` is asked for HERE and nowhere else. This is the one surface
      // where somebody is writing something they expect to still have after a
      // reload. The lab must NOT have it: its replicas share a browser, so a
      // local store would let a partitioned pair converge through the disk.
      // See the field's own comment in yjs-sync.js.
      case 'yjs': return new YjsSync({ ...opts, persist: true });
      case 'ot': return new OTSync(opts);
      default: throw new Error(`unknown engine: ${cfg.engine}`);
    }
  }, [cfg, activeTabId]);

  const [status, setStatus] = useState('connecting');
  const [peers, setPeers] = useState(new Map());
  /**
   * This tab's guest ordinal, when there is no name to use instead.
   *
   * `null` until presence has been seen once, so the very first paint says
   * "Unknown" rather than flashing a number it is about to correct.
   */
  const [guestOrdinal, setGuestOrdinal] = useState(null);
  /** When this tab arrived. Fixed for its lifetime; see `guestOrdinalFor`. */
  const [joinedAt] = useState(() => Date.now());

  const [stats, setStats] = useState(sync.stats);
  const [ot, setOt] = useState(null);
  const [server, setServer] = useState(null);
  /**
   * The inspector is a debug view, and on a narrow screen it is an overlay --
   * so opening it by default means a phone loads the app with the document
   * completely hidden behind a table of byte counts. It stays open by default
   * where it costs a column and shows the thing the project is about, and
   * closed where it would cost the document.
   */
  const [inspectorOpen, setInspectorOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 900);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [authorshipOn, setAuthorshipOn] = useState(false);
  const [authorship, setAuthorship] = useState(null);

  /**
   * Fetch authorship while the layer is on, and keep it roughly fresh.
   *
   * Keyed on `activeTabId`, not `cfg.docId`: authorship is a fact about a
   * content log, and a tab is its own log (ADR-014). Asking about the document
   * id while reading tab three would tint tab three with tab one's authors.
   *
   * Refreshed off `rich`, which the sync layer emits for remote edits as well
   * as local ones, debounced at 1.5s. Not polled: a document nobody is editing
   * needs no refresh at all, and a document three people are editing needs one
   * per burst rather than one per second.
   */
  useEffect(() => {
    if (!authorshipOn) { setAuthorship(null); return; }
    let cancelled = false;
    let timer = null;

    const fetchNow = async () => {
      try {
        const body = await getAuthorship(cfg.engine, activeTabId);
        if (!cancelled) setAuthorship(body.supported ? body : { unsupported: true, runs: [] });
      } catch {
        // Leave whatever is on screen. A failed refresh should show slightly
        // stale authorship, not suddenly claim nobody wrote anything.
      }
    };

    fetchNow();
    const off = sync.on('rich', () => {
      clearTimeout(timer);
      timer = setTimeout(fetchNow, 1500);
    });
    return () => { cancelled = true; clearTimeout(timer); off(); };
  }, [authorshipOn, sync, cfg.engine, activeTabId]);
  /**
   * A selection captured at the moment Comment was pressed, held until the
   * note is written.
   *
   * Captured rather than re-read on submit, because by then the caret has been
   * in a textarea and CodeMirror's selection is whatever it was left at. The
   * range has to be the one the user was looking at when they asked.
   */
  const [pendingComment, setPendingComment] = useState(null);

  /**
   * What the server said about this document when we joined: our role, its
   * title, and who it thinks we are.
   *
   * It arrives in HELLO rather than being fetched over HTTP because the socket
   * has already done the access check -- asking again would be a second,
   * racier answer to a question already settled.
   */
  const [session, setSession] = useState({
    role: 'editor', title: cfg.docId, user: null, unowned: true,
  });
  /**
   * Who this tab is, after the account, the URL and the guest fallback have
   * all had their say. One object, so the header, the avatar row and presence
   * cannot disagree about it.
   */
  const me = useMemo(() => {
    const signedIn = session.user;
    const name = signedIn?.name
      ?? cfg.user.name
      ?? (guestOrdinal === null ? GUEST_PREFIX : guestName(guestOrdinal));
    return {
      ...cfg.user,
      name,
      color: signedIn?.color ?? cfg.user.color,
      clientId: cfg.clientId,
      // Drives the "not signed in" styling. A guest is not a person with a
      // greyer avatar; it is an editor the document cannot name.
      guest: !signedIn && !cfg.user.name,
    };
  }, [session.user, cfg.user, cfg.clientId, guestOrdinal]);
  const [refused, setRefused] = useState(null);

  /**
   * Shared handle on the CodeMirror view, so the toolbar can read the caret's
   * formatting and apply changes to the selection.
   *
   * `editorVersion` is a deliberate re-render trigger, not state anybody
   * reads: the formatting under the caret lives in CodeMirror, which React
   * cannot observe. The editor bumps this on every selection or document
   * change and the toolbar re-reads. Mirroring the formatting into React state
   * instead would create a second copy of the document's truth, which is the
   * one thing the design is careful not to do.
   */
  const viewRef = useRef(null);
  // Ctrl+K is bound in the editor, but the URL field belongs to the toolbar.
  // The ref is the handshake between them -- see Toolbar.jsx.
  const linkRequestRef = useRef(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const bumpEditor = useCallback(() => setEditorVersion((v) => v + 1), []);

  /**
   * The document, for the index panel's outline.
   *
   * Taken from the `rich` event rather than from `editorVersion`, and the
   * difference is the point: `editorVersion` also bumps when the CARET moves,
   * and re-deriving every heading in the document because somebody pressed
   * an arrow key is work with no possible result. Rebuilding it on a real
   * change is the same cost `marks.js` already pays to redraw decorations.
   */
  const [docRich, setDocRich] = useState(() => sync.getRichText());
  useEffect(() => {
    setDocRich(sync.getRichText());
    const off = [
      sync.on('rich', (rich) => setDocRich(rich)),
      // A tab that was still syncing when this mounted has its content now.
      sync.on('synced', () => setDocRich(sync.getRichText())),
    ];
    return () => off.forEach((fn) => fn());
  }, [sync]);

  /** Where the caret is, so the index can say which section you are in. */
  const caret = useMemo(
    () => viewRef.current?.state.selection.main.head ?? null,
    [editorVersion]);

  /**
   * Jump to an offset, from the index.
   *
   * Moves the caret as well as the scroll position: arriving at a heading and
   * then typing should put the text there, not back where you were reading.
   */
  const goToOffset = useCallback((from) => {
    const view = viewRef.current;
    if (!view) return;
    const at = Math.max(0, Math.min(from, view.state.doc.length));
    view.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: 'start', yMargin: 24 }),
    });
    view.focus();
  }, []);

  /**
   * Number this guest, and keep the number honest as the room changes.
   *
   * Runs on every presence update rather than once on connect, because the
   * room this tab joined is not the room it stays in: a guest who arrives
   * second and later outlives the first should not keep a number that now
   * collides with somebody who joined after them.
   *
   * `guestOrdinalFor` keeps the number this tab already holds whenever it is
   * uncontested, so joining a room never renames the people already in it.
   */
  useEffect(() => {
    if (!me.guest) return;
    const want = guestOrdinalFor(peers, { id: cfg.clientId, since: joinedAt }, guestOrdinal);
    if (want !== guestOrdinal) setGuestOrdinal(want);
  }, [peers, me.guest, cfg.clientId, guestOrdinal]);

  /*
   * Publish it. Presence is how every OTHER tab learns what to call this one
   * -- the cursor label, the avatar row and the peer list all read the name
   * off awareness -- so a number decided locally and never sent would leave
   * this tab as "Unknown" to everyone but itself.
   */
  useEffect(() => {
    if (!me.guest || guestOrdinal === null) return;
    // `since` travels with the name so other tabs can settle a clash the same
    // way this one does. It is a tie-break, not a clock: nothing is displayed
    // from it and nothing depends on the two machines agreeing about the time.
    sync.setLocalUser({ name: me.name, color: me.color, since: joinedAt });
  }, [sync, me.guest, me.name, me.color, guestOrdinal, joinedAt]);

  /**
   * What the USER asked for, which is not the same as the socket's status.
   *
   * The toggle must never branch on `status`: it cycles through connecting /
   * connected / synced / reconnecting on its own, and a click landing on
   * "reconnecting" would be read as "go offline" -- killing the backoff timer
   * and stranding the tab offline until a reload.
   */
  const [wantOnline, setWantOnline] = useState(true);

  useEffect(() => {
    const off = [
      sync.on('status', setStatus),
      sync.on('peers', (p) => setPeers(new Map(p))),
      sync.on('doc', (s) => setStats({ ...s })),
      sync.on('synced', (s) => setStats({ ...s })),
      sync.on('ot', setOt),
      sync.on('debug', setServer),
      sync.on('hello', (hello) => {
        setSession({
          role: hello.role ?? 'editor',
          title: hello.title ?? hello.docId,
          user: hello.user ?? null,
          unowned: hello.unowned ?? false,
        });
        // The on-this-device list is maintained by the effect below, which
        // has to re-decide as the title and the text change. Deciding here as
        // well, from a snapshot taken at connect, would record documents the
        // server goes on to discard.
        // Presence identity follows the ACCOUNT once there is one. Without it
        // the header and everyone else's cursor label fall back to the guest
        // ordinal, so signing in has to push the real name out to the room --
        // otherwise your collaborators carry on watching "Unknown 2" type.
        if (hello.user) {
          sync.setLocalUser({ name: hello.user.name, color: hello.user.color });
        }
      }),
      // 1008 is the server refusing access. Retrying would be pointless and
      // the status pill would just cycle "reconnecting" forever, which reads
      // as a broken app rather than a permissions answer.
      sync.on('refused', (reason) => { setRefused(reason); }),
    ];
    /**
     * A handle on the sync client, for the harnesses.
     *
     * It exists to let `tools/browser-test.mjs` push an attribute value the
     * toolbar would never produce -- a `javascript:` link -- and assert that
     * the RENDERER refuses it. That check is worth having a hook for: a
     * sanitiser on the input path alone is not a defence, because the input
     * path is the one thing an attacker does not have to use.
     *
     * It grants nothing. Everything here is already reachable from the console
     * on a page you are running, and a hostile client is a patched client, not
     * a global variable. The defence is at the render boundary (marks.js),
     * which is where it has to be.
     */
    window.__sync = sync;

    /*
     * The identity known at connect time, which for a guest is a colour and no
     * name -- the ordinal cannot be picked before the room has been seen. The
     * effect above publishes the numbered name the moment presence arrives, so
     * this is the placeholder that exists for the milliseconds in between.
     * Sending the config's raw `null` would leave a peer briefly labelled
     * "undefined", so `GUEST_PREFIX` alone stands in.
     */
    sync.setLocalUser({ ...cfg.user, name: cfg.user.name ?? GUEST_PREFIX });
    sync.connect();
    return () => { off.forEach((fn) => fn()); sync.destroy(); };
  }, [sync, cfg]);

  // Poll the server's own view of the document. Only while the inspector is
  // open -- there is no reason to generate traffic nobody is looking at.
  useEffect(() => {
    if (!inspectorOpen) return;
    const tick = () => sync.requestDebug();
    tick();
    const id = setInterval(tick, DEBUG_POLL_MS);
    return () => clearInterval(id);
  }, [sync, inspectorOpen, status]);

  /**
   * Signing in or out without leaving the document.
   *
   * The token rides on the socket url, so identity is fixed for the life of a
   * connection -- `setToken` replaces the socket, and the server's HELLO is
   * what actually decides who we are. Setting `session.user` here as well is
   * optimism for the ~100ms in between, so the dialog can offer Claim
   * immediately instead of flickering back to the sign-in form.
   */
  const comments = useComments({
    sync,
    engine: cfg.engine,
    // A comment anchors into text, and the text of this tab is a document of
    // its own -- so comments are per tab, by construction rather than by a
    // rule anybody had to write down (ADR-014).
    docId: activeTabId,
    user: session.user,
    // `me`, not `cfg.user`: the raw config carries `name: null` for a guest,
    // and the ordinal that makes it "Unknown 2" is only decided once presence
    // has been seen. Passing the config here would post comments with no
    // author name at all.
    localUser: me,
    canEdit: session.role !== 'viewer',
  });

  const tabs = useTabs({
    sync,
    engine: cfg.engine,
    // The DOCUMENT id. The tab list is a fact about the document, and asking
    // for it from inside tab three must give the same answer as from tab one.
    docId: cfg.docId,
    canEdit: session.role !== 'viewer',
    activeId: activeTabId,
    onActivate: setActiveTabId,
  });

  const tasks = useTasks({
    sync,
    engine: cfg.engine,
    // Also the document id: one checklist, visible from every tab (ADR-015).
    docId: cfg.docId,
    user: session.user,
    localUser: me,
    canEdit: session.role !== 'viewer',
  });

  /**
   * Start a thread on whatever is selected.
   *
   * Refuses an empty selection rather than commenting on a caret: a zero-width
   * anchor has no text to survive, so it would be orphaned by the next
   * keystroke that touched it.
   */
  const startComment = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (to <= from) return;
    setPendingComment({ from, to, quote: view.state.doc.sliceString(from, to) });
    setCommentsOpen(true);
  }, []);

  const submitComment = useCallback(async (body) => {
    if (!pendingComment) return;
    await comments.addThread({ ...pendingComment, body });
    setPendingComment(null);
  }, [comments, pendingComment]);

  // Opening a thread from the sidebar scrolls the editor to it. Without this a
  // comment on something off-screen selects a highlight nobody can see.
  const selectThread = useCallback((id) => {
    comments.setActiveId(id);
    setCommentsOpen(true);
    const thread = comments.threads.find((t) => t.id === id);
    const view = viewRef.current;
    if (thread?.range && view) {
      view.dispatch({ effects: EditorView.scrollIntoView(thread.range.from, { y: 'center' }) });
    }
  }, [comments]);

  /**
   * Export the document as Markdown.
   *
   * Reads the RichText from the sync layer, not the DOM. The DOM has been
   * through the decoration layer and does not carry attributes any more -- and
   * more to the point, exporting what is currently RENDERED would silently
   * export a partly-synced document.
   */
  const [exportNote, setExportNote] = useState(null);
  const onExport = useCallback(() => {
    const rich = sync.getRichText();
    // Export exports the TAB you are looking at, because that is the document
    // the sync layer holds -- so its name has to say which one, or three tabs
    // produce three files with one name and the last two look like duplicates.
    const tabTitle = tabs.tabs.length > 1 ? tabs.active?.title : null;
    const name = tabTitle ? `${session.title} - ${tabTitle}` : session.title;
    const markdown = toMarkdown(rich, { title: name });
    downloadMarkdown(markdown, filenameFor(name, activeTabId));

    // Say what Markdown could not carry, rather than letting someone discover
    // it in the file. Nothing to say is the common case and stays silent.
    const lost = describeLoss(rich);
    setExportNote(lost.length
      ? `Exported. Markdown cannot carry ${lost.join(', ')} — that formatting was dropped.`
      : null);
  }, [sync, session.title, activeTabId, tabs.tabs.length, tabs.active]);

  /**
   * Keep the on-this-device list holding exactly what the server keeps.
   *
   * That list exists because nothing else can find an unowned document: the
   * server has nobody to file it under, so a guest who closes the tab has no
   * way back to it (see local-docs.js). It only helps if it is accurate, and
   * the server DISCARDS an unowned document that was never named and never
   * written in -- so an entry recorded at connect, before either was true,
   * would point at nothing.
   *
   * The same three conditions as `Room.discardIfAbandoned`, deliberately: two
   * places deciding what is worth keeping have to agree, and the day they
   * disagree this list starts showing documents that are not there.
   */
  /*
   * `keep` is a BOOLEAN, and the effect depends on it rather than on the
   * document length it is derived from. Depending on the length directly runs
   * this on every keystroke, serialising the list and writing it to
   * localStorage for every character typed -- real work on the typing path,
   * for an answer that only changes when a document goes from empty to
   * non-empty, which happens once.
   */
  const keepLocally = session.unowned && (() => {
    const title = (session.title ?? '').trim();
    const named = title && title !== 'Untitled' && title !== cfg.docId;
    return !!(named || (stats.docLength ?? 0) > 0);
  })();

  useEffect(() => {
    if (keepLocally) rememberLocalDoc({ docId: cfg.docId, title: session.title });
    else forgetLocalDoc(cfg.docId);
    // `session.title` IS a trigger, and safely so: the header keeps its own
    // draft and only commits on blur or Enter, so this fires once per rename
    // rather than once per character. That keeps the stored name current --
    // it is the only name the list has for a document the server has stopped
    // returning.
  }, [keepLocally, session.title, cfg.docId]);

  useEffect(() => {
    if (!exportNote) return undefined;
    const id = setTimeout(() => setExportNote(null), 6000);
    return () => clearTimeout(id);
  }, [exportNote]);

  /**
   * What an import could not carry, left here by the documents page (ADR-021).
   *
   * The same note the exporter uses, for the symmetric reason: `describeLoss`
   * says what Markdown could not express on the way out, and
   * `describeImportLoss` says what this vocabulary could not express on the
   * way in. Somebody who has just imported a document with three tables in it
   * should be told the tables are now paragraphs before they notice on their
   * own and conclude the importer is broken.
   *
   * Read once and removed, so a reload does not replay it -- it is news about
   * an event, not a property of the document.
   */
  useEffect(() => {
    const key = `import-loss:${cfg.docId}`;
    let note = null;
    try {
      note = sessionStorage.getItem(key);
      if (note) sessionStorage.removeItem(key);
    } catch { /* private mode: there was never anything to read */ }
    if (note) setExportNote(note);
  }, [cfg.docId]);

  const onAccountChange = useCallback((u) => {
    setSession((v) => ({ ...v, user: u }));
    setRefused(null);
    sync.setToken(getToken());
  }, [sync]);

  return (
    <div className="app">
      {/* The page's subject, for anyone navigating by heading. It cannot be a
          visible element: the title is an <input> when you are allowed to
          rename, and an input is not a heading whatever it contains. */}
      <h1 className="sr-only">{session.title ?? cfg.docId}</h1>

      {/* Authorship, fetched only while the layer is on.
          Refreshed off the sync layer's `rich` event -- which fires for
          remote edits as well as local ones -- rather than polled, and
          debounced because the server's own index of who wrote what is
          updated as edits are sequenced, not per keystroke. */}
      <Header
        docId={cfg.docId}
        title={session.title}
        role={session.role}
        onRename={async (next) => {
          await renameDoc(cfg.engine, cfg.docId, next);
          setSession((v) => ({ ...v, title: next }));
        }}
        onShare={() => setShareOpen(true)}
        unowned={session.unowned}
        account={
          <AccountBar engine="yjs" user={session.user} onUser={onAccountChange} />
        }
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        commentsOpen={commentsOpen}
        commentCount={comments.threads.filter((t) => !t.resolved).length}
        onToggleComments={() => setCommentsOpen((v) => !v)}
        authorshipOn={authorshipOn}
        onToggleAuthorship={() => setAuthorshipOn((v) => !v)}
        tasksOpen={tasksOpen}
        taskCount={tasks.openCount}
        onToggleTasks={() => setTasksOpen((v) => !v)}
        onExport={onExport}
        engine={cfg.engine}
        user={me}
        peers={peers}
        status={status}
        wantOnline={wantOnline}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
        onToggleConnection={() => {
          setWantOnline((online) => {
            if (online) sync.disconnect();
            else sync.connect();
            return !online;
          });
        }}
      />

      <div className="body">
        {/* The index: tabs, and the open tab's headings. A column of its own on
            the left rather than a strip above the document, because it is a
            place you navigate FROM and it has to stay put while you read. */}
        <TabIndex
          tabs={tabs.tabs}
          activeId={activeTabId}
          canEdit={session.role !== 'viewer'}
          error={tabs.error}
          onSelect={setActiveTabId}
          onAdd={tabs.add}
          onRename={tabs.rename}
          onMove={tabs.move}
          onDelete={tabs.remove}
          rich={docRich}
          caret={caret}
          onGoTo={goToOffset}
        />
        <main className="editor-pane">
          {session.role !== 'viewer' && (
            <Toolbar sync={sync} viewRef={viewRef} version={editorVersion}
              linkRequestRef={linkRequestRef} onComment={startComment} />
          )}
          {session.role === 'viewer' && (
            <div className="readonly-bar">
              You have view-only access. The server rejects edits from this
              connection, so the editor is read-only rather than pretending.
            </div>
          )}
          <Editor
            sync={sync}
            peers={peers}
            viewRef={viewRef}
            onStateChange={bumpEditor}
            linkRequestRef={linkRequestRef}
            readOnly={session.role === 'viewer'}
            commentRanges={comments.commentRanges}
            activeThreadId={comments.activeId}
            onSelectThread={selectThread}
            authorship={authorshipOn ? authorship : null}
          />
          {authorshipOn && <AuthorLegend payload={authorship} />}
        </main>
        {commentsOpen && (
          <CommentsPane
            threads={comments.threads}
            activeId={comments.activeId}
            error={comments.error}
            canEdit={session.role !== 'viewer'}
            currentUserId={session.user?.id ?? null}
            onSelect={selectThread}
            onReply={comments.reply}
            onResolve={comments.resolve}
            onDelete={comments.remove}
            onDeleteComment={comments.removeComment}
            pending={pendingComment}
            onCancelPending={() => setPendingComment(null)}
            onSubmitPending={submitComment}
            onClose={() => setCommentsOpen(false)}
          />
        )}
        {tasksOpen && (
          <TasksPane
            open={tasks.open}
            done={tasks.done}
            error={tasks.error}
            canEdit={session.role !== 'viewer'}
            onAdd={tasks.add}
            onToggle={tasks.setDone}
            onEdit={tasks.edit}
            onDelete={tasks.remove}
            onClose={() => setTasksOpen(false)}
          />
        )}
        {historyOpen && (
          <HistoryPane
            engine={cfg.engine}
            /* A tab's history is the history of its own update log, which is
               the tab's, not the document's (ADR-014). */
            docId={activeTabId}
            canEdit={session.role !== 'viewer'}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        <Inspector
          open={inspectorOpen}
          engine={cfg.engine}
          status={status}
          stats={stats}
          peers={peers}
          ot={ot}
          server={server}
        />
      </div>

      {/*
        Outside `.body`, and outside the editor column.

        As a child of `<main>` it would span only the document, while every
        side pane -- a SIBLING of main, full height -- carried on past it to
        the bottom of the window: a bar that looked like it belonged to the
        document, beside panes that looked like they belonged to the window,
        the two disagreeing about where the app ends.

        It is a window-level bar in every editor that has one, so it is a row
        of the `.app` grid. That also settles the mobile case for free:
        the panes there are absolutely positioned inside `.body` with
        `bottom: 0`, so anything inside `.body` is something they cover.
      */}
      <StatusBar
        sync={sync}
        viewRef={viewRef}
        version={editorVersion}
      />

      {shareOpen && (
        <ShareDialog
          engine={cfg.engine}
          docId={cfg.docId}
          isOwner={session.role === 'owner'}
          unowned={session.unowned}
          user={session.user}
          onUser={onAccountChange}
          onClaimed={(doc) => {
            // The server has already told the room; this connection will get a
            // HELLO saying `owner`. Setting it here too means the share form
            // appears on the click rather than on the round trip.
            setSession((v) => ({ ...v, role: 'owner', unowned: false, title: doc?.title ?? v.title }));
            forgetLocalDoc(cfg.docId);
          }}
          onClose={() => setShareOpen(false)}
        />
      )}

      {exportNote && (
        <div className="toast-note" role="status">{exportNote}</div>
      )}

      {refused && (
        <div className="modal-backdrop">
          <div className="modal" role="alertdialog">
            <header className="modal-head"><span>No access</span></header>
            <p className="history-note">{refused}</p>
            <div className="account-actions">
              <a className="primary-btn" href="/">Back to your documents</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Who has written any of this document, and roughly how much.
 *
 * Under the tinted text rather than in a side pane, because it is a key to
 * something already on screen and a key that needs scrolling to is not a key.
 *
 * The unsupported case is stated rather than left blank. An engine that cannot
 * attribute and a document nobody has written are the same empty legend, and
 * they are entirely different facts.
 */
function AuthorLegend({ payload }) {
  if (payload?.unsupported) {
    return (
      <div className="author-legend" role="status">
        <span className="author-legend-note">
          This engine cannot say who wrote what. See ADR-018.
        </span>
      </div>
    );
  }

  const authors = authorLegend(payload);
  if (!authors.length) return null;
  const total = authors.reduce((n, a) => n + a.chars, 0);

  return (
    <div className="author-legend">
      <span className="author-legend-label">Written by</span>
      {authors.map((a) => (
        <span className="author-chip" key={a.author}>
          {/* The swatch is decorative -- the name beside it carries the
              same information, so it is hidden from assistive technology
              rather than announced as an unlabelled image. */}
          <span className="author-swatch" style={{ background: a.color }} aria-hidden="true" />
          {a.name}
          <span className="author-share">{Math.round((a.chars / total) * 100)}%</span>
        </span>
      ))}
    </div>
  );
}
