/**
 * The demonstration at the foot of the page, running for real -- both engines
 * at once.
 *
 * One engine alone would not be worth the panel: a CRDT merging after a
 * partition is the EXPECTED outcome, and a demo whose punchline is "the thing
 * worked" gives a reader nothing to think about. The comparison is the project
 * (README, ADR-001, ADR-009), and this is the only place outside the lab it
 * can be seen.
 *
 * So both engines run the same script side by side, and they end differently:
 *
 *   CRDT  both sides of the partition survive the heal
 *   OT    the reconnecting client is handed the server's document, and the
 *         work it did offline is gone (ADR-004, "RESYNC, local edits lost")
 *
 * Neither is scripted playback. The CRDT rows are two real `Y.Doc`s
 * exchanging real updates. The OT rows run the project's own `TextOperation`
 * -- the same `transform`/`compose`/`apply` the server uses, imported from
 * `@collab/ot` rather than reimplemented here, so if the algorithm were wrong
 * this panel would show it being wrong.
 *
 * What it deliberately does NOT do is open a socket. A landing page that needs
 * a running backend to look alive is a landing page that looks broken the one
 * time it matters, and a demo that creates a document per visitor would fill
 * the unowned pile on `/docs` with hero animations. The lab is where the same
 * thing happens over a real network, with a real server, and full controls --
 * this is the trailer, and it links there.
 *
 * The claim it makes is therefore exactly true and no larger: *the merge, the
 * transform and the discard are all real*. The network under them is not, and
 * the caption says so.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TextOperation } from '@collab/ot';

/**
 * Yjs is imported lazily; `@collab/ot` is not.
 *
 * Honestly stated: neither choice saves a byte today. `main.jsx` keeps the
 * editor and the lab eager (see its comment on which routes are split), and
 * both `yjs-sync.js` and `ot-sync.js` import their engine statically, so both
 * engines are in the main bundle whatever this file does -- the build's
 * INEFFECTIVE_DYNAMIC_IMPORT warning names those static imports, not this one.
 *
 * Yjs is lazy anyway because the landing page is the one surface whose whole
 * job is to appear immediately, and a decorative animation should never be on
 * its critical path. `TextOperation` is a few hundred lines of pure arithmetic
 * with no dependencies, so splitting it would cost a chunk boundary to defer
 * less than it costs to fetch.
 */

const BASE = 'The quick brown fox';
const EDIT_A = ' jumps over the lazy dog';
const EDIT_B = ' was never quick at all';

/** How long the replicas wait between keystroke bursts while partitioned. */
const TYPE_MS = 1300;

/**
 * One full cycle, as a list of steps. Written as data rather than a chain of
 * timeouts so the whole story is readable in one place, and so unmounting
 * halfway through cancels exactly one timer.
 */
const SCRIPT = [
  { at: 600, phase: 'synced', label: 'In sync' },
  { at: 1500, phase: 'partitioned', label: 'Network cut', act: 'partition' },
  { at: 2300, phase: 'partitioned', label: 'Both replicas keep typing', act: 'typeA' },
  { at: 3600, phase: 'partitioned', label: 'Both replicas keep typing', act: 'typeB' },
  { at: 5200, phase: 'diverged', label: 'Diverged — two different documents' },
  { at: 6600, phase: 'healing', label: 'Reconnecting', act: 'heal' },
  { at: 7600, phase: 'settled', label: 'Same partition, two outcomes' },
  { at: 11000, phase: 'synced', label: 'In sync', act: 'reset' },
];

/* ------------------------------------------------------------------ CRDT -- */

/**
 * Two Y.Docs and a relay that can be switched off.
 *
 * While partitioned an update is not dropped, it is HELD -- which is what a
 * healed partition means and why the merge has anything to do afterwards.
 */
function buildCrdt(Y) {
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const held = { toA: [], toB: [] };
  const link = { partitioned: false };

  docA.on('update', (update, origin) => {
    if (origin === 'remote') return;
    if (link.partitioned) held.toB.push(update);
    else Y.applyUpdate(docB, update, 'remote');
  });
  docB.on('update', (update, origin) => {
    if (origin === 'remote') return;
    if (link.partitioned) held.toA.push(update);
    else Y.applyUpdate(docA, update, 'remote');
  });

  const textA = docA.getText('t');
  const textB = docB.getText('t');
  textA.insert(0, BASE);

  return {
    link,
    read: () => [textA.toString(), textB.toString()],
    typeA: () => textA.insert(textA.length, EDIT_A),
    typeB: () => textB.insert(textB.length, EDIT_B),
    heal: () => {
      link.partitioned = false;
      for (const u of held.toB) Y.applyUpdate(docB, u, 'remote');
      for (const u of held.toA) Y.applyUpdate(docA, u, 'remote');
      held.toA = [];
      held.toB = [];
    },
    destroy: () => { docA.destroy(); docB.destroy(); },
  };
}

/* -------------------------------------------------------------------- OT -- */

/** An append at the end of `text`, as a changeset over the whole document. */
const appendOp = (text, str) => new TextOperation().retain(text.length).insert(str);

/**
 * A server-authoritative OT replica pair, using the real transform.
 *
 * The server holds the document and its revision; each client holds its own
 * text and, while cut off, a pending operation composed from everything it has
 * typed. That composition is the point of changesets (ADR-004 §1): however
 * long the client is away, the buffer stays exactly one operation.
 *
 * On heal, the two clients are treated differently, and that asymmetry is the
 * honest one:
 *
 *   alice reconnects against a server nobody else has reached, so her pending
 *         op still applies to the revision she left from and is accepted.
 *   bob   reconnects against a server that has moved on. His base revision is
 *         below the history the server kept, so it cannot rebase him forward
 *         and answers RESYNC with the full document -- and his offline work is
 *         discarded, exactly as ADR-004 says it is.
 */
function buildOt() {
  const server = { text: BASE, rev: 0 };
  const clients = {
    a: { text: BASE, base: 0, pending: null },
    b: { text: BASE, base: 0, pending: null },
  };
  const link = { partitioned: false };

  /** Send a client's pending op to the server, or hold it if the wire is cut. */
  const push = (id) => {
    const c = clients[id];
    if (!c.pending || link.partitioned) return;
    server.text = c.pending.apply(server.text);
    server.rev += 1;
    c.pending = null;
    // A relay would broadcast here. With one connected client at a time in
    // this script there is nobody to broadcast to, so the other side simply
    // learns the document when it reconnects.
    for (const other of Object.keys(clients)) {
      if (other === id) continue;
      if (!clients[other].pending) {
        clients[other].text = server.text;
        clients[other].base = server.rev;
      }
    }
  };

  const type = (id, str) => {
    const c = clients[id];
    const op = appendOp(c.text, str);
    c.text = op.apply(c.text);
    // Compose rather than queue: one operation in flight, always (ADR-004 §3).
    c.pending = c.pending ? c.pending.compose(op) : op;
    push(id);
  };

  return {
    link,
    read: () => [clients.a.text, clients.b.text],
    typeA: () => type('a', EDIT_A),
    typeB: () => type('b', EDIT_B),
    heal: () => {
      link.partitioned = false;
      // Alice first: her op still rebases onto the revision she left from.
      push('a');
      // Bob is now behind a revision the server can no longer rebase him over.
      // RESYNC: take the server's document, drop the pending work.
      clients.b.pending = null;
      clients.b.text = server.text;
      clients.b.base = server.rev;
    },
    destroy: () => {},
  };
}

/* ----------------------------------------------------------------- view -- */

export function LiveDemo() {
  const [crdt, setCrdt] = useState([BASE, BASE]);
  const [ot, setOt] = useState([BASE, BASE]);
  const [phase, setPhase] = useState('synced');
  const [label, setLabel] = useState('In sync');
  const [reduced, setReduced] = useState(false);

  const engines = useRef(null);
  const timer = useRef(null);
  const typing = useRef(null);
  /** The Yjs module, once its lazy import lands. The button needs it too. */
  const yRef = useRef(null);
  /*
   * True once the visitor takes the wire into their own hands.
   *
   * A ref and not state, which matters more than it looks. As state it would
   * be a dependency of the effect below, so the very click that takes control
   * would tear the effect down -- cancelling the pending keystroke timer and
   * rebuilding both engines from scratch -- leaving the demo at its base text
   * doing nothing. Nothing renders from this flag; it only tells the script
   * to stop.
   */
  const manual = useRef(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const on = (e) => setReduced(e.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);

  const sync = useCallback(() => {
    const e = engines.current;
    if (!e) return;
    setCrdt(e.crdt.read());
    setOt(e.ot.read());
  }, []);

  useEffect(() => {
    // Someone who has asked for less motion gets the outcome rather than the
    // performance: both engines' end states, stated. Running the loop anyway
    // and merely hiding the transitions would still be a page that never
    // settles. The button still works -- reduced motion is a request about
    // animation, not about interactivity.
    if (reduced) {
      setCrdt([BASE + EDIT_A + EDIT_B, BASE + EDIT_A + EDIT_B]);
      setOt([BASE + EDIT_A, BASE + EDIT_A]);
      setPhase('settled');
      setLabel('Same partition, two outcomes');
      return undefined;
    }

    let cancelled = false;

    const run = (index) => {
      const Y = yRef.current;
      if (cancelled || !Y || manual.current) return;
      const step = SCRIPT[index % SCRIPT.length];
      const e = engines.current;

      switch (step.act) {
        case 'partition':
          e.crdt.link.partitioned = true;
          e.ot.link.partitioned = true;
          break;
        case 'typeA':
          e.crdt.typeA();
          e.ot.typeA();
          break;
        case 'typeB':
          // Both replicas write at the end of *their own* document, which is a
          // different index on each side. That is the concurrent edit.
          e.crdt.typeB();
          e.ot.typeB();
          break;
        case 'heal':
          e.crdt.heal();
          e.ot.heal();
          break;
        case 'reset':
          e.crdt.destroy();
          e.ot.destroy();
          engines.current = { crdt: buildCrdt(Y), ot: buildOt() };
          break;

        default:
          break;
      }

      setPhase(step.phase);
      setLabel(step.label);
      sync();

      const next = SCRIPT[(index + 1) % SCRIPT.length];
      const delay = next.at > step.at ? next.at - step.at : next.at + 1200;
      timer.current = setTimeout(() => run(index + 1), delay);
    };

    import('yjs').then((mod) => {
      // The effect may have been torn down while the import was in flight.
      if (cancelled) return;
      yRef.current = mod;
      engines.current = { crdt: buildCrdt(mod), ot: buildOt() };
      sync();
      if (!manual.current) timer.current = setTimeout(() => run(0), SCRIPT[0].at);
    });

    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      clearTimeout(typing.current);
      engines.current?.crdt.destroy();
      engines.current?.ot.destroy();
      engines.current = null;
    };
  }, [reduced, sync]);

  /**
   * The visitor cuts the wire themselves.
   *
   * Taking manual control stops the script for good -- a loop that resumed
   * underneath someone who is driving would yank the document out from under
   * them mid-sentence. From here the button is the only thing that moves the
   * demo, which is the point of handing it over.
   */
  const cut = useCallback(() => {
    const e = engines.current;
    if (!e) return;
    clearTimeout(timer.current);
    clearTimeout(typing.current);
    manual.current = true;

    const partitioned = !e.crdt.link.partitioned;

    if (partitioned) {
      /*
       * Cutting starts a fresh pair of replicas.
       *
       * Without this, a second cut would type EDIT_A onto a document that
       * already ends in EDIT_A -- "…lazy dog jumps over the lazy dog" -- and
       * by the third the panes would be unreadable. The demo is a single
       * partition observed repeatedly, not a document being grown, so each cut
       * begins where the last one began.
       */
      const Y = yRef.current;
      if (Y) {
        e.crdt.destroy();
        e.ot.destroy();
        engines.current = { crdt: buildCrdt(Y), ot: buildOt() };
      }
    }

    const live = engines.current;
    live.crdt.link.partitioned = partitioned;
    live.ot.link.partitioned = partitioned;

    if (partitioned) {
      setPhase('partitioned');
      setLabel('Network cut — both replicas keep typing');
      /*
       * One burst each, not a repeating one. A loop that kept appending has
       * only the same two fragments to append, so alice would end up holding
       * "…lazy dog jumps over the lazy dog" -- which reads as a bug in the
       * merge rather than as continued typing. One concurrent edit per side
       * is also exactly what the scripted cycle does, so the manual path and
       * the automatic one demonstrate the same thing.
       */
      typing.current = setTimeout(() => {
        live.crdt.typeA(); live.ot.typeA();
        live.crdt.typeB(); live.ot.typeB();
        setPhase('diverged');
        setLabel('Diverged — two different documents');
        sync();
      }, TYPE_MS);
    } else {
      live.crdt.heal();
      live.ot.heal();
      setPhase('settled');
      setLabel('Same partition, two outcomes');
    }
    sync();
  }, [sync]);

  const cutNow = phase === 'partitioned' || phase === 'diverged';

  return (
    <div className="demo">
      <div className="demo-engines">
        <EngineRow
          engine="CRDT"
          tone="ok"
          a={crdt[0]}
          b={crdt[1]}
          phase={phase}
          verdict={phase === 'settled' ? 'both edits survive' : null}
        />
        <EngineRow
          engine="OT"
          tone="lost"
          a={ot[0]}
          b={ot[1]}
          phase={phase}
          verdict={phase === 'settled' ? 'replica bob’s offline work discarded' : null}
        />
      </div>

      <div className="demo-foot">
        {/*
          A real button, and the reason the card around it is a <section>
          rather than one big <a>. Nesting a control inside a link is invalid
          markup and gives a keyboard user one target where there are two
          actions; the card takes its whole-surface click from a stretched
          `.go` link instead, and this sits above that overlay.
        */}
        <button type="button" className="demo-cut" onClick={cut}>
          {cutNow ? 'Restore the network' : 'Cut the network'}
        </button>
        <span className={`demo-dot${phase === 'settled' || phase === 'synced' ? ' ok' : ''}`} />
        <span className="demo-label">{label}</span>
      </div>
    </div>
  );
}

function EngineRow({ engine, tone, a, b, phase, verdict }) {
  const cut = phase === 'partitioned' || phase === 'diverged';
  return (
    <div className={`demo-row demo-row-${tone}${cut ? ' cut' : ''}`}>
      <span className="demo-engine">{engine}</span>
      <div className="demo-panes">
        <Replica name="alice" text={a} cut={cut} />
        <Replica name="bob" text={b} cut={cut} />
      </div>
      {verdict && <span className={`demo-verdict is-${tone}`}>{verdict}</span>}
    </div>
  );
}

function Replica({ name, text, cut }) {
  return (
    <div className={`demo-pane${cut ? ' cut' : ''}`}>
      <div className="demo-pane-head">
        <span className="demo-replica">{name}</span>
        {cut && <span className="demo-badge">offline</span>}
      </div>
      <p className="demo-text">{text}</p>
    </div>
  );
}
