import React from 'react';
import { isNoise } from './describe-frame.js';

const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}`);

/**
 * Wall-clock, to the millisecond. The interesting quantities on this page are
 * all durations -- how long a partitioned replica sat silent, how far apart an
 * op and its ack landed -- and you cannot read a duration off rows that only
 * say what happened.
 */
const fmtTime = (at) => {
  const d = new Date(at);
  return `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    + `.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

/**
 * Every frame, both directions, all clients, newest first.
 *
 * Presence and debug frames are hidden by default. They are the overwhelming
 * majority of traffic (cursor moves fire at ~16/s per client) and they would
 * bury the handful of frames you actually came to look at.
 *
 * The timeline and the panes are two views of the same replicas, so they are
 * wired together: focusing a replica filters this list to it and highlights
 * its pane, and clicking any row focuses the replica that sent it. Without
 * that, reading eight interleaved conversations means matching colour
 * swatches by eye.
 */
export function Timeline({
  events, clients, showNoise, onToggleNoise, onClear, focus, onFocus, onExport,
}) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const focused = focus && byId.has(focus) ? focus : null;
  const visible = events.filter((e) =>
    (showNoise || !isNoise(e)) && (!focused || e.clientId === focused));

  return (
    <section className="timeline">
      <header className="timeline-head wash-blush">
        <div className="panel-title">
          <h2 className="section-title">TIMELINE</h2>
          {/*
            The arrows carry the single most important bit in every row --
            which way the message went -- so the key is spelled out rather than
            left to be inferred. It costs one line and removes the guess.
          */}
          <span className="panel-sub">
            every message, newest first
            {' · '}<b className="tl-key tl-key-out">&uarr;</b> sent by the replica
            {' · '}<b className="tl-key tl-key-in">&darr;</b> received by it
          </span>
        </div>
        <span className="timeline-count" title="Messages listed right now">
          {visible.length}
        </span>

        {/*
          Replica filter. `all` is a real option rather than "click the active
          chip again" because a filter you can only leave by guessing is not a
          filter.
        */}
        <div className="tl-filter" role="group" aria-label="Filter by replica">
          <button
            className={`tl-chip${focused ? '' : ' on'}`}
            aria-pressed={!focused}
            onClick={() => onFocus?.(null)}
          >
            all
          </button>
          {clients.map((c) => (
            <button
              key={c.id}
              className={`tl-chip${focused === c.id ? ' on' : ''}`}
              aria-pressed={focused === c.id}
              onClick={() => onFocus?.(focused === c.id ? null : c.id)}
            >
              <span className="tl-swatch" style={{ background: c.color }} />
              {c.name}
            </button>
          ))}
        </div>

        <div className="header-spacer" />
        <label className="timeline-toggle">
          <input type="checkbox" checked={showNoise} onChange={onToggleNoise} />
          <span title="Cursor positions. They fire constantly and would bury everything else.">
            show cursors
          </span>
        </label>
        <button
          className="lab-btn"
          onClick={onExport}
          disabled={events.length === 0}
          title="Download this run as JSON, including the network settings that produced it"
        >
          export
        </button>
        <button className="lab-btn" onClick={onClear}>clear</button>
      </header>

      <div className="timeline-body">
        {visible.length === 0 && (
          <div className="empty">
            {focused
              ? `Nothing from ${byId.get(focused)?.name ?? focused} yet.`
              : 'Nothing yet. Type in a pane, or partition one and watch the frames stop.'}
          </div>
        )}
        {visible.map((e) => {
          const client = byId.get(e.clientId);
          return (
            <div
              key={e.seq}
              className={`tl-row${e.dropped ? ' tl-dropped' : ''}`}
              role="button"
              tabIndex={0}
              title={`Focus ${client?.name ?? e.clientId}`}
              onClick={() => onFocus?.(focused === e.clientId ? null : e.clientId)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onFocus?.(focused === e.clientId ? null : e.clientId);
                }
              }}
            >
              <span className="tl-time">{fmtTime(e.at)}</span>
              <span className="tl-swatch" style={{ background: client?.color ?? '#666' }} />
              <span className="tl-client">{client?.name ?? e.clientId}</span>
              <span
                className={`tl-dir tl-dir-${e.dir}`}
                title={e.dir === 'out' ? 'sent by this replica' : 'received by this replica'}
                aria-label={e.dir === 'out' ? 'sent' : 'received'}
              >
                {e.dir === 'out' ? '↑' : '↓'}
              </span>
              <span className={`tl-kind tl-kind-${e.kind}`}>{e.label}</span>
              <span className="tl-detail">{e.detail}</span>
              <span className="tl-bytes">{fmtBytes(e.bytes)}</span>
              {e.dropped && <span className="tl-lost">lost</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
