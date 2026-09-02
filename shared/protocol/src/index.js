/**
 * Engine-agnostic wire protocol.
 *
 * The single most important property of this file: it knows NOTHING about Yjs,
 * OT, or any other concurrency-control scheme. The envelope carries an opaque
 * payload that only a DocEngine (server) / EditorSync (client) understands.
 *
 * That is the seam that lets us add an OT engine later without touching the
 * transport, the storage layer, or presence.
 *
 *   +---------+---------------------------+
 *   | type u8 |        payload ...        |
 *   +---------+---------------------------+
 *
 * Presence/awareness is deliberately its OWN message type rather than being
 * folded into the engine payload: cursors must work identically under CRDT and
 * OT, and they are ephemeral (never persisted, lossy on purpose).
 */

/** Opaque engine payload. Only the active DocEngine can interpret it. */
export const MSG_ENGINE = 0;
/** Ephemeral presence state (cursors, selections, user identity). Never persisted. */
export const MSG_AWARENESS = 1;
/** Server -> client, once, right after the socket opens. JSON. */
export const MSG_HELLO = 2;
/** Either direction. JSON. Used by the debug/inspector view. */
export const MSG_DEBUG = 3;
/**
 * Server -> client. JSON. Comment threads changed, or their anchors moved.
 *
 * Its own message type rather than part of the engine payload, for the same
 * reason presence is: comments must work identically under both engines, and
 * only ONE of the two has anything engine-shaped to say about them. Under OT
 * this frame carries authoritative anchor positions the server just computed;
 * under the CRDT it carries no positions at all, because there are none to
 * carry -- the anchors are relative and every client resolves its own
 * (ADR-012).
 */
export const MSG_COMMENTS = 4;
/**
 * Server -> client. JSON. The document's task list changed; re-read it.
 *
 * Carries no task data, only the fact that something moved. That is
 * deliberate: the list is small, it is fetched over HTTP anyway, and a frame
 * carrying rows would be a second copy of the truth that can disagree with the
 * first. The same shape as MSG_COMMENTS, for the same reason (ADR-015).
 */
export const MSG_TASKS = 5;
/**
 * Server -> client. JSON. The document's tab list changed.
 *
 * Tabs are not content -- a tab's content is a document of its own, with its
 * own room and its own engine (ADR-014). What travels here is the list: a tab
 * was added, renamed, moved or deleted. Every room in the document's family
 * gets it, because a person reading tab three still has to see that tab one
 * was renamed.
 */
export const MSG_TABS = 6;

export const MSG_NAMES = {
  [MSG_ENGINE]: 'ENGINE',
  [MSG_AWARENESS]: 'AWARENESS',
  [MSG_HELLO]: 'HELLO',
  [MSG_DEBUG]: 'DEBUG',
  [MSG_COMMENTS]: 'COMMENTS',
  [MSG_TASKS]: 'TASKS',
  [MSG_TABS]: 'TABS',
};

/** Engines we can be configured with. The OT one is not implemented yet. */
export const ENGINE_YJS = 'yjs';
export const ENGINE_OT = 'ot';

/**
 * Wrap an opaque payload in the envelope.
 * @param {number} type one of MSG_*
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function encode(type, payload = new Uint8Array(0)) {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/**
 * @param {Uint8Array|ArrayBuffer|Buffer} data
 * @returns {{ type: number, payload: Uint8Array }}
 */
export function decode(data) {
  const bytes = toBytes(data);
  if (bytes.length === 0) throw new Error('empty frame');
  return { type: bytes[0], payload: bytes.subarray(1) };
}

export function encodeJson(type, value) {
  return encode(type, new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJson(payload) {
  return JSON.parse(new TextDecoder().decode(payload));
}

/** Normalise the several byte-ish things ws/browsers hand us. */
export function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) {
    // ws can deliver a fragmented message as an array of Buffers.
    const total = data.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of data) { out.set(toBytes(c), off); off += c.length; }
    return out;
  }
  throw new Error('unsupported frame type: ' + Object.prototype.toString.call(data));
}
