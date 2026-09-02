import React from 'react';
import durability from './durability.json';

/**
 * What it is built on.
 *
 * The introduction gestures at this in its last clause and has no room to
 * follow it up, so this tile does: four lines of what is underneath, and the
 * durability result as the one measured thing among them -- evidence for the
 * append-only log named directly above it rather than a claim standing on its
 * own.
 *
 * The number comes from `tools/measure-durability.mjs`, which boots a real
 * server, kills it with a real signal and counts characters on the way back.
 * It refuses to write a record in which anything was lost, so this cannot
 * quietly start reporting a failure as a success.
 */

/**
 * Deliberately not a feature list, and deliberately not a spec sheet either.
 *
 * Each line leads with what the reader GETS and names the mechanism second.
 * Leading with the mechanism -- "CRDT merge", "Append-only log", "Hand-written
 * protocol" -- puts the least legible half of each sentence in the bold half:
 * a reader who already knows what a CRDT is learns nothing, and a reader who
 * does not is stopped at the first two words of the first line.
 *
 * The mechanisms are all here, because the claim this tile exists to make is
 * that this repository wrote them -- and `Yjs` is named for the same reason:
 * it is the one thing that was not, and a tile about what you built is the
 * wrong place to be vague about what you did not.
 *
 * Each note has to hold one line at 339 units wide (see `.hood-list li`,
 * which sets `nowrap`), which is roughly a 50-character budget for the pair.
 * That is the real constraint on the phrasing here, not taste.
 */
const PARTS = [
  { name: 'No edit ever loses', note: 'Yjs merges them, not the server' },
  { name: 'No save button', note: 'an append-only log, always on' },
  { name: 'The sync is ours', note: 'the handshake, written by hand' },
  { name: 'Cursors follow you', note: 'and comments stay on their words' },
];

export function InternalsPanel() {
  return (
    <div className="hood-wrap">
      {/* No category label above the list. It would be a shouty uppercase
          word for a category rather than a statement, costing 23 units in a
          210-unit tile, and the four lines below already say what they are.
          The panel takes its accessible name from the <section> in
          Landing.jsx, so a screen reader is not short of one either. */}
      <ul className="hood-list">
        {PARTS.map((p) => (
          <li key={p.name}>
            <b>{p.name}</b> <span>{p.note}</span>
          </li>
        ))}
      </ul>

      {/*
        The receipt for the line above it, and a link rather than a statement
        because the reader who wants it wants the whole decision. Stated
        precisely enough to be doubted: "nothing is lost" is a slogan, and a
        signal name with a count beside it is a result someone can re-run.

        `SIGKILL` is named, and then glossed in six words. Dropping it would
        stop the sentence being checkable -- tools/landing-test.mjs asserts
        this line carries the signal the measurement actually used, which is
        the guard that keeps a figure on this page from drifting away from the
        tool that produced it. Leaving it bare would put a word most readers
        cannot parse in the one sentence on the tile that has to land hardest.
        It is not bolded: the number is the thing to look at, and the signal is
        the citation for it.
      */}
      {/*
        ADR-019, not ADR-003.

        ADR-003 decides the append-only log and its snapshots, but ADR-019 is
        where THIS claim is settled: Postgres as the source of truth on a host
        with an ephemeral disk, and a bounded write buffer in front of it that
        trades at most PERSIST_WINDOW_MS of server-side log for not putting a
        network round trip on every keystroke. A reader who doubts the number
        below wants that argument, not the one about snapshot cadence.
      */}
      <a className="hood-proof" href="/decisions#adr-019">
        We killed the server mid-sentence &mdash; {durability.signal}, no
        warning and no chance to save. <b>{durability.charsLost}</b> of{' '}
        {durability.charsWritten.toLocaleString()} characters{' '}
        {/* The arrow is bound to the word before it, or it wraps alone onto
            the last line and reads as a stray glyph. */}
        <span className="hood-arrow">lost &rarr;</span>
      </a>
    </div>
  );
}
