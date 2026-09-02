# Frontend

React + CodeMirror 6 + Vite. Three layers, mirroring the backend's seam.

```
ui/         React components, CodeMirror host   <- knows nothing about Yjs
ui/lab/     multi-replica lab + network sim     <- engine-aware, but nothing depends on it
net/        SimulatedSocket                     <- engine-agnostic
presence/   remote cursor rendering             <- engine-agnostic
sync/       socket + concurrency data structure <- the ONLY Yjs-aware layer
```

(The lab decodes both sub-protocols on purpose. An observability tool is
allowed to know about every engine precisely because nothing depends on it.)

The test of the design: `ui/Editor.jsx` and `ui/App.jsx` contain **zero**
`yjs` imports. They talk to the `EditorSync` interface. When `OTSync` exists,
`App.jsx` gains one branch and nothing else changes.

## `sync/` — the interesting layer

`sync/editor-sync.js` is the interface; `sync/yjs-sync.js` implements it.

`YjsSync` is deliberately **DOM-free**. Node 22+ ships a global `WebSocket`, so
the exact same class runs headlessly in `tools/checklist.mjs` — the harnesses
drive the real client over the real protocol rather than a mock. The CodeMirror
binding is therefore attached to the prototype at the bottom of the file with a
lazy `import()`, because `y-codemirror.next` pulls in `@codemirror/view`, which
needs a DOM.

### The sync handshake

```
client --SYNC_STEP1(client state vector)--> server
server --SYNC_STEP2(only what the client lacks)--> client   [client marks itself synced]
server --SYNC_STEP1(server state vector)--> client
client --SYNC_STEP2(only what the server lacks)--> server
...then both sides stream UPDATE on every local change
```

Two-way is the whole trick. Neither side ever ships the full document on
reconnect — only the delta implied by the peer's state vector. The status bar
reports `lastSyncRecv` specifically so this is visible: resyncing an
up-to-date client costs ~185 B against a 5000 B document.

### Reconnection

Exponential backoff, capped at 8s, with 50–100% jitter. Jitter matters: a
server restart drops every client at once, and synchronised retries would
hammer it on the way back up.

`connect()` resolves once synced and is safe to call at any time — if automatic
backoff already reconnected, it resolves immediately rather than waiting for a
sync that has already happened. That race (resolver registered *after* the sync
it was waiting for) was a real hang during development; it is why the class
keeps a `_syncWaiters` list rather than a single resolver.

`disconnect()` is not an error path — it is the offline-mode feature. It stops
the socket while leaving the local document fully editable.

### Echo suppression

The `doc.on('update')` handler checks `origin !== 'remote'`. Updates that
arrived from the network must not be sent straight back out, or two clients
will ping-pong a single edit forever.

### The OT client

`sync/ot-sync.js` implements the same `EditorSync` interface with the Jupiter
three-state machine:

| State | Meaning | A local edit does | A server op does |
|---|---|---|---|
| `SYNCHRONIZED` | nothing in flight | send it, go to `AWAITING_CONFIRM` | apply directly |
| `AWAITING_CONFIRM` | one op awaiting ack | becomes the buffer | transform against outstanding |
| `AWAITING_WITH_BUFFER` | one in flight, one buffered | **compose** into the buffer | transform against outstanding *and* buffer |

There is never more than one op in flight, and the buffer never becomes more
than one operation — `compose` collapses it. Type 50 characters while an ack is
outstanding and you send one op, not 50.

The transform argument order is load-bearing: the client's own op is always
argument `a`, matching the server. Get this backwards and inserts at a
contested position resolve differently on different replicas.

The CodeMirror binding converts both directions — `ChangeSet` to
`TextOperation` via `iterChanges`, and back via `{from, to, insert}` changes —
with a `remote` annotation as the echo guard. Without that annotation, applying
a remote op fires the update listener, which sends it straight back to the
server, forever.

Switch engines with `?engine=ot&server=ws://localhost:8081`. It is a page
reload, not a hot swap, by design (ADR-002).

## `presence/` — remote cursors

`remote-cursors.js` is a CodeMirror `ViewPlugin` producing decorations from a
plain `Map<clientId, {user, cursor}>`. No `yjs` import, so it survives the OT
switch untouched.

Outgoing cursor updates are throttled to 60ms in the sync layer, not in the
editor — the editor should not have to know about the network. They are lossy
on purpose: a dropped cursor frame is corrected by the next one.

**Known limitation, and an instructive one.** Positions are plain integer
offsets, clamped to the local document length. If a peer inserts text above
your caret, the remote caret we draw is stale until their next presence update
(~60ms). The proper fix is relative positions — `Y.RelativePosition` under
CRDT, offset transformation against the revision log under OT. The fact that
the two engines need *different* fixes is exactly why presence traffics in raw
offsets rather than either representation.

## `net/` and the lab

`net/simulated-socket.js` wraps a real `WebSocket` and presents exactly the
surface the sync layer uses, so `EditorSync` can be handed one through its
`socketFactory` option and never learn its network is a lie. This is the payoff
of hand-writing the transport: you cannot instrument a dependency you do not
own.

`ui/lab/` renders several **real** replicas in one page — each with its own
socket, its own network conditions, and its own editor. Nothing there is a mock.

- `Lab.jsx` — owns the replicas and the frame buffer. Frames arrive far faster
  than React should re-render, so they accumulate in a ref and flush on an
  animation frame; without that the timeline makes the editors stutter, which
  would be an ironic way to lose a latency demo.
- `NetworkControls.jsx` — mutates the live config object the socket reads per
  frame, so a slider takes effect on the next byte rather than the next
  connection.
- `Timeline.jsx` / `describe-frame.js` — decodes both sub-protocols. Presence
  and debug frames are hidden by default; at ~16 cursor updates per second per
  client they bury everything you came to look at.

See [ADR-005](decisions/005-network-simulation.md) for the fidelity choices,
and for the protocol bug the lab found within minutes of existing.

## `ui/`

- `App.jsx` — reads all session config off the URL, so opening N tabs *is* the
  demo. Owns the `EditorSync` instance and subscribes to its events. Tracks
  `wantOnline` (user intent) separately from `status` (socket reality); a
  toggle that branches on `status` treats a click during "reconnecting" as "go
  offline" and strands the tab until a reload.
- `Editor.jsx` — CodeMirror host. Mounts `sync.editorExtensions()` (async),
  pushes peer cursors in as a `StateEffect`, and publishes the local caret on
  every selection change. `compact` shrinks it for a lab pane.
- `Header.jsx` — document identity, who *this tab* is, the avatar stack, and
  the status pill. The pill's dot is socket state and its label is intent —
  deliberately two things, because conflating them caused the bug above.
- `identity.js` — what to call an engine, and what to call somebody with no
  account. Both were decided in two places and drifted, which is how the editor
  became the only surface calling the CRDT **YJS** (the name of a dependency,
  in front of somebody trying to write a document) and the only one calling an
  anonymous visitor **Grace**.

  The guest names were the worse of the two. A signed-out visitor was handed a
  real person's name — Ada, Grace, Alan — chosen by hashing the client id, and
  it appeared on their cursor, their avatar, their comments and the authorship
  tint. It is plausible enough to be believed: "Grace wrote this paragraph"
  reads as a fact about a person, and nothing on screen tells the reader it
  came from six random characters. A document with no account behind it has no
  authors — it has participants it cannot name.

  So they are numbered: **Unknown 1**, **Unknown 2**. The ordinal is picked
  from presence in `App.jsx` rather than from a hash, because a hash assigns a
  number without looking and two guests colliding on one is exactly the failure
  the FNV note in that file was written about. Whoever is already in the room
  keeps their number; a newcomer takes the lowest free one. A genuine
  simultaneous join is settled by a `since` stamp that travels in presence —
  arrival order, not the roll of a random id, because the earlier rule renamed
  an established "Unknown 1" about half the time somebody joined. The avatar
  shows a dash rather than initials: "UN" is not this person's initials any
  more than "Grace" was their name.
- `tabs/` — the index panel (`TabIndex.jsx`), `use-tabs`, and `outline.js`. A
  left column listing the document's tabs, with the open tab expanded into its
  own headings — the two levels of "where am I in this document", in one
  control. It is also the one control in the app whose clicks cost a
  **connection**: a tab is a document, so selecting one replaces the
  `EditorSync` instance and rebuilds the editor around it
  ([ADR-014](decisions/014-document-tabs.md)). Which tab is open is view state
  and lives in `App` (because it decides what the socket points at) and in the
  URL — never in the document, or one person's click would move everybody.
  `outline.js` reads headings off the RichText and never learns which engine
  produced it, exactly like `export-markdown.js`.
- `tasks/` — the shared checklist and `use-tasks`. Structurally the dullest
  hook here, deliberately: HTTP writes, a socket frame that says "changed", one
  re-read ([ADR-015](decisions/015-shared-task-list.md)).
- `Inspector.jsx` — the reason the app has a UI. Engine internals, last-sync
  byte cost against document size, the storage log filling toward compaction,
  peer offsets, and under OT the live client state machine. All of it was
  already flowing through sync events and the `MSG_DEBUG` round-trip; the panel
  only renders it.

## /decisions

The decision record as a page. Worth describing because of what it does *not*
contain: a Markdown parser.

`tools/lib/markdown.mjs` converts `docs/decisions/*.md` into a tree of typed
tokens at **build time**, and `Markdown.jsx` maps those tokens to elements.
There is no `dangerouslySetInnerHTML` anywhere in the path and therefore no
sanitiser standing behind one — the same argument `attribute-values.js` makes
about formatting values arriving from a peer, applied to prose. The parser
*throws* on a construct it does not know rather than dropping it, because a
silently swallowed table is how a documentation page quietly starts lying about
the document it renders.

The prose is fetched from `public/decisions.json` rather than imported. The
decision record has no business in the bundle every visitor downloads to look
at the landing page, and this is the only route that wants it.

Relative links between ADRs (`[ADR-009](009-crdt-only-product.md)`) are
rewritten to in-page anchors, because every decision is already on this page
and following one should not be a round trip to a file the reader may not be
able to open.

## Routes and the landing page

`main.jsx` routes on `location.pathname` with no router dependency, because
these are genuinely different pages rather than states of one:

| Route | Component |
|---|---|
| `/` | `ui/landing/Landing.jsx` |
| `/docs` | `ui/docs/DocsPage.jsx` |
| `/doc?doc=…` | `ui/App.jsx` |
| `/lab` | `ui/lab/Lab.jsx` |
| `/engines` | `ui/engines/EnginesPage.jsx` |
| `/decisions` | `ui/decisions/DecisionsPage.jsx` |

`?doc=` and `?lab` still work as fallbacks for static hosts that do not rewrite
unknown paths to `index.html`.

### The landing mosaic

`ui/landing/` is a five-panel mosaic on its own light palette, deliberately
unlike the instrument chrome of the editor. Two things make it work:

**Design units.** The composition is authored against a 1374 x 666 reference
stage where `1rem` is one reference unit, and a single root `font-size` knob
scales the whole thing to the viewport. Nothing is expressed in device pixels.
The knob is scoped to `html.mosaic` and the class is removed on unmount,
because the editor and the lab share this document root and a 1px root
font-size would wreck them. `tools/landing-test.mjs` asserts that the editor
route does not inherit it.

**Nothing decorative, and nothing unexplained.** Every panel carries something
the page can back up, and getting there meant deleting two panels that did not:
a mock notification toast — "Converged. Three replicas agreed after a partition
healed", over a fixed `2:34 PM` — and six chips naming hand-written layers under
a heading asserting they were hand-written. On a page whose entire argument is
that its numbers are measured, a clock that never moves is not neutral.

Their replacements were measurements — a `SIGKILL` durability record, then live
convergence counters — and the second one had a failure mode of its own: on an
idle node it rendered `Idle / 0 / 0 B / — / 0%`, five zeros down the left of
the front page, which reads as a panel that failed rather than as a system at
rest.

The deeper problem was not any one tile. **Nothing on the page said, in plain
words, what the site was**, and the largest panel on it — the centre — was the
engine comparison, headed "Two engines. One seam.", which lands only for a
reader who already knows what a seam is.

Two fixes were tried before the one that worked, and the order is the lesson.
First the identity statement went into a tile in the left column: a 339-unit
box beside a 627-unit one is not where the most important sentence goes.
Then the centre panel's *heading* was rewritten while it kept the demo: better,
but the panel was then making a claim and demonstrating a different one.

**The introduction is the centre panel now**, field and all, and the
demonstration is a band across the foot. Nothing was deleted to do it — the
search panel's field moved into the introduction, which is where it belongs
anyway, since an introduction that ends in "so go and open one" should hand
you the thing you open it with. The rest of the column supports it:

- `Internals.jsx` — what it is built on: CRDT merge, the append-only log and
  its snapshots, the hand-written sync protocol, presence and anchors above
  the engine seam. Four mechanisms and what each buys, because the
  introduction's last clause gestures at all of this and nothing followed it
  up. The durability result is the one measured line in the tile — `0` of
  1,170 characters lost to a `SIGKILL` mid-sentence — sitting directly under
  the log it is evidence for rather than standing on its own as a panel. The
  numbers come from `tools/measure-durability.mjs`, which boots a real server,
  kills it with a real signal and counts characters on the way back; the record
  is checked in as `durability.json`, beside the page that reads it. The tool
  refuses to write a record in which anything was lost, because a line that
  would cheerfully render "37 characters lost" is a line nobody would notice
  had gone wrong. The live half — open rooms, "node up" — is deliberately not
  here: nothing in the UI reads `/api/health`, which is the ops endpoint.
- `Features.jsx` — what it does, as four photographs of the real editor with a
  caption each, cycling every 4.2s until a row is hovered or focused. It was
  nine rows of ten-point prose, which is a spec sheet: eighteen lines
  describing a comments pane, a tab rail and a version list to somebody who has
  never seen any of them, on a page whose product is visual. The heading went
  with them — it read "What it does" over a list of what it does.

  The shots come from `tools/capture-shots.mjs` (`npm run shots`), which drives
  the actual application in Chrome the way the UI harnesses do: types a
  document, formats it through the real toolbar, posts a real comment, adds a
  tab, creates checkpoints over the API. Three things it had to learn the hard
  way, each recorded at the line that fixes it — crop *inside* the app header
  or the shot opens with a sliced avatar; zoom for the photograph only, because
  `page.mouse` and `getBoundingClientRect` disagree under CSS zoom and a drag
  across a phrase silently selected three characters of it; and select by
  keyboard rather than by dragging a box, because a phrase that wraps has no
  single box to drag across.

  Real-time editing is deliberately not one of the four: it is what the
  introduction demonstrates live, and a screenshot of it is a still photograph
  of motion.

`LiveDemo.jsx` did not change at all, which is the test of whether the engine
demo was ever really coupled to the hero. What changed is CSS: the component
was absolutely positioned into the hero's lower half at a top offset derived
from how long the copy above it happened to be — re-derived once per layout,
and wrong once already — and it now simply fills a card of its own. The two
engines lie side by side in the band (a wide cell) and back in a column on
tablet and phone (tall cells), which is one flex-direction and a regrid of the
engine label.

Two things that cost a measurement each. The bottom row took 34 units for the
band, so the delta chart's bars were rescaled to fit its shorter cell — the
curve is a drawing, the printed ratios are the data, and only the first may be
resized. And on the phone the band has no fixed height, where `flex: 1 1 0` on
the engine rows resolved to a zero basis and clipped the replica text by 50px;
the rows size themselves there instead.

The stacked layouts follow the same order as the desktop composition reads in,
and had to be told to: the phone stack led with the proof tile for as long as
that tile held the identity statement.

What left the page across all of this is not the measurements — the delta-sync
chart is beside this column, the hero runs both engines live, and `/decisions`
holds the rest. What left is the assumption that a visitor already
knew why any of it mattered.

**The introduction demonstrates rather than describes.** `IntroDemo.jsx` is two
real `Y.Doc`s with a relay between them — the LiveDemo construction minus the
partition, because the point here is the ordinary case. Ada appends at the end
of the paragraph while Grace types at the front and then bolds a phrase; both
replicas apply both streams; what is rendered is replica A's document. If the
merge were broken this panel would show it being broken.

Two details worth keeping. The carets are inline elements in the text flow
rather than absolutely positioned overlays, because an overlay has to measure a
character offset — a DOM Range per caret per frame, re-measured on every wrap —
while an inline element is placed by the line-breaking the text already does.
And only the person who typed most recently is labelled: both carets are always
drawn, but at rest the two happen to land in the same column, and two name
flags stacked on each other read as a rendering fault.

**Measured content.** The chart quotes real numbers from
`tools/measure-delta.mjs`: a reconnecting client that is already up to date pays
a flat ~322 B no matter how large the document is, so the saving grows linearly
— 3x at 1 KB, 408x at 100 KB. The test asserts the rendered figures still match
the measurement.

That floor was ~171 B when it was first measured, and the doubling is worth
knowing because it is not a regression in delta sync. `lastSyncRecv` counts
every byte received before the client is synced, so it includes the `MSG_HELLO`
envelope — which now carries the title, the tab id and title (ADR-014), the
role, the user and whether the document is unowned (ADR-007, ADR-010). The
envelope got richer; the exchange did not get worse. The panel's actual claim is
that the cost is flat in document size, and it still is: 322 B at 1K characters
and 322 B at 50K.

The panel also has to say what the ratio is *between*. "408x smaller than the
document" was a comparison of two things the page had never named, so it now
carries the mechanism in a sentence: a reconnecting client says what it already
has, and the server replies with the missing updates rather than the document.
That sentence costs vertical space, and the tablet cell had none — the axis ran
3.4px past the bottom of its own card, which `responsive-test.mjs` could not
see because it excludes bottom overflow by design. `landing-test.mjs` measures
that one edge directly now (`7f`).

The search panel is functional rather than decorative: it filters documents
polled live from both servers' `/api/docs`, and typing a name that does not
exist offers to create it.

**Entrance.** A one-shot choreography — panels settle, then interface layers,
then details — after which the animation classes are removed entirely and the
page reverts to its static authored styles. It is skipped under
`prefers-reduced-motion`. The boot class lives in `main.jsx` rather than at
module scope in `Landing.jsx`, because that module is imported on every route
and the class plus its fail-safe timer would otherwise be attached while you
are editing a document.

Note that while the entrance runs, panels are `visibility: hidden` — clicks
land on nothing for ~1.9s. That is the reference choreography rather than a
defect, but it is why the browser test waits for the entrance to settle before
interacting.

### Responsive

`tools/responsive-test.mjs` renders the landing across eight real viewports and
asserts three separate things, because with a scaled composition a layout that
*fits* can still be unreadable:

1. no horizontal page overflow,
2. nothing clipped by its own card (bottom overflow excluded — the front hero
   window bleeds off the card by design),
3. body text stays above an 8px floor, with no exemptions — the exception list
   this rule used to carry was one small licence to ship type nobody can read
   per entry, so the labels were sized up instead.

Three things it caught:

- **Landscape phones fell through to the desktop composition.** The reference
  breakpoints only test width, so 844x390 resolved the scale knob to
  `1rem = 0.55px` and rendered the toast subtitle at 5.5px. The stacked layout
  now also triggers on `(max-height: 520px)`.
- **The mobile card in the left column was the wrong height, three times.**
  508 units was sized for six brand chips, the chip version cut it to 372 as
  dead air, and the ledger needed 430 before a scroll port read as broken
  rather than as scrollable. The feature list ends the argument by not having
  a fixed height at all: eight rows of two lines is something the stacked
  layout can add up, and pinning it to a number is how a row gets clipped the
  next time one is added.
- **The JS and CSS breakpoints drifted.** The placeholder is swapped for a
  shorter string on small screens, and once the CSS gained a height condition
  the JS query no longer matched — so landscape phones got the long placeholder
  in the short field. `COMPACT_MQ` in `Landing.jsx` must stay identical to the
  stacked-layout query in `mosaic.css`.

Portrait tablets render the reference's two-column tablet layout at 69% of
design size, so several labels needed explicit bumps to clear the floor. The
composition also letterboxes on tall tablets — it has a fixed aspect, and that
is inherent to the design rather than a bug.

**The editor and the lab remain desktop-only.** They are usable on a tablet but
were never designed for a phone; that is still a non-goal.

### The initial-content bug this surfaced

Opening an existing document rendered a blank editor while the inspector
correctly read `30 chars`. Both engine bindings apply *changes* only; nothing
seeds the editor's starting state. When the socket wins the race against React
and the dynamic import — which is exactly what happens when you open a document
that already exists — the content arrives before the editor mounts, no change
event ever fires, and the pane stays empty forever.

`Editor.jsx` now seeds `EditorState.create({ doc: sync.getText() })`, and
`getText()` is part of the `EditorSync` interface for that reason.

Two tabs typing at each other never hit this, because there the content always
arrives *after* mount. It survived every test until the landing page started
opening existing documents.

## URL parameters

| Param | Default | Meaning |
|---|---|---|
| `doc` | `demo` | Document id; different ids are independent documents. A tab id (`<doc>~<tab>`) works here too, so a copied address bar opens the tab it named |
| `tab` | first tab | Which tab of the document to open |
| `client` | random | Stable client id, so a refresh keeps your identity |
| `name` / `color` | `color` from `client`; no name | Display identity. With no `name` and no account you are a **guest** — see below |
| `engine` | `yjs` | Concurrency engine: `yjs` or `ot` |
| `server` | `ws://<host>:8080` | WebSocket endpoint |

`/lab` takes `engine`, `doc` and `server` too. `?lab` works as a fallback on
static hosts that do not rewrite unknown paths to `index.html`.

## Known gaps

- Remote cursor positions are absolute offsets (see above).
- The undo stack is per-client via `Y.UndoManager`, which is correct, but
  undoing across a reconnect is not covered by a harness.
