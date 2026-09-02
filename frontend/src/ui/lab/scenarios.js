/**
 * Scripted runs of the lab.
 *
 * The demonstration this page exists for -- partition two replicas, type in
 * both, heal, watch CRDT merge where OT discards -- is a five-step manual
 * dance, and performed by hand under time pressure half its value goes to
 * fumbling: healing before both sides have typed, forgetting to clear the
 * timeline first, typing so fast the frames are unreadable.
 *
 * A scenario is a list of steps run against a small context object. It drives
 * the SAME controls a person drives -- the network config the socket reads,
 * and the real editor view -- so a scripted run and a manual one are the same
 * run. Nothing here reaches into the sync layer to fake a result.
 *
 * Each step is announced before it acts, so the UI can narrate what is about
 * to happen rather than reporting what already did.
 */

/** A cancellable sleep. Rejects with `CANCELLED` if the run is aborted. */
export const CANCELLED = Symbol('scenario cancelled');

/**
 * Type `text` into a replica through its real editor view.
 *
 * Character at a time, on a human-ish cadence. Pasting the whole string
 * arrives as one op, and one op is exactly the case where OT and CRDT look
 * identical -- the interesting behaviour needs concurrent, interleaved edits.
 */
async function typeInto(client, text, ctx, perChar = 45) {
  const view = client.viewRef.current;
  if (!view) return;
  for (const ch of text) {
    if (ctx.cancelled()) throw CANCELLED;
    const at = view.state.doc.length;
    view.dispatch({
      changes: { from: at, insert: ch },
      selection: { anchor: at + ch.length },
      scrollIntoView: true,
    });
    await ctx.wait(perChar);
  }
}

export const SCENARIOS = [
  {
    id: 'partition-diverge-heal',
    label: 'partition · diverge · heal',
    needs: 2,
    /**
     * The comparison the whole lab is built around. Run it once per engine and
     * the difference is not an argument, it is two timelines.
     */
    blurb: 'Both replicas edit while cut off, then reconnect. CRDT merges; OT discards.',
    steps: [
      {
        say: 'Clean slate: network reset, timeline cleared',
        async run(ctx) {
          ctx.setNetwork({ latencyMs: 0, jitterMs: 0, dropRate: 0, partitioned: false });
          ctx.clearEvents();
          await ctx.wait(600);
        },
      },
      {
        say: 'alice types a shared opening line',
        async run(ctx) {
          await typeInto(ctx.replica(0), 'Shared opening. ', ctx);
          // Let it land everywhere before cutting the wire, or the "shared"
          // prefix is not actually shared and the merge proves nothing.
          await ctx.wait(1200);
        },
      },
      {
        say: 'Partition both replicas -- sockets stay open, nothing crosses',
        async run(ctx) {
          ctx.setNetwork({ partitioned: true });
          await ctx.wait(700);
        },
      },
      {
        say: 'Both replicas edit, each believing it is still connected',
        async run(ctx) {
          // Concurrently, not in turn. Sequential edits under a partition are
          // still concurrent to the engines, but running them at the same time
          // is what the timeline should show.
          await Promise.all([
            typeInto(ctx.replica(0), 'ALICE-while-split. ', ctx),
            typeInto(ctx.replica(1), 'BOB-while-split. ', ctx),
          ]);
          await ctx.wait(600);
        },
      },
      {
        say: 'Heal, and force an anti-entropy pass',
        async run(ctx) {
          ctx.healAll();
          await ctx.wait(2000);
        },
      },
      {
        say: 'Settled. Compare the panes.',
        async run(ctx) { await ctx.wait(400); },
      },
    ],
  },

  {
    id: 'slow-link',
    label: 'slow link',
    needs: 2,
    blurb: 'Half a second of latency each way, with jitter. Watch cursors lag the text.',
    steps: [
      {
        say: 'Clean slate',
        async run(ctx) {
          ctx.setNetwork({ latencyMs: 0, jitterMs: 0, dropRate: 0, partitioned: false });
          ctx.clearEvents();
          await ctx.wait(400);
        },
      },
      {
        say: 'Both links to 500ms, 250ms jitter',
        async run(ctx) {
          ctx.setNetwork({ latencyMs: 500, jitterMs: 250 });
          await ctx.wait(500);
        },
      },
      {
        say: 'Both replicas type into the same region',
        async run(ctx) {
          await Promise.all([
            typeInto(ctx.replica(0), 'aaaa ', ctx, 120),
            typeInto(ctx.replica(1), 'bbbb ', ctx, 120),
          ]);
          await ctx.wait(2500);
        },
      },
      {
        say: 'Settled, despite arriving out of step',
        async run(ctx) { await ctx.wait(400); },
      },
    ],
  },

  {
    id: 'lossy',
    label: 'lossy link',
    needs: 2,
    /**
     * Honest framing, matching the note in simulated-socket.js: a real
     * WebSocket does not silently lose frames. This asks what each protocol
     * does WITHOUT delivery guarantees, which is the question you reach when
     * you start thinking about fan-out over unreliable pub/sub.
     */
    blurb: 'Drop 30% of frames. A thought experiment about fan-out, not a model of TCP.',
    steps: [
      {
        say: 'Clean slate',
        async run(ctx) {
          ctx.setNetwork({ latencyMs: 0, jitterMs: 0, dropRate: 0, partitioned: false });
          ctx.clearEvents();
          await ctx.wait(400);
        },
      },
      {
        say: 'Drop 30% of frames in both directions',
        async run(ctx) {
          ctx.setNetwork({ dropRate: 0.3, latencyMs: 120 });
          await ctx.wait(400);
        },
      },
      {
        say: 'alice types through the loss',
        async run(ctx) {
          await typeInto(ctx.replica(0), 'lossy link test. ', ctx, 70);
          await ctx.wait(1500);
        },
      },
      {
        say: 'Repair the link and resync',
        async run(ctx) {
          ctx.setNetwork({ dropRate: 0 });
          ctx.healAll();
          await ctx.wait(1500);
        },
      },
    ],
  },
];

/**
 * Run a scenario, announcing each step before it acts.
 *
 * Returns a `{ promise, cancel }` pair rather than a bare promise: a run takes
 * ten seconds or so, and the person watching must be able to grab the wheel
 * back without reloading the page.
 */
export function runScenario(scenario, ctx, onStep) {
  let cancelled = false;
  const timers = new Set();

  const wait = (ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      timers.delete(t);
      cancelled ? reject(CANCELLED) : resolve();
    }, ms);
    timers.add(t);
  });

  const full = { ...ctx, wait, cancelled: () => cancelled };

  const promise = (async () => {
    for (let i = 0; i < scenario.steps.length; i++) {
      if (cancelled) throw CANCELLED;
      const step = scenario.steps[i];
      onStep({ index: i, total: scenario.steps.length, say: step.say });
      await step.run(full);
    }
    onStep(null);
  })().catch((err) => {
    if (err !== CANCELLED) throw err;
    onStep(null);
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
