import React from 'react';

/**
 * What the words on this page mean.
 *
 * The lab is dense with terms that are perfectly ordinary IF you already
 * build collaborative editors -- replica, partition, anti-entropy, state
 * vector, revision, transform -- and completely opaque if you do not. This is
 * what the page offers the second reader.
 *
 * Deliberately NOT a rewrite of the interface into plain English. The real
 * words are the ones in the papers, the ADRs and the wire protocol, and
 * someone who learns "partition" here can go and read about partitions
 * everywhere else. Replacing them with friendly paraphrases would make this
 * page easier and every other page harder. So the terms stay, and this says
 * what they mean.
 *
 * Collapsed by default: it is scaffolding you need once, not furniture.
 */

const TERMS = [
  {
    term: 'replica',
    plain: 'One editor’s copy of the document.',
    more: 'Every pane below is a real, independent editor with its own connection '
      + 'to the server. They are all showing the SAME document — not different '
      + 'files that happen to match.',
  },
  {
    term: 'latency',
    plain: 'How long a message takes to arrive.',
    more: 'Set it high and you will see one replica typing text that the others '
      + 'do not have yet.',
  },
  {
    term: 'jitter',
    plain: 'How uneven that delay is.',
    more: 'With jitter, messages take a different amount of time each. They still '
      + 'arrive in the order they were sent — a single connection cannot '
      + 'overtake itself.',
  },
  {
    term: 'drop',
    plain: 'Messages that vanish in transit.',
    more: 'A real connection does not silently lose messages — it resends them. '
      + 'This slider is a what-if, for seeing how each approach copes with no '
      + 'delivery guarantee at all.',
  },
  {
    term: 'partition',
    plain: 'The connection is cut, but nobody notices.',
    more: 'The replica still believes it is online. No error appears, nothing '
      + 'reconnects, and messages stop crossing in both directions. This is nastier '
      + 'than unplugging the cable, and it is the case people forget to design for.',
  },
  {
    term: 'heal',
    plain: 'Restore the connection and catch up.',
    more: 'Because a partition never actually closed the connection, nothing would '
      + 'ever trigger a catch-up on its own. Healing asks for one explicitly.',
  },
  {
    term: 'CRDT vs OT',
    plain: 'Two ways to stop concurrent edits from corrupting a document.',
    more: 'A CRDT lets every replica merge changes on its own, so both sides of a '
      + 'partition survive. OT makes the server the single authority, so a replica '
      + 'that was cut off is handed the server’s version and loses its own work. '
      + 'Neither is a bug; they are different trades.',
  },
  {
    term: 'frame',
    plain: 'One message on the wire.',
    more: 'The timeline lists every one of them, in both directions, for every '
      + 'replica — newest at the top.',
  },
  {
    term: '↑ and ↓',
    plain: 'Which way a message went.',
    more: '↑ is a message the replica sent out; ↓ is one it received. Every row '
      + 'in the timeline is one message, so these split it into what this replica '
      + 'said and what it was told.',
  },
  {
    term: 'presence',
    plain: 'Where everyone’s cursor is.',
    more: 'Hidden in the timeline by default. Cursors move constantly and would '
      + 'bury everything else.',
  },
  {
    term: 'op / ack / apply',
    plain: 'An edit, its receipt, and its rebroadcast.',
    more: 'OT only. A replica sends an op, the server answers ack with the revision '
      + 'number it assigned, and everyone else receives apply — already adjusted '
      + 'to fit the edits they have.',
  },
  {
    term: 'resync',
    plain: 'Here is the whole document, start again.',
    more: 'OT’s answer when a replica is too far behind to catch up incrementally. '
      + 'Anything the replica had not managed to send is discarded.',
  },
  {
    term: 'revision',
    plain: 'The server’s version number for the document.',
    more: 'OT only. It goes up by one for every edit the server accepts, and that '
      + 'order is the single thing all replicas agree on.',
  },
  {
    term: 'transform',
    plain: 'Adjusting an edit to fit edits that landed first.',
    more: 'If you both type at position 10 at once, the second edit has to move. '
      + 'The server view lists these, and marks the ones that had to move past real '
      + 'concurrent work.',
  },
  {
    term: 'state vector',
    plain: 'A short summary of what a replica already has.',
    more: 'CRDT only. A reconnecting replica sends this instead of the whole '
      + 'document, and gets back only what it is missing. Compare its size to the '
      + 'snapshot in the server panel — that gap is the entire point.',
  },
  {
    term: 'snapshot',
    plain: 'The complete document, as one message.',
    more: 'What OT has to send on every single resync, no matter how small the '
      + 'change was.',
  },
];

export function Glossary({ open, onToggle }) {
  return (
    <section className={`glossary wash wash-lime${open ? ' glossary-open' : ''}`}>
      <button
        className="glossary-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="glossary-q" aria-hidden="true">?</span>
        <span className="glossary-toggle-text">What do these words mean</span>
        <span className="glossary-caret" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <dl className="glossary-list">
          {TERMS.map((t) => (
            <div className="glossary-item" key={t.term}>
              <dt>{t.term}</dt>
              <dd>
                <b>{t.plain}</b>
                <span>{t.more}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
