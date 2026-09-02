import React from 'react';
import { engineLabel } from './identity.js';

/**
 * The reason this project has a UI at all.
 *
 * Everything here is already flowing through the sync layer or the MSG_DEBUG
 * round-trip -- the panel just renders it. The values worth watching:
 *
 *   sync.last     bytes received during the last initial sync. Compare it to
 *                 the document size: that gap is the state-vector handshake
 *                 earning its keep, and it widens as the document grows.
 *   log           loose updates stacked on the snapshot. Watch it climb while
 *                 you type and reset when compaction fires.
 *   state         under OT, the client machine. Type fast and you will see it
 *                 sit in awaitingWithBuffer while an ack is outstanding.
 */

const fmtBytes = (n = 0) =>
  n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
  : `${n} B`;

function Row({ label, value, accent, title }) {
  return (
    <div className="row" title={title}>
      <span>{label}</span>
      <span className={`row-value${accent ? ' row-value-accent' : ''}`}>{value}</span>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

const OT_STATES = [
  ['synchronized', 'nothing in flight'],
  ['awaitingConfirm', 'one op awaiting ack'],
  ['awaitingWithBuffer', 'one in flight, one buffered'],
];

export function Inspector({ open, engine, status, stats, peers, ot, server }) {
  if (!open) return <aside className="inspector inspector-collapsed" aria-hidden="true" />;

  const docChars = stats.docLength ?? 0;
  const loose = server?.looseUpdates ?? 0;
  const compactAfter = server?.compactAfter ?? 200;

  return (
    <aside className="inspector">
      <Section title="ENGINE">
        <Row label="type" value={engineLabel(engine)} accent title={engine} />
        <Row label="document" value={`${docChars} chars`} />
        {engine === 'ot' && ot && (
          <>
            <Row label="revision" value={ot.rev} />
            <div className="machine">
              {OT_STATES.map(([name, description]) => (
                <div
                  key={name}
                  className={`machine-state${ot.state === name ? ' machine-state-active' : ''}`}
                  title={description}
                >
                  <span className="machine-dot" />
                  {name}
                </div>
              ))}
            </div>
            {ot.outstanding && (
              <div className="op-preview" title="The operation currently awaiting acknowledgement">
                ↑ {ot.outstanding}
              </div>
            )}
            {ot.buffered && (
              <div className="op-preview" title="Local edits composed into a single buffered operation">
                ⧗ {ot.buffered}
              </div>
            )}
          </>
        )}
        {engine === 'yjs' && server?.engine && (
          <>
            <Row label="state vector" value={fmtBytes(server.engine.stateVectorBytes)}
              title="What the client sends on reconnect so the server can compute a delta" />
            <Row label="snapshot" value={fmtBytes(server.engine.snapshotBytes)}
              title="Full encoded document state on the server" />
            <Row label="replicas" value={server.engine.clients}
              title="Distinct Yjs client ids that have ever contributed to this document" />
          </>
        )}
      </Section>

      <Section title="SYNC">
        <Row label="status" value={status} />
        <Row
          label="last sync"
          value={fmtBytes(stats.lastSyncRecv)}
          accent
          title="Bytes received during the last initial sync. Compare with document size."
        />
        <Row label="sent" value={fmtBytes(stats.bytesSent)} />
        <Row label="received" value={fmtBytes(stats.bytesRecv)} />
      </Section>

      <Section title={`PEERS (${peers.size})`}>
        {peers.size === 0 && <div className="empty">no one else here</div>}
        {[...peers.entries()].map(([id, p]) => (
          <div className="peer-row" key={id}>
            <span className="peer-swatch" style={{ background: p.user?.color ?? '#888' }} />
            <span className="peer-name">{p.user?.name ?? id}</span>
            <span className="peer-pos">
              {p.cursor ? (p.cursor.anchor === p.cursor.head
                ? `@${p.cursor.head}`
                : `${Math.min(p.cursor.anchor, p.cursor.head)}–${Math.max(p.cursor.anchor, p.cursor.head)}`) : '—'}
            </span>
          </div>
        ))}
      </Section>

      <Section title="STORAGE">
        {!server && <div className="empty">waiting for server…</div>}
        {server && (
          <>
            <Row
              label="log"
              value={`${loose}/${compactAfter}`}
              title="Loose updates stacked on the snapshot. Compaction folds them in at the threshold."
            />
            <div className="meter">
              <div className="meter-fill" style={{ width: `${Math.min(100, (loose / compactAfter) * 100)}%` }} />
            </div>
            <Row label="sequence" value={server.currentSeq} title="Append-only log position" />
            <Row label="compactions" value={server.stats?.compactions ?? 0} />
            <Row label="persisted" value={server.stats?.updatesPersisted ?? 0} />
          </>
        )}
      </Section>

      <Section title="SERVER">
        {!server && <div className="empty">waiting for server…</div>}
        {server && (
          <>
            <Row label="online" value={server.online?.length ?? 0} />
            <Row label="in" value={fmtBytes(server.stats?.bytesIn)} />
            <Row label="out" value={fmtBytes(server.stats?.bytesOut)} />
          </>
        )}
      </Section>

      <div className="hint">
        Click the status pill to go offline, keep typing, then come back online.
        Watch <strong>last sync</strong> — it is the delta, not the document.
      </div>
    </aside>
  );
}
