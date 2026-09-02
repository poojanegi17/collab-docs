import { ENGINE_YJS, ENGINE_OT } from '@collab/protocol';
import { YjsEngine } from './yjs-engine.js';
import { OTEngine } from './ot-engine.js';

/**
 * @param {string} kind
 * @param {string} docId
 * @param {(bytes: Uint8Array) => void} persistUpdate
 */
export function createEngine(kind, docId, persistUpdate) {
  switch (kind) {
    case ENGINE_YJS:
      return new YjsEngine(docId, persistUpdate);
    case ENGINE_OT:
      return new OTEngine(docId, persistUpdate);
    default:
      throw new Error(`unknown engine: ${kind}`);
  }
}
