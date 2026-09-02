/**
 * Turn a raw wire frame into something readable in the timeline.
 *
 * The lab sees every byte in both directions, and this is what turns those
 * bytes into rows. It reaches into both sub-protocols on purpose -- an
 * observability tool is allowed to know about every engine, precisely because
 * nothing depends on it.
 */
import { MSG_ENGINE, MSG_AWARENESS, MSG_HELLO, MSG_DEBUG, decode } from '@collab/protocol';
import { Y_SYNC_STEP1, Y_SYNC_STEP2, Y_UPDATE, decodeYjs } from '@collab/protocol/yjs-wire';
import { decodeOt } from '@collab/protocol/ot-wire';

const YJS_LABELS = {
  [Y_SYNC_STEP1]: 'sync-step1',
  [Y_SYNC_STEP2]: 'sync-step2',
  [Y_UPDATE]: 'update',
};

/** Frames that are pure noise in a timeline you are trying to read. */
export const isNoise = (d) => d.kind === 'debug' || d.kind === 'presence';

/**
 * @param {Uint8Array} bytes
 * @param {'yjs'|'ot'} engine
 * @returns {{ kind: string, label: string, detail: string }}
 */
export function describeFrame(bytes, engine) {
  try {
    const { type, payload } = decode(bytes);

    switch (type) {
      case MSG_HELLO: return { kind: 'hello', label: 'hello', detail: '' };
      case MSG_DEBUG: return { kind: 'debug', label: 'debug', detail: '' };
      case MSG_AWARENESS: return { kind: 'presence', label: 'presence', detail: 'cursor' };

      case MSG_ENGINE: {
        if (engine === 'ot') {
          const msg = decodeOt(payload);
          return {
            kind: msg.t,
            label: msg.t,
            detail: describeOt(msg),
          };
        }
        const { subtype, bytes: body } = decodeYjs(payload);
        return {
          kind: YJS_LABELS[subtype] ?? `yjs:${subtype}`,
          label: YJS_LABELS[subtype] ?? `yjs:${subtype}`,
          detail: `${body.length} B payload`,
        };
      }

      default:
        return { kind: 'unknown', label: `type ${type}`, detail: '' };
    }
  } catch {
    return { kind: 'undecodable', label: 'undecodable', detail: `${bytes.length} B` };
  }
}

/**
 * `doc` is a list of runs -- `[{ text, attributes? }]` -- not a string. It has
 * been that shape since ADR-006, and reading `msg.text` here meant every init
 * and resync row reported `0 chars`: the one number you actually want at the
 * moment the server replaces your document.
 */
const docChars = (doc) =>
  Array.isArray(doc) ? doc.reduce((n, run) => n + (run?.text?.length ?? 0), 0) : 0;

function describeOt(msg) {
  switch (msg.t) {
    case 'op': return `base rev ${msg.rev} · ${summariseOps(msg.ops)}`;
    case 'ack': return `now rev ${msg.rev}`;
    case 'apply': return `rev ${msg.rev} · ${summariseOps(msg.ops)}`;
    case 'init': return `rev ${msg.rev} · ${docChars(msg.doc)} chars`;
    case 'resync': return `rev ${msg.rev} · ${docChars(msg.doc)} chars (pending work discarded)`;
    case 'sync': return 'anti-entropy request';
    default: return '';
  }
}

/**
 * `[{r:2},{i:"y"},{d:3}]` -> `retain 2, insert "y", delete 3`
 *
 * Components are tagged objects -- `{r,a}` retain, `{i,a}` insert, `{d}`
 * delete -- and have been since ADR-006. This read them as the plain numbers
 * and strings of the version before that, so every delete rendered as
 * `delete NaN` and every retain silently fell through to the delete branch.
 * The timeline was describing a wire format the product had already left.
 *
 * Attribute changes are called out rather than folded into the retain they
 * ride on. A retain carrying `a` is the entire mechanism by which formatting
 * survives concurrency (ADR-006) -- rendering it as a bare `retain 5` hides
 * the one thing worth watching.
 */
function summariseOps(ops) {
  if (!Array.isArray(ops)) return '';
  return ops.map((c) => {
    if (c == null || typeof c !== 'object') return String(c);
    if (typeof c.i === 'string') {
      const text = c.i.length > 12 ? c.i.slice(0, 12) + '…' : c.i;
      return `insert ${JSON.stringify(text)}${fmtAttrs(c.a)}`;
    }
    if (typeof c.d === 'number') return `delete ${c.d}`;
    if (typeof c.r === 'number') return `retain ${c.r}${fmtAttrs(c.a)}`;
    return JSON.stringify(c);
  }).join(', ');
}

/** `{ b: true, i: null }` -> ` +b -i`. Null is how an attribute is removed. */
function fmtAttrs(a) {
  if (!a) return '';
  const parts = Object.entries(a).map(([k, v]) => (v == null || v === false ? `-${k}` : `+${k}`));
  return parts.length ? ` ${parts.join(' ')}` : '';
}
