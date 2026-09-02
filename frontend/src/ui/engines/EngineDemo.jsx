/**
 * One conflict, resolved twice -- the interactive top of /engines.
 *
 * The page used to open with four paragraphs and a static table. Both engines
 * answer one question, "what does position 42 mean once somebody has edited in
 * front of it", and that question is about something MOVING; a table cannot
 * show a thing move. So the reader picks the two edits, steps through, and
 * watches OT rewrite an operation while the CRDT rewrites nothing.
 *
 * WHAT IS REAL HERE, because a page that fakes its own subject is worse than
 * no page:
 *
 *   the OT lane    is the engine. `TextOperation` is imported from
 *                  `@collab/ot` -- the same class the server transforms with
 *                  -- and the rewritten operation shown on step 2 is whatever
 *                  `TextOperation.transform` actually returned. Nothing is
 *                  hard-coded; change an edit and the numbers change.
 *
 *   the CRDT lane  is the identity scheme drawn out by hand, and it has to be.
 *                  The whole point is to SHOW the character ids, and a real
 *                  CRDT keeps them internal -- Yjs will hand back "cats" and
 *                  never a single id. So the merge below is modelled: base
 *                  characters get ids, an insert names the character it goes
 *                  after, and two inserts sharing an anchor are ordered by id.
 *                  That is the mechanism, not a cartoon of it, but it is not
 *                  the library. The real one runs in the lab and on the
 *                  landing page, against real Y.Docs.
 *
 * The four combinations were chosen so every one of them is a different
 * lesson, and so both engines agree on all four -- convergence is the claim,
 * and a demo where the two lanes disagreed would be making a different point
 * than the one intended.
 */
import React, { useMemo, useState } from 'react';
import { TextOperation } from '@collab/ot';

const BASE = 'cat';

/**
 * Single-character edits, deliberately.
 *
 * A multi-character insert is the same idea and four times the chips; the
 * CRDT lane draws one box per character, and "The " turns a readable row into
 * a wall. One character each keeps both lanes legible at the same size.
 */
const EDITS = {
  a: [
    {
      id: 'end-s',
      label: 'add “s” at the end',
      result: 'cats',
      op: () => new TextOperation().retain(3).insert('s'),
      crdt: () => [{ type: 'ins', id: 'p1', char: 's', after: 'd3', site: 1 }],
    },
    {
      id: 'after-c',
      label: 'add “h” after the “c”',
      result: 'chat',
      op: () => new TextOperation().retain(1).insert('h').retain(2),
      crdt: () => [{ type: 'ins', id: 'p1', char: 'h', after: 'd1', site: 1 }],
    },
  ],
  b: [
    {
      id: 'del-first',
      label: 'delete the “c”',
      result: 'at',
      op: () => new TextOperation().delete(1).retain(2),
      crdt: () => [{ type: 'del', target: 'd1' }],
    },
    {
      id: 'end-bang',
      label: 'add “!” at the end',
      result: 'cat!',
      op: () => new TextOperation().retain(3).insert('!'),
      crdt: () => [{ type: 'ins', id: 'p2', char: '!', after: 'd3', site: 2 }],
    },
  ],
};

const STEPS = ['Apart', 'They meet', 'Agreed'];

/**
 * The base document as characters that own an identity.
 *
 * `d1..d3` for the document everybody started from, `p1`/`p2` for what each
 * person typed. The two namespaces must not overlap: an inserted character
 * once reused a base character's id, which React reported as two children
 * with the same key -- and, worse than the warning, it meant the id shown
 * under a chip was not unique, in a lane whose entire claim is that ids
 * uniquely name a character.
 */
const baseChars = () =>
  BASE.split('').map((ch, i) => ({ id: `d${i + 1}`, ch, site: 0, deleted: false }));

/**
 * Apply identity-addressed edits to the character list.
 *
 * Inserts first, then deletes, so that deleting a character does not change
 * where anything else lands -- which is the property the whole scheme exists
 * to have. Two inserts naming the same anchor are ordered by site, and that
 * comparison is the CRDT's entire answer to the tie OT needs a server for.
 */
function merge(ops) {
  const list = baseChars();

  const inserts = ops.filter((o) => o.type === 'ins');
  for (const anchor of [...new Set(inserts.map((o) => o.after))]) {
    const group = inserts
      .filter((o) => o.after === anchor)
      .sort((x, y) => x.site - y.site);
    const at = list.findIndex((c) => c.id === anchor);
    if (at < 0) continue;
    list.splice(at + 1, 0, ...group.map((o) => ({
      id: o.id, ch: o.char, site: o.site, deleted: false,
    })));
  }

  // A delete is a tombstone, not a removal. It stays in the list so that an
  // edit anchored to it still has something to point at -- which is exactly
  // the bookkeeping cost the prose below the demo talks about.
  for (const o of ops) {
    if (o.type !== 'del') continue;
    const target = list.find((c) => c.id === o.target);
    if (target) target.deleted = true;
  }
  return list;
}

const textOf = (list) => list.filter((c) => !c.deleted).map((c) => c.ch).join('');

function Chars({ list, highlight }) {
  return (
    <div className="ed-chars">
      {list.map((c) => (
        <span
          key={c.id}
          className={`ed-char ed-site-${c.site}${c.deleted ? ' is-gone' : ''}${highlight === c.id ? ' is-new' : ''}`}
          /* The id is the point of the lane, so it is shown rather than
             explained: a reader can see that `t` keeps the same label before
             and after the merge, which is the whole claim. */
          title={c.deleted ? `${c.id} — deleted, but still here as a marker` : c.id}
        >
          {c.ch}
          <i className="ed-id">{c.id}</i>
        </span>
      ))}
    </div>
  );
}

export function EngineDemo() {
  const [pickA, setPickA] = useState(0);
  const [pickB, setPickB] = useState(0);
  const [step, setStep] = useState(0);

  const editA = EDITS.a[pickA];
  const editB = EDITS.b[pickB];

  const model = useMemo(() => {
    const a = editA.op();
    const b = editB.op();
    // The real transform. `a` is the server's side, which is why it wins the
    // position tie -- see the note in text-operation.js.
    const [aPrime, bPrime] = TextOperation.transform(a, b);
    const otText = bPrime.apply(a.apply(BASE));

    const opsA = editA.crdt();
    const opsB = editB.crdt();
    const merged = merge([...opsA, ...opsB]);

    return {
      a, b, bPrime, otText,
      // What each replica held while it was still on its own.
      apartA: merge(opsA),
      apartB: merge(opsB),
      merged,
      crdtText: textOf(merged),
      newFromA: opsA.find((o) => o.type === 'ins')?.id,
      newFromB: opsB.find((o) => o.type === 'ins')?.id,
      // Did the operation actually have to change? For two edits that do not
      // overlap it does not, and saying so is more honest than implying every
      // transform rewrites something.
      rewritten: !b.equals(bPrime),
    };
  }, [editA, editB]);

  const choose = (side, i) => {
    (side === 'a' ? setPickA : setPickB)(i);
    setStep(0);
  };

  return (
    <section className="engine-demo" aria-label="How each engine resolves one conflict">
      <div className="ed-setup">
        {/* A real <h2>. The lanes below are <h3>, and without a level between
            them and the page's <h1> the document outline jumps h1 -> h3 --
            which tools/a11y-test.mjs checks on every route. It also earns its
            place for a sighted reader: the demo had no title at all. */}
        <h2 className="ed-title">One conflict, resolved twice</h2>
        <p className="ed-base">
          Two people open <b>{BASE}</b> and edit at the same moment. Pick what
          each of them does, then step through.
        </p>
        <div className="ed-picks">
          {[['a', editA, pickA], ['b', editB, pickB]].map(([side, , pick]) => (
            <div className={`ed-pick ed-pick-${side}`} key={side}>
              <span className="ed-who">{side === 'a' ? 'Person 1' : 'Person 2'}</span>
              {EDITS[side].map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  className={`ed-chip${pick === i ? ' is-on' : ''}`}
                  aria-pressed={pick === i}
                  onClick={() => choose(side, i)}
                >
                  {e.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="ed-steps" role="tablist" aria-label="Stage">
        {STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={step === i}
            className={`ed-step${step === i ? ' is-on' : ''}${i < step ? ' is-done' : ''}`}
            onClick={() => setStep(i)}
          >
            <span className="ed-step-n">{i + 1}</span>{label}
          </button>
        ))}
        <button
          type="button"
          className="ed-next"
          onClick={() => setStep((s) => (s + 1) % STEPS.length)}
        >
          {step === STEPS.length - 1 ? 'Replay' : 'Next →'}
        </button>
      </div>

      <div className="ed-lanes">
        {/* ---------------------------------------------------------- OT -- */}
        <article className="ed-lane ed-lane-ot">
          <header>
            <h3>OT</h3>
            <p>A server referee rewrites the edit so it still means the same thing.</p>
          </header>

          {step === 0 && (
            <div className="ed-body">
              <div className="ed-op ed-op-a"><span>Person 1</span><code>{model.a.toString()}</code></div>
              <div className="ed-op ed-op-b"><span>Person 2</span><code>{model.b.toString()}</code></div>
              <p className="ed-say">
                Both wrote their edit against <b>{BASE}</b>. Both are correct, and
                they cannot both be applied as written.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="ed-body">
              <div className="ed-op ed-op-a"><span>accepted</span><code>{model.a.toString()}</code></div>
              <div className="ed-rewrite">
                <code className="ed-was">{model.b.toString()}</code>
                <span className="ed-arrow">becomes</span>
                <code className="ed-now">{model.bPrime.toString()}</code>
              </div>
              <p className="ed-say">
                {model.rewritten
                  ? 'Person 2’s edit was written against a document that no longer exists, so the server rewrites it to fit the new one.'
                  : 'These two do not overlap, so the transform leaves the edit untouched — most of the time there is nothing to rewrite.'}
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="ed-body ed-body-end">
              <div className="ed-result">{model.otText}</div>
              <p className="ed-say">
                Every replica ends here — but only because one machine decided
                the order.
              </p>
            </div>
          )}
        </article>

        {/* -------------------------------------------------------- CRDT -- */}
        <article className="ed-lane ed-lane-crdt">
          <header>
            <h3>CRDT</h3>
            <p>Every character owns an id, so an edit never names a position.</p>
          </header>

          {step === 0 && (
            <div className="ed-body">
              <div className="ed-row"><span>Person 1</span><Chars list={model.apartA} highlight={model.newFromA} /></div>
              <div className="ed-row"><span>Person 2</span><Chars list={model.apartB} highlight={model.newFromB} /></div>
              <p className="ed-say">
                Nobody said &ldquo;position 3&rdquo;. Each edit names a
                character: <b>after {BASE.at(-1)}</b>, or <b>delete c</b>.
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="ed-body">
              <div className="ed-row"><span>merged</span><Chars list={model.merged} /></div>
              <p className="ed-say">
                Nothing was rewritten. The ids never moved, so both sets of
                edits still point at what they always pointed at — and no
                server was asked.
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="ed-body ed-body-end">
              <div className="ed-result">{model.crdtText}</div>
              <p className="ed-say">
                Same answer, reachable by either replica alone, in any order.
              </p>
            </div>
          )}
        </article>
      </div>

      <p className="ed-verdict">
        {step < 2
          ? 'Same conflict, two mechanisms: one rewrites the edit, the other makes rewriting unnecessary.'
          : <>Both engines land on <b>{model.otText}</b>. OT paid for it with a referee; the CRDT paid for it with an id on every character — including the deleted one, still sitting there as a marker.</>}
      </p>
    </section>
  );
}
