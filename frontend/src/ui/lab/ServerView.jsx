import React, { useEffect, useState } from 'react';

/**
 * The room's own view of the document.
 *
 * Every other panel on this page is client-observed: the timeline shows what
 * each replica put on the wire and what it got back, which is exactly the
 * information a replica has and no more. That is the right default -- it is
 * the honest position -- but it leaves the ordering decisions invisible. Under
 * OT the server IS the source of truth: it picks the revision numbers and
 * transforms every op against the ones it already accepted, and none of that
 * is visible from a client except as its consequences.
 *
 * Nothing is added to the protocol for this. `MSG_DEBUG` asks a room to
 * describe itself, and this is a decoder for the answer.
 *
 * It polls rather than streams on purpose. A push channel for debug state
 * would be a second broadcast path to keep correct for the sake of a panel
 * nobody reads in production -- exactly the kind of observability creep this
 * project stays clear of. One request a second, from one replica.
 */

const POLL_MS = 1000;

/** Stale after this long without an answer -- see the partition note below. */
const STALE_MS = 3000;

const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} K` : `${n} B`);

export function ServerView({ clients, engine }) {
  const [debug, setDebug] = useState(null);
  const [at, setAt] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    const off = clients.map((c) => c.sync.on('debug', (d) => {
      setDebug(d);
      setAt(Date.now());
    }));

    const poll = () => {
      /*
       * Ask through a replica that is not partitioned.
       *
       * A partitioned socket swallows the request AND the answer, so polling
       * through one would make the server look dead when it is perfectly
       * healthy. When EVERY replica is cut off there is no channel left and
       * this panel goes stale -- which is correct, and worth seeing: during a
       * partition the clients genuinely cannot know what the server thinks.
       */
      const via = clients.find((c) => !c.net.partitioned && c.sync.status !== 'offline');
      via?.sync.requestDebug();
      tick((n) => n + 1);
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { clearInterval(timer); off.forEach((fn) => fn()); };
  }, [clients]);

  const stale = !debug || Date.now() - at > STALE_MS;
  const eng = debug?.engine;

  return (
    <section className="server-view">
      <header className="server-head wash-sky">
        <div className="panel-title">
          <h2 className="section-title">SERVER</h2>
          <span className="panel-sub">what the server itself knows</span>
        </div>
        {/*
          Says WHY it is stale, not just that it is. "Stale" alone reads as a
          bug in the panel; "every replica is partitioned" is the demo working.
        */}
        {stale && (
          <span className="server-stale">
            {clients.every((c) => c.net.partitioned)
              ? 'every replica partitioned — no channel to ask'
              : 'no answer'}
          </span>
        )}
      </header>

      <div className={`server-body${stale ? ' server-body-stale' : ''}`}>
        {!debug && <div className="empty">Waiting for the room to answer.</div>}

        {debug && (
          <>
            <Row
              label="room"
              value={debug.docId}
              title="The document every replica on this page is connected to"
            />
            <Row
              label="online"
              value={`${debug.online?.length ?? 0} connections`}
              title="Open connections to this document. Each replica is one."
            />
            <Row
              label="seq"
              value={debug.currentSeq}
              title="How many edits the server has written down for this document, ever"
            />
            <Row
              label="loose"
              value={`${debug.looseUpdates} / ${debug.compactAfter} to compaction`}
              title="Edits stored one by one. At the limit they are squashed into a single snapshot to keep the log short."
            />
            <Row
              label="persisted"
              value={`${debug.stats?.updatesPersisted ?? 0} updates`}
              title="Edits written to the database since this room opened"
            />
            <Row
              label="compactions"
              value={debug.stats?.compactions ?? 0}
              title="Times the stored edits have been squashed into a snapshot"
            />
            <Row
              label="room I/O"
              value={`↓${fmtBytes(debug.stats?.bytesIn ?? 0)} ↑${fmtBytes(debug.stats?.bytesOut ?? 0)}`}
              title="Bytes the server has received and sent for this document"
            />

            <div className="server-sep">{engine === 'ot' ? 'OT ENGINE' : 'CRDT ENGINE'}</div>

            {engine === 'ot' ? (
              <>
                <Row
                  label="rev"
                  value={eng?.rev}
                  title="The server's version number. It goes up by one for every edit accepted, and that order is the one thing all replicas agree on."
                />
                <Row
                  label="history"
                  value={`${eng?.historyDepth} ops, base ${eng?.historyBase}`}
                  title="Recent edits the server still remembers, so it can adjust a late edit to fit them. A replica older than the base is too far behind and gets sent the whole document instead."
                />
                <Row
                  label="doc"
                  value={`${eng?.length} chars, ${eng?.runs} runs`}
                  title="The server's copy: its length, and how many differently-formatted stretches it is made of"
                />
              </>
            ) : (
              <>
                <Row
                  label="doc"
                  value={`${eng?.length} chars`}
                  title="Length of the server's copy of the document"
                />
                <Row
                  label="state vector"
                  value={fmtBytes(eng?.stateVectorBytes ?? 0)}
                  title="A short summary a replica sends to say what it already has. Compare it to the snapshot below — that gap is why a CRDT reconnect is cheap."
                />
                <Row
                  label="snapshot"
                  value={fmtBytes(eng?.snapshotBytes ?? 0)}
                  title="The whole document as one message. This is what OT has to send on every reconnect, no matter how small the change was."
                />
                <Row
                  label="crdt clients"
                  value={eng?.clients}
                  title="How many distinct editors the CRDT is tracking. It only ever grows — that is the price of being able to merge without a server deciding."
                />
              </>
            )}

            {eng?.preview != null && (
              <div className="server-preview" title="The server's copy of the text">
                {eng.preview || <span className="server-empty">(empty)</span>}
              </div>
            )}

            {/*
              The ordering decisions themselves. Each entry is one op the
              server accepted, the revision it was based on, and how many
              already-accepted ops it had to be transformed against before it
              could be applied. A non-zero `transformedAgainst` is a real
              concurrent edit being resolved -- the thing OT is for, which is
              otherwise entirely invisible from a client.
            */}
            {engine === 'ot' && eng?.recentTransforms?.length > 0 && (
              <>
                <div className="server-sep" title="Each row is one edit the server accepted, and what it had to do to make it fit">
                  TRANSFORMS
                </div>
                <div className="xform-list">
                  {[...eng.recentTransforms].reverse().map((t, i) => (
                    <div
                      key={`${t.rev}-${i}`}
                      className={`xform${t.transformedAgainst > 0 ? ' xform-hot' : ''}`}
                    >
                      <span className="xform-rev">r{t.rev}</span>
                      <span className="xform-by">{t.by?.split('-')[0]}</span>
                      <span className="xform-base">base {t.baseRev}</span>
                      <span
                        className="xform-against"
                        title="How many edits landed first, that this one had to be adjusted around. A number here means two people really did type at once."
                      >
                        {t.transformedAgainst > 0 ? `×${t.transformedAgainst}` : '—'}
                      </span>
                      <span className="xform-op">{t.op}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Row({ label, value, title }) {
  return (
    <div className="server-row" title={title}>
      <span className="server-label">{label}</span>
      <span className="server-value">{value ?? '—'}</span>
    </div>
  );
}
