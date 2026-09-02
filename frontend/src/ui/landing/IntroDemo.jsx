import React, { useEffect, useRef, useState } from 'react';

/**
 * Two people typing into one document, in the introduction, for real.
 *
 * The centre panel could make its case in a paragraph -- "several people
 * editing one document at the same time, live cursors, every keystroke merged
 * as it lands" -- and every word of that would be true. But a description of
 * motion is the one thing that cannot show motion. This is the same claim,
 * running.
 *
 * It is two real `Y.Doc`s with a relay between them -- the same construction
 * as LiveDemo.jsx, minus the partition, because the point here is the ordinary
 * case rather than the failure. Ada appends at the end of the paragraph while
 * Grace types at the front and then bolds a phrase; both replicas apply both
 * streams; what is rendered is replica A's document. Nobody's keystrokes are
 * replayed from a script into a <div> -- if the merge were broken, this panel
 * would show it being broken.
 *
 * What it deliberately does not do is open a socket. A landing page that needs
 * a running backend to look alive looks broken exactly when it matters, and a
 * demo that made a document per visitor would fill the unowned pile on /docs
 * with hero animations. The lab, one panel down, is where the same thing
 * happens over a real network with real controls.
 *
 * Carets are inline elements in the text flow rather than absolutely
 * positioned overlays: an overlay has to measure a character offset, which
 * means a DOM Range per frame per caret and a re-measure on every wrap. An
 * inline element is placed by the same line-breaking the text already does.
 */

const TITLE = 'Sprint notes';

const SEED = 'Two people can type in this document at the same time';
/** Ada appends at the end; Grace types at the front. */
const ADA = ' and nothing collides.';
const GRACE = 'Everyone sees it as it happens. ';
/** The phrase Grace bolds once she has finished typing it. */
const BOLD = 'as it happens';

/** Per keystroke. Fast enough to read as typing, slow enough to follow. */
const KEY_MS = 58;

const PEOPLE = {
  ada: { name: 'Ada', colour: '#3f7d3a' },
  grace: { name: 'Grace', colour: '#b0447a' },
};

/**
 * Two Y.Docs and a relay, always connected.
 *
 * `origin === 'remote'` is what stops an applied update bouncing back down the
 * wire it arrived on -- the same guard the real sync layer needs, for the same
 * reason.
 */
function buildPair(Y) {
  const docA = new Y.Doc();
  const docB = new Y.Doc();

  docA.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(docB, u, 'remote'); });
  docB.on('update', (u, origin) => { if (origin !== 'remote') Y.applyUpdate(docA, u, 'remote'); });

  const textA = docA.getText('t');
  const textB = docB.getText('t');
  textA.insert(0, SEED);

  return {
    // Read from A, write from both: what A shows is what the merge produced,
    // not what either replica typed.
    read: () => textA.toDelta(),
    length: () => textA.length,
    ada: (ch, at) => textA.insert(at, ch),
    grace: (ch, at) => textB.insert(at, ch),
    bold: () => {
      const at = textB.toString().indexOf(BOLD);
      if (at >= 0) textB.format(at, BOLD.length, { bold: true });
    },
    destroy: () => { docA.destroy(); docB.destroy(); },
  };
}

export function IntroDemo() {
  const [runs, setRuns] = useState([{ insert: SEED }]);
  // Where each person's caret sits, in characters from the start of the
  // merged document. Ada's is always the end, so it needs no tracking.
  const [graceAt, setGraceAt] = useState(0);
  /*
   * Whose name is showing. Both carets are always drawn; only the person who
   * typed most recently is labelled, which is what a real editor does and what
   * stops two flags stacking on top of each other when the two carets happen
   * to land in the same column -- which they do at rest, because the sentence
   * is the same length every cycle.
   */
  const [active, setActive] = useState('ada');
  const pair = useRef(null);
  const timers = useRef([]);

  useEffect(() => {
    let live = true;
    const wait = (ms, fn) => { timers.current.push(setTimeout(() => { if (live) fn(); }, ms)); };

    // Lazy, like LiveDemo: the landing page's whole job is to appear
    // immediately, and an animation must never be on that critical path.
    import('yjs').then((mod) => {
      if (!live) return;
      const Y = mod;

      const cycle = () => {
        pair.current?.destroy();
        const p = buildPair(Y);
        pair.current = p;
        setRuns(p.read());
        setGraceAt(0);
        setActive('ada');

        const show = () => { if (live) setRuns(p.read()); };

        /*
         * The two streams overlap on purpose. Ada starts first and Grace comes
         * in over the top of her, which is the only arrangement in which the
         * paragraph is visibly growing from both ends at once -- and that is
         * the entire thing being demonstrated.
         */
        let t = 700;
        for (const ch of ADA) {
          wait(t, () => { p.ada(ch, p.length()); setActive('ada'); show(); });
          t += KEY_MS;
        }

        let g = 1500;
        [...GRACE].forEach((ch, i) => {
          wait(g, () => {
            p.grace(ch, i);
            setGraceAt(i + 1);
            setActive('grace');
            show();
          });
          g += KEY_MS;
        });

        // Formatting is a real Yjs attribute on a real range, applied by the
        // replica that typed the words.
        wait(g + 500, () => { p.bold(); setActive('grace'); show(); });
        // Long enough to read the finished sentence before it starts again.
        wait(Math.max(t, g) + 3400, cycle);
      };

      cycle();
    });

    return () => {
      live = false;
      for (const id of timers.current) clearTimeout(id);
      timers.current = [];
      pair.current?.destroy();
    };
  }, []);

  /*
   * Split the merged runs at the two caret offsets and drop a caret element
   * into the gap. Done here rather than in the CRDT because a caret is not
   * part of the document -- neither replica's text contains one.
   */
  const total = runs.reduce((n, r) => n + r.insert.length, 0);
  const marks = [
    { at: Math.min(graceAt, total), who: 'grace' },
    { at: total, who: 'ada' },
  ].sort((a, b) => a.at - b.at);

  const out = [];
  let seen = 0;
  let next = 0;
  runs.forEach((run, ri) => {
    let text = run.insert;
    let from = 0;
    while (next < marks.length && marks[next].at <= seen + text.length) {
      const cut = marks[next].at - seen;
      if (cut > from) {
        out.push(
          <span key={`t${ri}-${from}`} className={run.attributes?.bold ? 'id-b' : undefined}>
            {text.slice(from, cut)}
          </span>,
        );
      }
      const id = marks[next].who;
      const who = PEOPLE[id];
      out.push(
        <span key={`c${id}-${ri}`} className="id-caret" style={{ background: who.colour }}>
          {id === active && (
            <span className="id-flag" style={{ background: who.colour }}>{who.name}</span>
          )}
        </span>,
      );
      from = cut;
      next += 1;
    }
    if (from < text.length) {
      out.push(
        <span key={`t${ri}-end`} className={run.attributes?.bold ? 'id-b' : undefined}>
          {text.slice(from)}
        </span>,
      );
    }
    seen += text.length;
  });

  return (
    <div className="intro-doc" aria-hidden="true">
      <div className="id-head">
        <span className="id-title">{TITLE}</span>
        <span className="id-people">
          {Object.values(PEOPLE).map((p) => (
            <span key={p.name} className="id-chip" style={{ background: p.colour }}>
              {p.name[0]}
            </span>
          ))}
        </span>
      </div>

      {/*
        aria-hidden on the wrapper, and the sentence it builds is said in words
        by the paragraph above it. A screen reader would otherwise be handed a
        paragraph that rewrites itself every 58ms.
      */}
      <p className="id-body">{out}</p>
    </div>
  );
}
