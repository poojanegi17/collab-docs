import React from 'react';

/**
 * Per-client network conditions.
 *
 * Mutates the live config object the SimulatedSocket reads on every frame, so
 * a slider takes effect on the next byte rather than the next connection.
 *
 * `partition` is the interesting control and deserves the emphasis: the socket
 * stays open and the client still believes it is connected, but nothing gets
 * through in either direction. No error fires, no reconnect is attempted, and
 * the replicas drift apart in silence. That is strictly nastier than pulling
 * the cable, and it is the failure mode people forget to design for.
 *
 * Every row carries a plain-English hint alongside the real term. The terms
 * stay -- latency and jitter are what these are called everywhere else, and
 * teaching someone "wobble" would help them here and nowhere -- but a slider
 * labelled only `jitter` tells a newcomer nothing about what dragging it will
 * do, and this page is mostly read by people meeting these ideas for the
 * first time.
 */

const ROWS = [
  {
    key: 'latencyMs',
    label: 'latency',
    hint: 'delay before each message arrives',
    min: 0, max: 2000, step: 50,
    format: (v) => `${v}ms`,
  },
  {
    key: 'jitterMs',
    label: 'jitter',
    hint: 'how uneven that delay is',
    min: 0, max: 1000, step: 25,
    format: (v) => `${v}ms`,
  },
  {
    key: 'dropRate',
    label: 'loss',
    hint: 'messages that vanish in transit',
    min: 0, max: 1, step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
  },
];

export function NetworkControls({ net, onChange, onHeal }) {
  const set = (key) => (e) => {
    net[key] = Number(e.target.value);
    onChange();
  };

  return (
    <div className="net">
      <div className="net-head">this replica&rsquo;s connection</div>

      {ROWS.map((row) => (
        <label className="net-row" key={row.key} title={row.hint}>
          <span className="net-label">
            {row.label}
            <i className="net-hint">{row.hint}</i>
          </span>
          <input
            type="range"
            min={row.min} max={row.max} step={row.step}
            aria-label={`${row.label} — ${row.hint}`}
            value={net[row.key]}
            onChange={set(row.key)}
          />
          <span className="net-value">{row.format(net[row.key])}</span>
        </label>
      ))}

      <button
        className={`net-partition${net.partitioned ? ' net-partition-on' : ''}`}
        aria-pressed={!!net.partitioned}
        onClick={() => {
          const healing = net.partitioned;
          net.partitioned = !net.partitioned;
          onChange();
          // Healing needs an explicit anti-entropy pass: the socket never
          // closed, so nothing else would ever trigger a resync and the
          // replicas would stay diverged forever.
          if (healing) onHeal();
        }}
        title={net.partitioned
          ? 'Reconnect this replica and make it catch up (heal the partition)'
          : 'Silently block this replica: the connection stays open and it still thinks it is online, but nothing gets through (partition)'}
      >
        {net.partitioned ? 'reconnect' : 'cut off'}
      </button>
    </div>
  );
}
