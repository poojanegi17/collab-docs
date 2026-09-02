/**
 * Process-wide counters, for /api/health.
 *
 * A Room keeps its own `stats`, and those are the right thing for the debug
 * view -- but a room is destroyed when the last person leaves it, so anything
 * accumulated there describes only the rooms that happen to be open. These
 * survive, and they are what the landing page's convergence counter reports:
 * how much work this node has actually done since it started.
 *
 * Deliberately counters and one bounded sample buffer. No labels, no
 * per-document breakdown: an observability stack is out of scope, and this is
 * five integers, a start time and 256 floats, not the thin end of one.
 *
 * The sample buffer is a documented exception to "counters and nothing else",
 * and it is worth naming why. A mean latency is the one summary that reliably
 * hides the thing you care about: a relay that answers in 1ms 99 times and
 * 400ms once has a mean of 5ms and a real problem. p50 and p99 are order
 * statistics -- they cannot be derived from a running total, they need the
 * samples themselves. A fixed 256-entry ring is the smallest structure that
 * yields them, it never grows, and it is what the landing page reports.
 */
export const metrics = {
  startedAt: Date.now(),

  /** Engine updates persisted -- edits that changed a document. */
  updates: 0,

  /** Frames actually written to a socket. */
  framesOut: 0,

  /** Bytes actually written to a socket. */
  bytesOut: 0,

  /**
   * Frames that batching removed: what a naive relay would have sent, minus
   * what we did send. This is the number that makes the fix visible, so it is
   * measured rather than asserted.
   */
  framesSaved: 0,

  /** Rooms opened since boot, which is not the same as rooms open now. */
  roomsOpened: 0,

  /**
   * Relay latency samples, in milliseconds: how long this node takes from
   * having an edit in hand to having the outbound frames written.
   *
   * This is the server's share of keystroke-to-remote-paint and nothing more.
   * It excludes both network legs and the peer's render, because a server
   * cannot honestly measure either, and the label on the panel says "relay"
   * for exactly that reason.
   *
   * @type {number[]}
   */
  relay: [],
  relayAt: 0,
};

/** How many latency samples to keep. Fixed: the buffer must never grow. */
const RELAY_SAMPLES = 256;

/** Record one relay duration, overwriting the oldest sample when full. */
export function recordRelay(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  metrics.relay[metrics.relayAt % RELAY_SAMPLES] = ms;
  metrics.relayAt++;
}

/**
 * Nearest-rank percentile over the samples held right now.
 *
 * Sorts a copy on every call. That is O(n log n) on 256 numbers, on a route
 * polled every two seconds -- cheaper than maintaining a sorted structure, and
 * very much cheaper than being wrong about it.
 */
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
};

/** A snapshot, for the JSON API. */
export const readMetrics = () => ({
  updates: metrics.updates,
  framesOut: metrics.framesOut,
  bytesOut: metrics.bytesOut,
  framesSaved: metrics.framesSaved,
  roomsOpened: metrics.roomsOpened,
  uptimeMs: Date.now() - metrics.startedAt,
  // Rounded to a tenth of a millisecond. More digits than that would be
  // reporting scheduler noise as though it were signal.
  relayP50: round(percentile(metrics.relay, 50)),
  relayP99: round(percentile(metrics.relay, 99)),
  relaySamples: metrics.relay.length,
});

const round = (n) => (n === null ? null : Number(n.toFixed(2)));
