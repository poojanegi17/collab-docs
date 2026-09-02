import React, { useEffect, useState } from 'react';
import { Editor } from '../Editor.jsx';
import { NetworkControls } from './NetworkControls.jsx';

/**
 * One simulated participant: an editor, its connection state, and the network
 * conditions it is suffering under.
 *
 * Each pane owns a completely independent EditorSync with its own socket, so
 * this is not a mock -- it is N real clients that happen to share a browser
 * tab. Nothing here knows which engine it is driving.
 */
export function LabClient({ client, focused, onFocus, onRemove }) {
  const { sync, name, color, net } = client;

  const [status, setStatus] = useState(sync.status);
  const [peers, setPeers] = useState(new Map());
  const [stats, setStats] = useState(sync.stats);
  const [ot, setOt] = useState(null);
  const [, force] = useState(0);

  useEffect(() => {
    const off = [
      sync.on('status', setStatus),
      sync.on('peers', (p) => setPeers(new Map(p))),
      sync.on('doc', (s) => setStats({ ...s })),
      sync.on('synced', (s) => setStats({ ...s })),
      sync.on('ot', setOt),
    ];
    return () => off.forEach((fn) => fn());
  }, [sync]);

  /*
   * `net` is mutated in place so the socket sees changes on the next frame,
   * which means React is told about them out of band. Subscribing here rather
   * than re-rendering the whole lab is what keeps a slider drag from
   * re-rendering every other replica's editor.
   */
  useEffect(() => client.onNet(() => force((n) => n + 1)), [client]);

  const partitioned = net.partitioned;

  return (
    <div className={`pane wash wash-paper${partitioned ? ' pane-partitioned' : ''}${focused ? ' pane-focused' : ''}`}>
      {/*
        The head is washed in this replica's own colour. The swatch keys the
        pane to its timeline rows, but a 7px square is a lot to ask of someone
        scanning eight panes; the whole header carrying the hue is the same
        information at a glance. Kept very pale -- it sits behind mono text
        that has to stay readable.
      */}
      <header
        className="pane-head"
        style={{ background: `color-mix(in srgb, ${color} 14%, #fff)` }}
      >
        {/*
          The identity doubles as the focus control: pressing it filters the
          timeline to this replica. A real <button> wrapping only the name,
          rather than a role on the whole header -- the header also holds a
          close button, and a button inside a button is neither announceable
          nor clickable in the way either one wants.
        */}
        <button
          className="pane-id"
          aria-pressed={!!focused}
          title="Show only this replica's messages in the timeline"
          onClick={() => onFocus?.()}
        >
          <span className="tl-swatch" style={{ background: color }} />
          {/*
            "Replica" first, the name second. These panes are not different
            documents -- they are independent replicas of ONE document, each
            with its own socket and its own network conditions. A bare "alice"
            and "bob" read as two files, which is the single most common
            misreading of this page.
          */}
          <span className="pane-kind">replica</span>
          <span className="pane-name">{name}</span>
        </button>

        <div className="header-spacer" />

        {partitioned && (
          <span
            className="pane-warn"
            title="Partitioned: the connection is still open, but nothing is getting through in either direction"
          >
            cut off
          </span>
        )}
        {/* `status-*` stays on the wrapper: the dot colours are authored as
            `.status-synced .dot`, a descendant rule. */}
        <span
          className={`pane-status status-${status}`}
          title="What this replica believes about its connection"
        >
          <span className="dot" />
          {status}
        </span>

        {/*
          Without this, a slip of the finger on "+ replica" is permanent
          until you throw the whole document away. Hidden rather than disabled
          at the floor: a close button that never works is worse than no close
          button.
        */}
        {onRemove && (
          <button
            className="replica-close"
            aria-label={`Remove replica ${name}`}
            title={`Disconnect and close ${name}`}
            onClick={onRemove}
          >
            &times;
          </button>
        )}
      </header>

      <div className="pane-editor">
        <Editor sync={sync} peers={peers} viewRef={client.viewRef} compact />
      </div>

      <div className="pane-meta">
        <span title="Characters in this replica's copy of the document">
          {stats.docLength ?? 0} chars
        </span>
        <span title="Bytes this replica received the last time it caught up">
          &darr;{stats.lastSyncRecv ?? 0} B sync
        </span>
        {ot && (
          <span title="This replica's OT state: whether it is waiting for the server to confirm an edit, and which revision it is on">
            {ot.state} @{ot.rev}
          </span>
        )}
        <div className="header-spacer" />
        <span title="Other replicas this one can currently see">
          {peers.size} peer{peers.size === 1 ? '' : 's'}
        </span>
      </div>

      <NetworkControls
        net={net}
        onChange={client.notifyNet}
        onHeal={() => sync.resync()}
      />
    </div>
  );
}
