# Definition of done

What the sync layer has to do before anything built on top of it means
anything. Every line is automated -- `tools/checklist.mjs` and
`tools/restart-test.mjs` for the list below, plus the harnesses named in each
section.

## Convergence

- [x] Two clients typing at the same offset simultaneously converge, neither
      loses a character
- [x] A third, passive client agrees with both

## Durability

- [x] Server `SIGKILL`ed with clients connected, then restarted — all clients
      reconnect and converge automatically
- [x] Edits made *while the server was down* land after reconnect
- [x] A brand-new client loads the document from storage, not from a peer

## Offline

- [x] A disconnected client keeps editing locally
- [x] All 20 offline edits land on reconnect
- [x] Edits others made while you were offline survive the merge

## Delta sync — the interesting one

- [x] A late joiner receives the full document
- [x] An already-up-to-date client that reconnects transfers bytes proportional
      to *what changed*, not to document size. Currently ~27x smaller than the
      document, and the ratio grows as the document grows.

## Presence

- [x] Peer cursors and selections are visible, named and coloured
- [x] A peer's cursor disappears promptly when they close the tab

## OT engine

Transform laws (`tools/ot-properties.mjs`, 8,000 random assertions):

- [x] TP1 convergence — `a` then `b'` equals `b` then `a'`
- [x] TP1 as a composition identity — `a.compose(b')` equals `b.compose(a')`
- [x] Compose law — applying `a` then `b` equals applying `a.compose(b)`
- [x] JSON serialisation round-trips

System behaviour (`tools/ot-checklist.mjs`):

- [x] Concurrent same-offset inserts converge, nothing lost
- [x] Concurrent *identical* deletes remove the text once, not twice
- [x] An insert inside a concurrently-deleted range survives
- [x] 50 rapid local edits collapse into one buffered op, not 50 queued ops
- [x] 150 interleaved edits across 3 clients converge
- [x] Document survives `SIGKILL` and restart
- [x] Late joiner receives the document

## Tabs and tasks

Not convergence criteria — a tab is a document, so convergence inside one
is the same property already checked above. What is listed here is the part
that could only be got wrong at the boundary
(`tools/tabs-tasks-test.mjs`, both engines; `tools/tabs-tasks-ui-test.mjs`,
real Chrome):

- [x] Adding a tab leaves the first tab's text, log and history untouched
- [x] A tab's text is invisible from its sibling and from the document
- [x] Both tabs survive `SIGKILL` and restart, each from its own log
- [x] Sharing the document shares every tab, with no per-tab grant
- [x] A stranger is refused; a tab id that was never minted is refused
- [x] A viewer can read the task list and cannot tick anything
- [x] The task list is identical from every tab, and a change in one tab is
      pushed to the rooms of all of them
- [x] A task added by one person can be ticked by another, with their name
      recorded against it
- [x] Deleting the tab somebody else is reading moves them to a real tab
      instead of stranding them on a refused socket

## Running them

```bash
npm run dev:server           # terminal 1
node tools/checklist.mjs     # terminal 2
```

`restart-test.mjs` starts and kills its own server on port 8099, so it can run
alongside the dev server:

```bash
node tools/restart-test.mjs
```
