import React, { useCallback, useEffect, useRef, useState } from 'react';
import { YjsSync } from '../../sync/yjs-sync.js';
import { OTSync } from '../../sync/ot-sync.js';
import { SimulatedSocket, defaultNetwork } from '../../net/simulated-socket.js';
import { listDocs, getToken, wsBase, DOCUMENT_ENGINE } from '../../api.js';
import { LabClient } from './LabClient.jsx';
import { Timeline } from './Timeline.jsx';
import { ServerView } from './ServerView.jsx';
import { Glossary } from './Glossary.jsx';
import { describeFrame } from './describe-frame.js';
import { SCENARIOS, runScenario } from './scenarios.js';
import { useDisplayFont } from '../use-display-font.js';

/**
 * Replica identities. Eight of them, and the number is the point.
 *
 * Fan-out cost and presence noise only start to look like a problem somewhere
 * past a handful of replicas, so a page that stopped at four could never be
 * pushed to where the interesting behaviour is. Eight real editors in one tab
 * is comfortable; the grid wraps and the panes shrink, which is itself part of
 * what you learn.
 */
const COLORS = [
  '#2dd4bf', '#f472b6', '#fbbf24', '#60a5fa',
  '#a78bfa', '#4ade80', '#fb923c', '#f87171',
];
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'];
const MAX_CLIENTS = NAMES.length;

/**
 * Replicas the page opens with, and the floor it will not go below.
 *
 * One replica is a legitimate thing to sit and look at -- it is just an editor
 * with a network attached -- so removal stops at one rather than two. Anything
 * that genuinely needs a second replica says so itself: the scenarios carry a
 * `needs` count and disable themselves.
 */
const START_CLIENTS = 2;
const MIN_CLIENTS = 1;

/**
 * Rows kept in the ring buffer.
 *
 * Deep enough that the frames you want are still there when you think to look
 * -- a few hundred is under a minute of two replicas typing. Rows are small
 * and never all rendered (the list is filtered), so the cost of a deep buffer
 * is memory nobody notices; the cost of a shallow one is losing the evidence.
 */
const MAX_EVENTS = 5000;

/**
 * The lab: several real clients, one page, and a network you control.
 *
 * Offline behaviour, network simulation and op visualisation all land on this
 * one screen, and it exists only because the transport is hand-written. A
 * SimulatedSocket can be slid underneath `EditorSync` precisely because the
 * socket was never a hidden dependency.
 *
 * The comparison to run: partition two clients, type in both, then heal.
 * Under CRDT they merge. Under OT the reconnecting client is handed the
 * server's document and its own work is discarded -- not a bug, the documented
 * consequence of server authority (ADR-004).
 *
 * The page is laid out as a document rather than as an instrument panel: a
 * title that says what this is, one bar of controls, the replicas, then the
 * two observers at the bottom. A strip of unlabelled buttons above four dense
 * panels reads as a cockpit -- fine if you already know what every switch
 * does, and hostile otherwise.
 */

/**
 * Documents the lab can be pointed at: whatever the signed-in person owns or
 * has been shared, newest first, plus the scratch document the lab invents
 * when nobody has chosen one.
 */
function useOpenableDocs() {
  const [docs, setDocs] = useState([]);
  useEffect(() => {
    let cancelled = false;
    listDocs(DOCUMENT_ENGINE)
      .then((body) => {
        if (cancelled) return;
        // Owned or shared only. The unowned pile is where the lab itself and
        // every test harness leave their scratch documents, and there are
        // hundreds; listing them buries the two you actually wrote.
        setDocs((body.docs ?? []).filter((d) => !d.unowned));
      })
      .catch(() => { /* signed out, or the server is down: no picker, no error */ });
    return () => { cancelled = true; };
  }, []);
  return docs;
}

export function Lab() {
  const params = new URLSearchParams(location.search);
  const engine = params.get('engine') ?? 'yjs';
  // `wsBase` rather than a hostname and a port, for the reason spelled out in
  // api.js: deployed, the two engines are separate services on their own
  // hostnames, so neither the port nor the `ws://` scheme survives -- and a
  // page served over HTTPS cannot open a `ws://` socket at all, which the
  // browser refuses as mixed content before anything leaves it. Development is
  // unchanged: with no `VITE_API_URL_*` set, `wsBase` derives exactly the
  // address this used to build by hand.
  const url = params.get('server') ?? wsBase(engine);

  // The landing page's typeface, because the lab wears the landing page's
  // clothes. The hook is reference counted, so this is not a second request.
  useDisplayFont();

  const [docId, setDocId] = useState(() => params.get('doc') ?? `lab-${Date.now().toString(36)}`);

  // The lab authenticates like any other surface. Without a token it could
  // only ever open unowned documents, which is exactly the set of documents
  // nobody cares about watching converge.
  const token = getToken();
  const openable = useOpenableDocs();
  const chosen = openable.find((d) => d.docId === docId) ?? null;
  const [events, setEvents] = useState([]);
  const [showNoise, setShowNoise] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  // Which replica the page is currently reading. Shared by the timeline (it
  // filters) and the panes (one lights up), because they are two views of the
  // same set of replicas and matching them by colour swatch was guesswork.
  const [focus, setFocus] = useState(null);
  const seq = useRef(0);
  const eventsRef = useRef([]);

  /**
   * Frames arrive far faster than React should re-render (cursor movement
   * alone is ~16/s per client), so they accumulate in a ref and are flushed on
   * an animation frame. Without this the timeline makes the editors stutter,
   * which would be an ironic way to lose a latency demo.
   */
  const flushScheduled = useRef(false);
  const pushEvent = useCallback((clientId, event) => {
    if (event.kind !== 'frame' && event.kind !== 'drop') return;

    const described = describeFrame(event.data, engine);
    const row = {
      seq: seq.current++,
      clientId,
      dir: event.dir,
      bytes: event.bytes,
      dropped: event.kind === 'drop',
      at: event.at,
      ...described,
    };

    const next = eventsRef.current;
    next.unshift(row);
    if (next.length > MAX_EVENTS) next.length = MAX_EVENTS;

    if (!flushScheduled.current) {
      flushScheduled.current = true;
      requestAnimationFrame(() => {
        flushScheduled.current = false;
        setEvents([...eventsRef.current]);
      });
    }
  }, [engine]);

  /**
   * The replicas, as ONE list with a per-replica lifetime.
   *
   * One list, and each replica owns its own lifetime. A fixed pair plus an
   * "extra" array, connected by an effect depending on the combined list,
   * would tear down and reconnect every replica already on the page whenever
   * one was added -- survivable only because everyone resyncs from the server
   * on connect, except for a partitioned replica holding unsynced work, which
   * is precisely the state this page exists to let you build.
   */
  const [replicas, setReplicas] = useState([]);

  // Rebuilt only when the thing being replicated changes. Tearing every
  // replica down and starting clean IS what "new document" means.
  useEffect(() => {
    const built = Array.from({ length: START_CLIENTS }, (_, i) =>
      makeClient({ name: NAMES[i], i, docId, engine, url, token, pushEvent }));
    setReplicas(built);
    return () => { for (const c of built) c.sync.destroy(); };
  }, [docId, engine, url, token, pushEvent]);

  // Connect each replica exactly once, when it first appears.
  const connected = useRef(new WeakSet());
  useEffect(() => {
    for (const c of replicas) {
      if (connected.current.has(c)) continue;
      connected.current.add(c);
      c.sync.connect();
    }
    // The same test hook as `window.__sync` in App.jsx, and here to let a
    // harness assert a NEGATIVE: that no replica on this page has a local
    // store. Every pane is a replica of one document in one browser, so a
    // shared store would let a partitioned pair converge through the disk and
    // the partition demo would keep looking correct while proving nothing.
    window.__labSyncs = replicas.map((c) => c.sync);
  }, [replicas]);

  // Callbacks that only ever want "whoever is here right now" should not be
  // rebuilt every time the list changes.
  const allRef = useRef(replicas);
  allRef.current = replicas;

  /*
   * Both of these build or destroy a replica OUTSIDE the state updater.
   *
   * Constructing a sync opens a socket, and destroying one closes it and fires
   * listeners -- side effects either way. React may invoke an updater more than
   * once and during another component's render, so a `setReplicas(rs => ...)`
   * that did the work inside was making sockets during the render phase and
   * warning about cross-component updates. The updater now only chooses the
   * new array.
   */
  const addReplica = () => {
    const rs = allRef.current;
    if (rs.length >= MAX_CLIENTS) return;
    // First unused identity, not `rs.length` -- remove bob and add, and the
    // index would hand out a second carol while bob's colour sat free.
    const taken = new Set(rs.map((c) => c.name));
    const i = NAMES.findIndex((n) => !taken.has(n));
    if (i === -1) return;

    const born = makeClient({ name: NAMES[i], i, docId, engine, url, token, pushEvent });
    setReplicas((prev) => (prev.length >= MAX_CLIENTS ? prev : [...prev, born]));
  };

  /**
   * Remove a replica, and actually disconnect it.
   *
   * Dropping it from the list alone would leave a live socket sending presence
   * for a pane that no longer exists -- invisible on screen and very visible in
   * the timeline, which would go on listing frames from a replica you had just
   * closed.
   */
  const removeReplica = (id) => {
    const rs = allRef.current;
    if (rs.length <= MIN_CLIENTS) return;
    const going = rs.find((c) => c.id === id);
    if (!going) return;

    going.sync.destroy();
    setReplicas((prev) => prev.filter((c) => c !== going));
    // Its rows stay in the timeline on purpose -- they are still evidence of
    // what happened -- but nothing should remain FILTERED to a replica that is
    // no longer on the page.
    setFocus((f) => (f === id ? null : f));
  };

  /**
   * Dump the run to a JSON file.
   *
   * The timeline is otherwise write-only: it caps, it clears on a new
   * document, and it renders no more than the window can hold, so comparing
   * "what did OT send" against "what did the CRDT send" meant screenshots.
   * Exported runs carry the conditions as well as the frames -- an export
   * without the network settings that produced it cannot be argued with.
   */
  const exportEvents = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      engine,
      docId,
      server: url,
      replicas: allRef.current.map((c) => ({
        id: c.id,
        name: c.name,
        network: { ...c.net },
        chars: c.sync.getText?.().length ?? null,
      })),
      // Oldest first on the way out. The screen wants newest-first; a file you
      // are going to diff or plot wants time to run forwards.
      events: [...eventsRef.current].reverse(),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `lab-${engine}-${docId}-${Date.now().toString(36)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next tick: Safari has not finished reading the blob when
    // click() returns.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }, [engine, docId, url]);

  /**
   * The scripted-run machinery.
   *
   * `running` is the live handle so the run can be cancelled; `step` is what
   * the page narrates. Both are refs-plus-state rather than one or the other
   * because the cancel handler needs the handle synchronously and the bar
   * needs the step to re-render.
   */
  const [step, setStep] = useState(null);
  const runningRef = useRef(null);
  const [runningId, setRunningId] = useState(null);
  const [picked, setPicked] = useState(SCENARIOS[0].id);

  const stopScenario = useCallback(() => {
    runningRef.current?.cancel();
    runningRef.current = null;
    setRunningId(null);
    setStep(null);
  }, []);

  const startScenario = useCallback((scenario) => {
    stopScenario();
    setRunningId(scenario.id);
    // Focus follows the script: the timeline should not be filtered to one
    // replica while a scenario is deliberately exercising several.
    setFocus(null);

    const handle = runScenario(scenario, {
      replica: (i) => allRef.current[i],
      replicas: () => allRef.current,
      setNetwork: (patch, ids) => {
        for (const c of allRef.current) {
          if (!ids || ids.includes(c.id)) { Object.assign(c.net, patch); c.notifyNet(); }
        }
      },
      healAll: () => {
        for (const c of allRef.current) {
          c.net.partitioned = false;
          c.notifyNet();
          c.sync.resync();
        }
      },
      clearEvents: () => { eventsRef.current = []; setEvents([]); },
    }, (s) => {
      setStep(s);
      if (s === null) { runningRef.current = null; setRunningId(null); }
    });

    runningRef.current = handle;
  }, [stopScenario]);

  // A run holds timers and drives editors that are about to be destroyed.
  useEffect(() => stopScenario, [stopScenario]);

  const setAllNetwork = (patch) => {
    for (const c of replicas) { Object.assign(c.net, patch); c.notifyNet(); }
  };

  const healAll = () => {
    for (const c of replicas) {
      c.net.partitioned = false;
      c.notifyNet();
      c.sync.resync();
    }
  };

  const scenario = SCENARIOS.find((s) => s.id === picked) ?? SCENARIOS[0];
  const scenarioShort = replicas.length < (scenario.needs ?? 1);
  const running = !!runningId;

  return (
    <div className="lab">
      {/*
        The title block. A page that opens straight onto eight controls and two
        data panels never says what it IS, and the answer -- several real
        editors of one document on a network you control -- is one sentence.
      */}
      <header className="lab-hero">
        <a className="lab-back" href="/">&larr; collab-docs</a>
        <div className="lab-hero-mid">
          {/*
            The landing page's headline rhythm: a short coloured phrase, then
            the claim, at display weight. "Lab" alone would be the title of the
            route rather than of anything a reader cares about.
          */}
          {/*
            "Watch what survives", not "watch it heal".

            Healing is only half true, and it is the CRDT half: under OT the
            reconnecting replica is handed the server's document and its own
            work is gone (ADR-004). A headline that promises healing would be
            overclaiming on a page whose entire point is that the two engines
            answer this differently -- and "what survives" is the actual
            question you are watching, under either one.
          */}
          <h1 className="lab-title">
            <span className="lab-title-tint">Lab.</span> Cut the wire.
            <br />Watch what survives.
          </h1>
          <p className="lab-lede">
            Several real editors of one document, side by side, on a network you
            control. Slow their connections, cut them off, type into both while
            they are apart &mdash; then reconnect, and see which edits made it.
          </p>
        </div>
      </header>

      {/*
        One bar, grouped by what each group is FOR, with a label on each group.
        In one undifferentiated row, the only way to learn which of "reset
        network" and "new doc" is the destructive one is to press it.
      */}
      <nav className="lab-nav wash wash-cream" aria-label="Lab controls">
        <div className="nav-group nav-doc">
          <span className="nav-label">Document</span>
          <div className="nav-row">
            <h2 className="doc-title" title={docId}>{chosen?.title ?? docId}</h2>
            <select
              className="lab-select"
              aria-label="Document"
              value={openable.some((d) => d.docId === docId) ? docId : ''}
              onChange={(e) => {
                const next = e.target.value;
                location.href = next
                  ? `/lab?doc=${encodeURIComponent(next)}${engine === 'ot' ? '&engine=ot' : ''}`
                  : `/lab${engine === 'ot' ? '?engine=ot' : ''}`;
              }}
            >
              <option value="">scratch document</option>
              {openable.map((d) => (
                <option key={d.docId} value={d.docId}>
                  {d.title || d.docId}
                </option>
              ))}
            </select>
            <a
              className="lab-btn"
              href={`/doc?doc=${encodeURIComponent(docId)}${engine === 'ot' ? '&engine=ot&server=' + url : ''}`}
            >
              open editor &rarr;
            </a>
          </div>
        </div>

        <div className="nav-group">
          <span className="nav-label" title="How concurrent edits are reconciled">
            Merge strategy
          </span>
          <div className="nav-row">
            {/*
              The engine switch, and the only place in the product it exists.
              Documents on the site are CRDT-only (ADR-009) because choosing a
              concurrency-control algorithm is not a decision to put in front of
              someone who wants to write something down. Here it IS the subject.

              It reloads rather than swapping in place. Switching engines mid
              document is a trap with no learning payoff -- the replicas hold
              incompatible state -- and EditorSync says so in as many words.
            */}
            <div className="engine-toggle" role="group" aria-label="Merge strategy">
              {[
                ['yjs', 'CRDT', 'Replicas merge on their own. Both sides of a partition survive.'],
                ['ot', 'OT', 'The server decides. A partitioned replica loses its work on reconnect.'],
              ].map(([id, label, hint]) => (
                <a
                  key={id}
                  className={`engine-opt${engine === id ? ' on' : ''}`}
                  aria-current={engine === id}
                  title={hint}
                  href={id === 'yjs' ? '/lab' : '/lab?engine=ot'}
                >
                  {label}
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="nav-group">
          <span className="nav-label" title="Applies to every replica at once">
            Network &mdash; all replicas
          </span>
          <div className="nav-row">
            <button
              className="lab-btn"
              title="Back to a perfect connection for everyone"
              onClick={() => setAllNetwork({ latencyMs: 0, jitterMs: 0, dropRate: 0, partitioned: false })}
            >
              reset
            </button>
            <button
              className="lab-btn"
              title="400ms delay with 200ms of unevenness, for everyone"
              onClick={() => setAllNetwork({ latencyMs: 400, jitterMs: 200 })}
            >
              slow everyone
            </button>
            <button
              className="lab-btn"
              title="Cut everyone off silently — the connections stay open, nothing crosses"
              onClick={() => setAllNetwork({ partitioned: true })}
            >
              cut all off
            </button>
            <button
              className="lab-btn lab-btn-accent"
              title="Reconnect everyone and force a catch-up"
              onClick={healAll}
            >
              reconnect all
            </button>
          </div>
        </div>

        <div className="nav-group">
          <span className="nav-label">Replicas &middot; {replicas.length}</span>
          <div className="nav-row">
            <button
              className="lab-btn"
              disabled={replicas.length >= MAX_CLIENTS}
              title={replicas.length >= MAX_CLIENTS
                ? `${MAX_CLIENTS} is the most this page will run`
                : 'Open one more editor on the same document'}
              onClick={addReplica}
            >
              + replica
            </button>
            <button
              className="lab-btn lab-btn-quiet"
              title="Throw this document away and start again with two fresh replicas"
              onClick={() => {
                stopScenario();
                eventsRef.current = [];
                setEvents([]);
                setFocus(null);
                setDocId(`lab-${Date.now().toString(36)}`);
              }}
            >
              start over
            </button>
          </div>
        </div>

        {/*
          Scripted runs, as a picker rather than one button per scenario. A
          button each makes this the widest group in the bar and grows it with
          every scenario added, and leaves no room for the description
          underneath -- and a scenario nobody can read is a scenario nobody
          runs.
        */}
        <div className="nav-group nav-scenario">
          <span className="nav-label">Guided run</span>
          <div className="nav-row">
            <select
              className="lab-select"
              aria-label="Guided run"
              value={picked}
              disabled={running}
              onChange={(e) => setPicked(e.target.value)}
            >
              {SCENARIOS.map((sc) => (
                <option key={sc.id} value={sc.id}>{sc.label}</option>
              ))}
            </select>
            {/* Its own class, not `lab-btn-accent`. Two different accent
                buttons in one bar would make "the accent button" ambiguous to
                a reader and to the harness that clicks it alike. */}
            <button
              className={`lab-btn lab-btn-run${running ? ' is-running' : ''}`}
              disabled={!running && scenarioShort}
              title={scenarioShort ? `Needs ${scenario.needs} replicas` : scenario.blurb}
              onClick={() => (running ? stopScenario() : startScenario(scenario))}
            >
              {running ? 'stop' : 'run'}
            </button>
          </div>
        </div>
      </nav>

      {/*
        Narration, and the scenario's own description when nothing is running.
        `aria-live` because the steps are the actual content of a run.
      */}
      <div className={`lab-say${running ? ' lab-say-live' : ''}`} role="status" aria-live="polite">
        {step
          ? <><span className="say-step">{step.index + 1}/{step.total}</span> {step.say}</>
          : running
            ? 'finishing…'
            : scenarioShort
              ? `${scenario.label} needs ${scenario.needs} replicas — add one to run it.`
              : scenario.blurb}
      </div>

      <main className="lab-body">
        {/*
          One document. The panes are replicas OF it, not files beside it, and
          the page has to say so: two panes headed "alice" and "bob" and
          nothing else read as two documents that happen to agree.
        */}
        <div className="panes-head">
          <h2 className="section-title">REPLICAS</h2>
          <span className="lab-subject">
            one document &middot; {replicas.length} independent {replicas.length === 1 ? 'replica' : 'replicas'},
            each with its own connection
          </span>
        </div>

        <div className="panes" data-count={replicas.length}>
          {replicas.map((c) => (
            <LabClient
              key={c.id}
              client={c}
              focused={focus === c.id}
              onFocus={() => setFocus(focus === c.id ? null : c.id)}
              onRemove={replicas.length > MIN_CLIENTS ? () => removeReplica(c.id) : null}
            />
          ))}
        </div>

        {/*
          The two halves of the bottom row are deliberately different KINDS of
          truth. The timeline is what the replicas saw; the server view is what
          the room knows. Side by side, because the whole point of the pairing
          is reading one against the other -- a resync in the timeline means
          very little until you can see the revision it dragged the client to.
        */}
        <div className="lab-bottom">
          <Timeline
            events={events}
            clients={replicas}
            showNoise={showNoise}
            onToggleNoise={() => setShowNoise((v) => !v)}
            onClear={() => { eventsRef.current = []; setEvents([]); }}
            focus={focus}
            onFocus={setFocus}
            onExport={exportEvents}
          />
          <ServerView clients={replicas} engine={engine} />
        </div>

        {/*
          The glossary sits under everything it explains. At the top it would
          be a closed drawer between the reader and the page, something to get
          past before reaching the replicas; at the bottom it is where you go
          when a word above stopped you, which is the order the reading
          actually happens in.
        */}
        <Glossary open={showGlossary} onToggle={() => setShowGlossary((v) => !v)} />
      </main>
    </div>
  );
}

function makeClient({ name, i, docId, engine, url, token, pushEvent }) {
  const id = `${name}-${Math.random().toString(36).slice(2, 6)}`;
  const net = defaultNetwork();
  const color = COLORS[i % COLORS.length];

  /**
   * A one-object store for this replica's network settings.
   *
   * `net` is mutated in place on purpose -- the SimulatedSocket reads it live,
   * so a slider takes effect on the next byte -- which means React cannot see
   * the change. Routing it through component state instead would re-render the
   * entire lab on every drag of a slider: eight editors, the timeline, all of
   * it. Here only the pane that owns the setting hears about it.
   */
  const netListeners = new Set();
  const onNet = (fn) => { netListeners.add(fn); return () => netListeners.delete(fn); };
  const notifyNet = () => { for (const fn of netListeners) fn(); };

  // The seam again: the sync class is handed a socket factory and never learns
  // that its network is a lie.
  const socketFactory = (u) => new SimulatedSocket(u, {
    config: net,
    onEvent: (event) => pushEvent(id, event),
  });

  // `clientId` is a REPLICA label, not a person. When the lab is signed in,
  // every pane authenticates as the same account and the server sub-divides it
  // per connection -- see the note on presence identity in server.js.
  const opts = { url, docId, clientId: id, socketFactory, token };
  const sync = engine === 'ot' ? new OTSync(opts) : new YjsSync(opts);
  sync.setLocalUser({ name, color });

  // Handed to the pane's <Editor>, which fills it in. Scenarios type through
  // this view rather than calling into the sync layer, so a scripted run takes
  // exactly the path a person's keystrokes take.
  const viewRef = { current: null };

  return { id, name, color, net, sync, viewRef, onNet, notifyNet };
}
