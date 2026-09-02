/**
 * Yjs sub-protocol -- lives INSIDE a MSG_ENGINE payload.
 *
 * Hand-written on purpose. We reuse Yjs as a CRDT *engine* (writing an RGA
 * from scratch is a rabbit hole), but the sync *protocol* is ~3 message types
 * and it is exactly the layer you want to have built yourself when you are
 * debugging a resync at 1am. This is also why we do not depend on y-websocket.
 *
 *   +------------+---------------------+
 *   | subtype u8 |     yjs bytes ...   |
 *   +------------+---------------------+
 *
 * Handshake -- a STEP1 always triggers the full two-way exchange:
 *   client --SYNC_STEP1(client state vector)--> server
 *   server --SYNC_STEP2(diff the client is missing)--> client
 *   server --SYNC_STEP1(server state vector)--> client
 *   client --SYNC_STEP2(diff the server is missing)--> server
 *   ...then both sides stream UPDATE for every local change.
 *
 * The two-way step1/step2 is the whole trick: neither side ever ships the full
 * document on reconnect, only the delta implied by the peer's state vector.
 *
 * Both directions matter. An exchange that only pulls leaves anything the
 * client wrote while it was cut off stranded on that replica -- which is
 * exactly what happens when a black-hole partition heals, since the socket
 * never closed and the client never rejoins. The same exchange therefore
 * serves as anti-entropy: `EditorSync.resync()` just sends a STEP1.
 */

export const Y_SYNC_STEP1 = 0; // payload = encoded state vector
export const Y_SYNC_STEP2 = 1; // payload = encoded update (reply to a step1)
export const Y_UPDATE = 2;     // payload = encoded update (unsolicited broadcast)

export const Y_SUBTYPE_NAMES = {
  [Y_SYNC_STEP1]: 'SYNC_STEP1',
  [Y_SYNC_STEP2]: 'SYNC_STEP2',
  [Y_UPDATE]: 'UPDATE',
};

export function encodeYjs(subtype, bytes) {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = subtype;
  out.set(bytes, 1);
  return out;
}

export function decodeYjs(payload) {
  if (payload.length === 0) throw new Error('empty yjs frame');
  return { subtype: payload[0], bytes: payload.subarray(1) };
}
