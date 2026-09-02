/**
 * OT sub-protocol -- lives INSIDE a MSG_ENGINE payload, exactly like
 * `yjs-wire.js`. The envelope does not know either of them exists.
 *
 * JSON rather than binary, deliberately: OT messages are small and infrequent
 * (one per edit burst, not one per character), and being able to read the
 * transform history straight out of devtools is worth far more than the bytes.
 * The op-visualisation view will consume exactly these messages.
 *
 * The protocol is server-authoritative, which is the fundamental difference
 * from the CRDT path:
 *
 *   server --INIT{rev, doc}-------------------> client   (on join)
 *   client --OP{rev, ops}---------------------> server   (rev = what it was based on)
 *   server --ACK{rev}-------------------------> sender   (your op is now revision `rev`)
 *   server --APPLY{rev, ops, by}--------------> others   (already transformed for them)
 *   server --RESYNC{rev, doc}-----------------> client   (your rev is too old to transform)
 *   client --SYNC{}---------------------------> server   (resend me the document)
 *
 * `doc` is a list of runs -- `[{ text, attributes? }]` -- not a string, and
 * `ops` are the tagged components of a RichTextOperation. Both changed shape
 * with ADR-006; neither changed meaning, and the message types did not move,
 * because formatting is carried on `retain` rather than by a new message.
 *
 * ACK is why `DocEngine.handleMessage` returns `{toSender, toOthers}` instead
 * of plain bytes. The CRDT engine never needs to reply to the sender; OT always
 * does. See ADR-002.
 */

export const OT_INIT = 'init';
export const OT_OP = 'op';
export const OT_ACK = 'ack';
export const OT_APPLY = 'apply';
export const OT_RESYNC = 'resync';
/**
 * Client -> server: "I may have missed messages, send me the document."
 * Needed because a black-hole partition never closes the socket, so nothing
 * else would ever trigger a re-sync. Answered with an INIT.
 */
export const OT_SYNC = 'sync';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @returns {Uint8Array} the engine payload (not yet enveloped) */
export function encodeOt(message) {
  return enc.encode(JSON.stringify(message));
}

export function decodeOt(payload) {
  return JSON.parse(dec.decode(payload));
}
