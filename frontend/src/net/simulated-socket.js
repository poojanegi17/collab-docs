/**
 * A WebSocket that lies about the network.
 *
 * Wraps a real socket and delays, drops or black-holes frames in both
 * directions. Presents exactly the surface `YjsSync`/`OTSync` use
 * (`binaryType`, `readyState`, `send`, `close`, the four `on*` handlers), so
 * the sync layer neither knows nor cares that it is being lied to.
 *
 * This is why the transport was hand-written instead of pulling in
 * `y-websocket`: you cannot instrument a dependency you do not own.
 *
 * Two deliberate fidelity choices:
 *
 * 1. NO REORDERING. Jitter is applied by pushing each frame's release time
 *    forward from the previous one, never behind it. A single TCP connection
 *    does not deliver out of order, and pretending otherwise would break the
 *    OT client for a reason that cannot happen in production -- a fake bug is
 *    worse than no bug.
 *
 * 2. Drops are honest about being unrealistic. TCP retransmits; a real
 *    WebSocket does not silently lose frames. The drop control exists to show
 *    what each protocol does WITHOUT delivery guarantees, which is exactly the
 *    question you ask when you start thinking about multi-node fan-out over
 *    unreliable pub/sub. Label it as a thought experiment, not a simulation of
 *    TCP.
 *
 * `partitioned` is the interesting one: the socket stays OPEN and the client
 * believes it is connected, but nothing crosses in either direction. That is a
 * black-hole partition, and it is strictly nastier than a clean disconnect
 * because no error handler ever fires.
 */

export const defaultNetwork = () => ({
  latencyMs: 0,
  jitterMs: 0,
  dropRate: 0,
  partitioned: false,
});

export class SimulatedSocket {
  /**
   * @param {string} url
   * @param {{ config: ReturnType<typeof defaultNetwork>,
   *           onEvent?: (e: object) => void }} opts
   *   `config` is read live on every frame, so UI sliders take effect
   *   immediately rather than at the next connection.
   */
  constructor(url, { config, onEvent }) {
    this.config = config;
    this.onEvent = onEvent ?? (() => {});
    this.binaryType = 'arraybuffer';

    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;

    /** Release time of the last scheduled frame, per direction. */
    this._nextIn = 0;
    this._nextOut = 0;
    this._timers = new Set();
    this._closed = false;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = (e) => { this.emit('open'); this.onopen?.(e); };
    ws.onclose = (e) => { this._closed = true; this.emit('close'); this.onclose?.(e); };
    ws.onerror = (e) => this.onerror?.(e);
    ws.onmessage = (e) => this._inbound(e);
  }

  /**
   * Deliberately reports the REAL socket state. While partitioned the client
   * must go on believing it is connected -- that is the whole point.
   */
  get readyState() { return this._ws.readyState; }

  send(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (this._blocked()) {
      this.emit('drop', { dir: 'out', bytes: bytes.length, data: bytes });
      return;
    }
    this._schedule('out', () => {
      if (this._ws.readyState === 1) this._ws.send(bytes);
    }, () => this.emit('frame', { dir: 'out', bytes: bytes.length, data: bytes }));
  }

  _inbound(event) {
    const bytes = new Uint8Array(event.data);
    if (this._blocked()) {
      this.emit('drop', { dir: 'in', bytes: bytes.length, data: bytes });
      return;
    }
    this._schedule('in', () => {
      this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }, () => this.emit('frame', { dir: 'in', bytes: bytes.length, data: bytes }));
  }

  _blocked() {
    const { partitioned, dropRate } = this.config;
    return partitioned || (dropRate > 0 && Math.random() < dropRate);
  }

  /**
   * Queue `fn` after the configured delay, preserving FIFO order within the
   * direction. `releaseAt` is clamped forward from the previous frame so
   * jitter never lets a later frame overtake an earlier one.
   */
  _schedule(dir, fn, announce) {
    const { latencyMs, jitterMs } = this.config;
    const delay = latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);

    const key = dir === 'in' ? '_nextIn' : '_nextOut';
    const now = performance.now();
    const releaseAt = Math.max(now + delay, this[key]);
    this[key] = releaseAt;

    const wait = releaseAt - now;
    if (wait <= 0) { announce(); fn(); return; }

    const timer = setTimeout(() => {
      this._timers.delete(timer);
      if (this._closed) return;
      announce();
      fn();
    }, wait);
    this._timers.add(timer);
  }

  close() {
    this._closed = true;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this._ws.close();
  }

  emit(kind, detail = {}) {
    this.onEvent({ kind, at: Date.now(), ...detail });
  }
}
