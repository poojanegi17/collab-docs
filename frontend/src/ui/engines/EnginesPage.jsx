import React from 'react';
import { useDisplayFont } from '../use-display-font.js';
// The long-form page styles. Imported here explicitly rather than relied on:
// this page uses them, and a reader should not have to find that out from
// another component's import list.
import '../prose.css';
import './engines.css';
import { EngineDemo } from './EngineDemo.jsx';
import { Diagram, DiagramDefs } from '../diagram/Diagram.jsx';

/**
 * How concurrent edits are reconciled, in both engines.
 *
 * Reached from the two engine chips on the landing page's status panel, which
 * used to read `CRDT :8080` and `OT :8081`. The port was never the interesting
 * part of that label -- and it stops being true the moment this is deployed
 * anywhere -- so the chip now says what the engine IS and links here.
 *
 * ORDER, which is the thing this page has been rewritten around twice: meet
 * each engine, then watch them resolve the same conflict, then ask questions
 * about what you just saw. It opened with four paragraphs of prose and reached
 * a worked example on the third screen, which asked the reader to hold an
 * abstract description in their head with nothing to hang it on.
 *
 * The diagrams are the six shapes from `../diagram`, the same vocabulary
 * /decisions uses. Sharing it is the point: a reader who has learned that a
 * dashed line means a seam does not have to learn it twice.
 *
 * Everything here is drawn from the implementation rather than the literature.
 * The tie-break rules in particular are the ones in
 * `shared/ot/src/rich-text-operation.js`, not the ones a paper would give: a
 * page that explains a different algorithm from the one running underneath it
 * is worse than no page.
 */

/**
 * The two engines, side by side, in the same shape.
 *
 * OT first, and the order is not cosmetic. The demo below puts OT on the left
 * too, and a reader maps these to those by POSITION long before they read a
 * heading -- the two cards saying CRDT/OT above two lanes saying OT/CRDT is a
 * page arguing with itself. It is also the better order to learn in: the
 * referee is the answer everybody guesses, and the CRDT is only surprising
 * once you have seen what it removes.
 */
const ENGINES = [
  {
    id: 'ot',
    name: 'OT',
    tag: 'server referees',
    lede: 'Every edit says which revision it was based on. If the server has moved on, it rewrites the edit — transforms it — so that it means the same thing against the newer document.',
    cost: 'Costs a central authority: one writer per document, and work done offline for too long is discarded on reconnect because there is no history left to rebase it against.',
    diagram: {
      kind: 'flow',
      steps: ['your edit', 'server rewrites it', 'every replica'],
      accent: 1,
      alt: 'An edit is sent to the server, which rewrites it to fit the current document, and the result goes to every replica.',
    },
  },
  {
    id: 'crdt',
    name: 'CRDT',
    tag: 'no referee',
    lede: 'Every character gets an identity when it is typed. An edit names a character — “after t” — never a position, so nothing has to be rewritten when somebody edits in front of you.',
    cost: 'Costs bookkeeping: the document carries an id per character and keeps deleted ones as markers, so it is bigger than its text and never forgets an editor.',
    diagram: {
      kind: 'cells',
      cells: [
        { v: 'c', label: 'd1' },
        { v: 'a', label: 'd2' },
        { v: 't', label: 'd3' },
        { v: 's', label: 'p1', tone: 'is-pick' },
      ],
      caption: 'ids never move, so an edit made against an old view still fits',
      alt: 'The word cat as four characters, each carrying its own id, with a new character appended that names the one it follows.',
    },
  },
];

/** The questions the demo raises, answered in a sentence each. */
const QUESTIONS = [
  {
    q: 'Who breaks a tie?',
    a: 'When two people insert at the same spot, someone has to go first. OT lets the server decide, which is why the rule is arbitrary but consistent. The CRDT compares character ids, which is why it needs no server at all.',
    diagram: {
      kind: 'split',
      from: 'two inserts, same spot',
      // OT left, CRDT right -- the order every other pair on this page uses.
      // Neutral, because neither answer is the better one: they are the same
      // guarantee reached by a referee or by a comparison.
      left: 'OT',
      leftSub: 'the server decides',
      right: 'CRDT',
      rightSub: 'compare ids',
      neutral: true,
      alt: 'Two inserts at the same position are ordered by the server under OT, and by comparing ids under the CRDT.',
    },
  },
  {
    q: 'What else does the transform decide?',
    a: 'Two people deleting the same word delete it once, not twice. A delete beats a concurrent format, because bolding text that no longer exists is not a visible change. Two formats both survive wherever they do not collide.',
    diagram: {
      kind: 'choice',
      a: 'delete + format',
      b: 'delete wins',
      pick: 'b',
      note: 'formatting text that no longer exists changes nothing',
      alt: 'When one person deletes text and another formats it, the delete wins.',
    },
  },
  {
    q: 'When does the difference actually show?',
    a: 'Under a partition. Cut two replicas off, type in both, reconnect: the CRDT merges both sides, OT hands the returning replica the server’s document and its own work is gone. Same editor, same storage, same network.',
    diagram: {
      kind: 'flow',
      steps: ['cut the wire', 'both keep typing', 'reconnect'],
      accent: 2,
      alt: 'The partition sequence: cut the network, both replicas keep typing, then reconnect.',
    },
  },
  {
    q: 'So why is the product CRDT-only?',
    a: 'Because losing offline work is not a trade a writer can be asked to evaluate, and an engine picker would ask them to. OT stays fully implemented and reachable — in the lab, where the difference is the subject rather than a prerequisite.',
    diagram: {
      kind: 'split',
      from: 'two working engines',
      left: 'the product',
      leftSub: 'CRDT only',
      right: 'the lab',
      rightSub: 'both, side by side',
      alt: 'Both engines are implemented: the product uses only the CRDT, and the lab runs both.',
    },
  },
];

export function EnginesPage() {
  useDisplayFont();

  return (
    <div className="prose-page eng-page">
      <DiagramDefs />

      <header className="prose-head">
        <a className="prose-back" href="/">&larr; collab-docs</a>
        <h1>
          <span className="prose-tint">Two edits.</span> One document.
        </h1>
        <p className="prose-lede">
          Two people type in the same sentence at the same moment. Both are
          right about what the document said when they started, and something
          has to turn that into one document without either edit being thrown
          away. There are two answers, and this project runs both.
        </p>
      </header>

      {/* The three movements are one landmark. The old layout had a
          `<main className="prose-main">` around its sections and this lost it
          in the rewrite -- caught by tools/a11y-test.mjs, which checks every
          route for one, because a screen-reader user's first move on an
          unfamiliar page is to jump to it. */}
      <main>

      {/* ---- 1. meet the engines ------------------------------------------ */}
      <section className="eng-pair" aria-label="The two engines">
        {ENGINES.map((e) => (
          <article className={`eng-card eng-card-${e.id}`} key={e.id} id={e.id}>
            <div className="eng-kicker">
              <h2>{e.name}</h2>
              <span className="eng-tag">{e.tag}</span>
            </div>
            <div className="eng-dia"><Diagram spec={e.diagram} /></div>
            <p className="eng-lede">{e.lede}</p>
            <p className="eng-cost">{e.cost}</p>
          </article>
        ))}
      </section>

      {/* ---- 2. watch them do it ------------------------------------------ */}
      <EngineDemo />

      {/* ---- 3. the questions that raises --------------------------------- */}
      <section className="eng-qs" aria-label="Questions">
        {QUESTIONS.map((item) => (
          <article className="eng-q" key={item.q}>
            <h3>{item.q}</h3>
            <div className="eng-dia"><Diagram spec={item.diagram} /></div>
            <p>{item.a}</p>
          </article>
        ))}
      </section>

      {/* ---- 4. where to go next ------------------------------------------ */}
      <section className="eng-foot">
        <div>
          <h3>See it for yourself</h3>
          <p>
            The lab runs both engines on one document, with a wire you can cut.
            The guided run does exactly the partition above, and the timeline
            shows every message that produced the result.
          </p>
          <a className="prose-link" href="/lab">Open the lab &rarr;</a>
        </div>
        <div>
          <h3>The decisions behind this</h3>
          <ul className="eng-links">
            <li><a className="prose-link" href="/decisions#adr-001">ADR-001</a> — why the product is a CRDT</li>
            <li><a className="prose-link" href="/decisions#adr-002">ADR-002</a> — the seam that lets both run</li>
            <li><a className="prose-link" href="/decisions#adr-004">ADR-004</a> — the hand-written OT engine</li>
            <li><a className="prose-link" href="/decisions#adr-009">ADR-009</a> — CRDT for the product, OT for the lab</li>
          </ul>
        </div>
      </section>

      </main>
    </div>
  );
}
