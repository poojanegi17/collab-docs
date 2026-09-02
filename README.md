# collab-docs

<!-- Substitute your GitHub owner/repo here and the badge goes live. The
     workflow itself is .github/workflows/ci.yml and needs no configuration. -->
[![CI](https://github.com/poojanegi17/collab-docs/actions/workflows/ci.yml/badge.svg)](https://github.com/poojanegi17/collab-docs/actions/workflows/ci.yml)

A collaborative rich-text editor built to learn distributed systems: CRDTs,
sync protocols and durability.

![CRDT and OT partitioned, edited on both sides, then healed](docs/media/partition-heal.gif)

**The project in one image.** The same script runs against both engines at
once: type, cut the network on both replicas, keep typing on both sides of the
split, then heal. **CRDT on top** ends with both sides of the partition
present. **OT below** ends with the offline work gone — the healing client is
handed the server's document, because that is what server authority means
([ADR-004](docs/decisions/004-ot-engine.md)). Recorded by `npm run record`,
which drives two real labs rather than an animation.

![The engine seam: two interchangeable engines behind one interface on each side](docs/media/architecture.svg)

**The shape of it.** Two concurrency engines sit behind one interface on the
client (`EditorSync`) and one on the server (`DocEngine`). Everything outside
those two dashed boxes -- the editor, formatting, presence, comments, the
transport, the JSON API and storage -- is written once and runs under either,
because none of it can tell which engine produced the bytes going past. The
box at the bottom left is the list of places where that stops being true, and
every line of it has an ADR.

It runs **two interchangeable concurrency engines** behind one interface — a
CRDT (Yjs) and hand-written server-authoritative OT — so the same editor, the
same storage and the same presence layer can be driven by either and compared
directly. That comparison is the point of the project.

Documents on the site are **CRDT-only**. Choosing a concurrency-control
algorithm is not a decision to put in front of someone who wants to write
something down — under OT, work done offline is discarded on reconnect, and
two buttons cannot teach anyone that. The OT engine is complete, tested and
running; **the lab is where you switch between them**, because that is where
the difference is demonstrated rather than merely offered
([ADR-009](docs/decisions/009-crdt-only-product.md)).

It is built CRDT-first for the reasons in [ADR-001](docs/decisions/001-crdt-over-ot.md),
behind the seam described in [ADR-002](docs/decisions/002-engine-seam.md).

## What it does

- Rich-text editing, many clients, real-time convergence
- **Formatting under both engines**: character marks, colour, font, size,
  links, headings, alignment, indent, spacing and lists -- carried as
  attributes on `retain` under OT and as Y.Text attributes under the CRDT,
  rendered by one engine-agnostic decoration layer
  ([ADR-006](docs/decisions/006-rich-text.md),
  [ADR-011](docs/decisions/011-formatting-vocabulary.md))
- **Two engines**: CRDT and OT, sharing everything else. The product uses the
  CRDT; the lab switches between them
- Live cursors and selections with names and colours
- Durable storage — kill the server with `SIGKILL`, restart, nothing is lost
- **Offline editing that survives a reload.** Losing the socket and carrying
  on typing is the easy half. The hard half is the tab closing during the drop:
  a replica that lived only in memory would take the unsent edits with it, and
  for a guest document -- which the server files under nobody -- that is the
  whole document. The CRDT replica is written to IndexedDB as it changes, so a
  reload with the server unreachable comes back with the work intact and syncs
  it when the network returns. Deliberately **off in the lab**, where every
  replica shares one browser and a shared local store would let a partitioned
  pair converge through the disk
- Rate limiting and a session cache, both on Redis when it is configured and on
  an in-process map when it is not ([ADR-023](docs/decisions/023-redis-as-a-cache-and-rate-limiting.md))
- Delta sync: reconnecting costs bytes proportional to *what changed*, not to
  document size
- **Accounts and sharing**: real users, owned documents with titles, and
  per-document roles enforced on the socket rather than in the UI
  ([ADR-007](docs/decisions/007-accounts-and-sharing.md))
- **Sign in with Google, or with a password.** A credential belongs to a
  provider; a person does not — so identities are their own table and an
  account can have both. The ID token is verified here, against Google's
  published keys, and exchanged for an ordinary session: nothing downstream
  can tell the two apart. It proves *identity* and grants no *authority* —
  reading a Drive file is a separate consent the sign-in does not carry
  ([ADR-020](docs/decisions/020-federated-identity.md))
- **Write without an account; sign in to share.** Creating and editing a
  document needs no sign-up. Sharing does — not as a policy, but because
  granting access names a person on both ends, and an unowned document has
  neither. The share dialog walks you through it in place: sign in, claim what
  you already wrote, then share
  ([ADR-010](docs/decisions/010-guest-documents.md))
- **Import a document from Drive** — pick it out, and it is exported as HTML
  and run through one converter into this editor's formatting vocabulary:
  headings, lists, colour, highlight, links, images. What lands is an
  **independent document** with no link back — syncing instead would put two
  concurrency-control systems over one document with the other one winning,
  which is the arrangement the rest of this project exists to avoid. What the
  vocabulary cannot carry is counted and said out loud rather than dropped. It
  needs a Google Cloud project and, until the app is verified, an account named
  as a test user, and the dialog says so in place rather than failing silently
  ([ADR-021](docs/decisions/021-importing-from-drive.md))
- **A word-processor toolbar**: undo/redo, print, paint format, paragraph
  style, font, size, bold/italic/underline/strike/code, text colour,
  highlight, links, super/subscript, four alignments, line spacing, bulleted
  and numbered lists, indent/outdent and clear — on the keyboard shortcuts
  people's hands already know, and with `Ctrl+Z` bound to the CRDT's own undo
  rather than CodeMirror's, which would happily undo a peer's edit
  ([ADR-011](docs/decisions/011-formatting-vocabulary.md))
- **Version history**: named checkpoints, previewing an old version, and
  restoring one as an ordinary edit that collaborators see live
  ([ADR-008](docs/decisions/008-version-history.md))
- **Comments**, anchored to a range and surviving edits inside it — and the
  first feature where the two engines differ in *kind* rather than in
  mechanism. Under the CRDT an anchor is a relative position that rides along
  with a character; under OT it is a pair of indices, and transforming those
  against concurrent operations **converges under insertion and diverges under
  deletion**, measured. So the OT server owns its anchors and the CRDT needs no
  owner at all ([ADR-012](docs/decisions/012-comment-anchors.md))
- **Images and tables**, added without either engine changing. An image is one
  `U+FFFC` character carrying a URL; a table is a run of lines whose cells are
  separated by `U+001F`. Both stay inside the flat sequence of characters the
  document already was, so concurrent edits in two different table cells merge
  through code that knows nothing about tables
  ([ADR-013](docs/decisions/013-blocks-without-a-tree.md))
- **Document tabs** — several independent bodies of text under one title, one
  owner and one access list. A tab *is* a document
  here: its own room, its own update log, its own history and its own comments,
  with sharing inherited rather than copied. They live in a left **index
  panel**, where the open tab expands into its own headings — the document's
  parts and a part's sections being the same question asked twice. Nothing in
  the storage or engine layer had to learn what a tab is, which is the whole
  argument for the decomposition
  ([ADR-014](docs/decisions/014-document-tabs.md))
- **A shared task list** on every document, visible from every tab: anyone who
  can edit the document can add an item, and anyone who can edit it can tick
  one off — with who ticked it recorded, because that is the fact a shared
  checklist exists to carry. Deliberately *not* a CRDT, and
  [ADR-015](docs/decisions/015-shared-task-list.md) is the argument for why
  reaching for one here would have been the wrong instinct
- **Broadcast batching, and the measurement that qualifies it.** Outbound
  frames are held for 50ms and merged into one, which fixes half of broadcast
  fan-out: frames drop by up to **24x** in a busy room while bytes move by
  **1.3x**, because the bytes are the edits and no window makes an edit
  smaller. Merging happens behind the engine seam — the transport asks whether
  frames may be merged and never learns what they are — and rooms below five
  people are left alone, because the merged frame goes to everyone including
  the sender and below that it costs more than it saves
  ([ADR-016](docs/decisions/016-broadcast-batching.md))
- **`/decisions`**: the whole decision record as a page — one card per ADR with
  a diagram and a brief, and the full record one click behind it. The markdown
  is parsed to typed tokens at build
  time by `tools/generate-adr-index.mjs`, so no Markdown library reaches the
  browser and there is no HTML in the pipeline to inject into
- **The hero runs both engines at once.** The same partition is driven through
  a real pair of `Y.Doc`s and the project's real `TextOperation`, side by side,
  and they end differently: the CRDT keeps both sides, OT hands the
  reconnecting client the server's document and the offline work is gone
  ([ADR-004](docs/decisions/004-ot-engine.md)). There is a button to cut the
  wire yourself
- **Crash safety on the front page, measured.** `tools/measure-durability.mjs`
  boots a server, `SIGKILL`s it mid-burst, restarts it and counts characters —
  1,170 written, 330 of them typed while the process was dead, 0 lost. It
  refuses to write a record if anything *was* lost, so the panel cannot quietly
  start reporting a failure as a success
- **Relay latency, as percentiles.** p50/p99 of the server's own share of
  keystroke-to-remote-paint, off a bounded 256-sample ring. Percentiles and not
  a mean, because a relay that answers in 1ms ninety-nine times and 400ms once
  has a mean of 5ms and a real problem
- **A landing page arranged around what a first-time reader needs.** The
  centre panel -- the biggest one, the one the eye lands on -- is the
  **introduction** (*One document. Everyone typing at once.*), with the
  search-and-create field in it, because an introduction that ends in "so go
  and open one" should hand you the thing you open it with. It is written to
  sell rather than to describe: *Real-time editing. No turns. No conflicts.*
  over a paragraph of what the reader gets, in the words they would search for.
  The engine comparison is a band across the foot, where it is the evidence for
  a claim rather than the claim itself -- two engines, one partition, side by
  side. Down the left, the two questions the introduction raises and has no
  room for: **what it is built on** (CRDT merge, append-only log, hand-written
  protocol, presence above the seam, with the `SIGKILL` result as the one
  measured line) and **what else it does** -- which is photographs of the real
  editor rather than a list of adjectives
- **Both demonstrations are the real thing.** The introduction's document is
  two live `Y.Doc`s: Ada appends while Grace types at the front and bolds a
  phrase, both replicas apply both streams, and what you read is what the merge
  produced. The feature shots come from `npm run shots`, which drives the
  actual editor in Chrome the way the UI harnesses do -- types a document,
  formats it through the real toolbar, posts a real comment -- and crops what
  it finds. Nothing on the page is a mockup of a UI that does not exist
- **Full-text search across your documents.** The search box on `/docs` is a
  real content search, not a filter over the titles the listing already had --
  ranked results, with the matching line quoted in place. Filtering is all a
  browser could do on its own: the text lives in engine-specific bytes on the
  server and nothing on this side has ever seen it. The interesting part is
  where the index lives: a document's log is opaque bytes only its own engine can
  read, so the text is projected out through the one seam method that speaks
  content and indexed *outside* the engine, in Postgres full-text search -- which is why
  one index serves both engines and why searching costs the same under either
  ([ADR-017](docs/decisions/017-search-projection.md))
- **Authorship: who wrote each character** -- and the second place the two
  engines differ in *kind*, this time in the CRDT's favour. Under the CRDT it
  is free and retroactive: a `Y.Text` item already carries the id of the client
  that inserted it, because that is how the CRDT *orders* concurrent inserts.
  Under OT the server transforms an op, applies it, and the resulting text
  remembers nothing -- so the engine keeps a parallel per-character array, the
  log entry carries who wrote it, and snapshots carry an author section. It is
  a record that has to be kept as the document is written: an OT document that
  never recorded it cannot be attributed afterwards
  ([ADR-018](docs/decisions/018-authorship.md))
- **Trash.** Deleting an owned document is soft: the update log and every
  version survive it, and `/docs` has a Trash scope to reach them from.
  Restoring puts a document back exactly as it was, including its history and
  everyone it was shared with, because an ACL is not touched by a soft delete.
  An *unowned* document has no owner to scope a trash to, so deleting one is
  permanent — and the confirmation says so rather than promising a restore
- Word count, find & replace, and Markdown export — the export says out loud
  what Markdown could not carry rather than dropping it silently
- **Responsive down to a phone.** Below 900px the side panes stop taking a
  column and become overlays, because splitting a phone screen between a
  document and a sidebar gives you two things too narrow to use
- **The lab** at `/lab`: up to eight real replicas of one document in one
  page, each with its own socket and its own network conditions (latency,
  jitter, drop, black-hole partition). Underneath them, two different kinds of
  truth side by side — a decoded frame timeline of what the replicas saw, and
  the room's own view of what the server knows, including the transforms OT
  performed. **Guided runs** script the demonstrations end to end, driving the
  same controls and the same editors a person drives, so a scripted run and a
  manual one are the same run

## Quick start

```bash
npm install
npm run dev
```

That starts three processes: the CRDT server (8080), the OT server (8081), and
the client (5173). Then open **two or more** tabs.

Start at **http://localhost:5173/** and press **+ New document**. No account is
needed to write — the document is *unowned*, which means anyone with the link
can edit it. The server has nobody to file it under, so this browser remembers
it locally and `/docs` lists it alongside the documents you own.

Sign up (top right) when you want to **share** one. That is the single place
the product asks for an account, and the share dialog walks you through it
without leaving the document: sign in → claim → share
([ADR-010](docs/decisions/010-guest-documents.md)).

**All your documents** leads to `/docs` — the home screen: create, import,
rename, share and delete live there. It is one list with a scope selector
(*All*, *Your documents*, *Shared with you*, *Trash*), each carrying a count,
and it holds what you own, what has been shared with you, and the unowned
documents this browser has opened. What it never shows is somebody else's
unowned document — the lab's scratch pads and the harnesses' leavings are not
yours, were not shared with you, and you have never opened them.

To watch sharing actually work you need two *people*, not two tabs: the session
token lives in localStorage, which tabs share. Use a second browser profile or
an incognito window.

The URLs below create **unowned** documents — the same thing `+ New document`
makes when you are signed out, which is how the lab's scratch pads behave and
how every test harness connects. `REQUIRE_OWNER=true`
turns anonymous documents off entirely, and then creating one needs an account.

CRDT engine:

- http://localhost:5173/doc?client=alice
- http://localhost:5173/doc?client=bob

OT engine — same UI, different concurrency control. Not offered anywhere in
the product; the route honours it, and the lab and the browser harness both
use it:

- http://localhost:5173/doc?client=alice&engine=ot&server=ws://localhost:8081
- http://localhost:5173/doc?client=bob&engine=ot&server=ws://localhost:8081

### The lab

- http://localhost:5173/lab — CRDT
- http://localhost:5173/lab?engine=ot — OT

The **Merge strategy** toggle in the controls bar is the only place in the
product where you choose an engine (documents on the site are CRDT-only,
[ADR-009](docs/decisions/009-crdt-only-product.md)); the two URLs above are
what it links to. It reloads rather than swapping in place, because the
replicas hold state the other engine cannot read.

**One document, several replicas.** Every pane is a replica of the *same*
document — same `docId`, its own socket, its own network conditions. The panes
are labelled `replica alice`, `replica bob` for exactly that reason: they are
not different files, and reading them as two documents that happen to agree is
the most common misreading of the page. Add replicas up to eight, and remove
any of them; the grid wraps and the panes shrink, which is itself part of what
you learn.

Pick any of your documents from the **Document** dropdown to watch it
converge, rather than only the scratch document the lab invents. That needs a
session: signed out, the only documents reachable are unowned ones.

The comparison worth running: **partition both, type in both, then heal**.
Under CRDT the two sides merge. Under OT the healing client is handed the
server's document and its own work is discarded — not a bug, the documented
consequence of server authority ([ADR-004](docs/decisions/004-ot-engine.md)).
It is the first **guided run** in the picker, if you would rather not perform
the five-step dance by hand.

Also try dragging latency to 2000ms and typing a burst. It reaches the other
replica in about 2.3s under CRDT and about 6.1s under OT, because OT allows
only one operation in flight and the rest must wait for an ack.

Two panels sit under the replicas and are meant to be read against each other.
The **timeline** is what the replicas saw: every frame, both directions, newest
first, decoded — click a replica to filter it, or export the run as JSON with
the network settings that produced it. The **server** panel is what the room
knows, polled through whichever replica is not partitioned; cut every replica
off and it goes stale, which is the demonstration working rather than the panel
failing. Under OT it also lists the transforms — each accepted op, the revision
it was based on, and how many already-accepted ops it had to be adjusted
around.

A **glossary** at the foot of the page defines the words the rest of it uses:
replica, partition, anti-entropy, state vector, revision, transform.

### URL parameters

| Param | Default | Meaning |
|---|---|---|
| `doc` | `demo` | Document id — different ids are independent documents |
| `tab` | first tab | Which tab of the document to open. A tab's own id (`<doc>~<tab>`) also works in `doc` ([ADR-014](docs/decisions/014-document-tabs.md)) |
| `client` | random | Stable client id, so a refresh keeps your identity. Doubles as the display name. |
| `name` / `color` | `color` from `client`; no name | Display identity. Signed out and unnamed, you are `Unknown 1`, `Unknown 2`… — the site will not put a person's name on a document no account stands behind |
| `engine` | `yjs` | Concurrency engine: `yjs` or `ot` |
| `server` | `ws://<host>:8080` | WebSocket endpoint |

## Verifying it

```bash
npm test                      # everything below, in order

node tools/ot-properties.mjs  # OT transform laws, 8k random assertions.
                              # --seed=N replays an exact run
node tools/anchor-properties.mjs # comment-anchor laws, and the pinned
                                 # counterexample proving OT anchors diverge
node tools/db-contention-test.mjs # both servers opening one accounts database
node tools/checklist.mjs      # CRDT end-to-end (needs npm run dev:server)
node tools/ot-checklist.mjs   # OT end-to-end (owns its server on 8100)
node tools/restart-test.mjs   # crash durability (owns its server on 8099)
node tools/measure-durability.mjs # the same crash, counted rather than
                              # asserted (owns its server on 8097). Writes the
                              # record the landing page renders:
                              #   npm run measure:durability
node tools/toggle-test.mjs    # offline/online toggle, no sleeps between steps

npm run test:browser          # real headless Chrome, both engines
node tools/rich-ot-properties.mjs      # attributed transform laws, fuzzed
node tools/rich-ot-checklist.mjs       # the same laws as worked examples
node tools/attribute-safety-test.mjs   # the sanitisers: no javascript: links,
                                       # no CSS escaping the property it sets
node tools/api-test.mjs                # accounts, sharing, history (own server)
node tools/google-auth-test.mjs        # ID token verification, against a local
                                       # issuer this test holds the key for --
                                       # the assertions are the refusals
node tools/import-html-test.mjs        # Drive's HTML export -> RichText, against
                                       # a real one; what is lost is reported
node tools/import-route-test.mjs       # and the same runs through the engine
                                       # into a real document, live and offline
node tools/guest-flow-test.mjs         # guest doc -> sign in -> claim -> share
node tools/ui-accounts-test.mjs        # the same, through the real UI
node tools/guest-ui-test.mjs           # the guest journey, through the real UI
node tools/docs-page-test.mjs          # the documents page, two browser contexts
node tools/lab-docs-test.mjs           # the lab on a real document, replica framing
node tools/browser-test.mjs --headful   # watch it drive the UI
node tools/lab-test.mjs       # the lab: partition, diverge, heal, converge
node tools/landing-test.mjs   # landing mosaic + /api/docs
node tools/responsive-test.mjs # landing across 8 device viewports
node tools/comments-test.mjs   # comments end-to-end, BOTH engines
node tools/blocks-test.mjs     # images and tables under concurrency, both engines
node tools/tabs-tasks-test.mjs # tabs and the task list, BOTH engines -- and
                               # notably with no engine-specific code in it
node tools/search-test.mjs    # full-text search, BOTH engines -- including
                              # eight hostile queries that are query syntax
node tools/authorship-test.mjs # who wrote what, BOTH engines. Asserts the
                               # asymmetry rather than describing it: after a
                               # restart an OT document's runs survive and its
                               # NAMES do not
node tools/markdown-export-test.mjs    # what export keeps, and what it admits losing
node tools/comments-ui-test.mjs        # the comment journey in real Chrome
node tools/editor-tools-test.mjs       # word count, find & replace, export
node tools/tabs-tasks-ui-test.mjs      # tabs and the checklist in real Chrome,
                                       # including deleting a tab someone else
                                       # is reading
node tools/offline-persistence-test.mjs # type offline, RELOAD, and still have it
node tools/app-responsive-test.mjs     # the app across six device viewports
node tools/a11y-test.mjs               # accessibility on every route: accessible
                                       # names, Tab reachability, focus
                                       # visibility, heading structure and
                                       # WCAG AA contrast. No axe, no dependency
node tools/bundle-budget.mjs           # what the browser has to download, with
                                       # a ceiling CI enforces
node tools/generate-adr-index.mjs --check # /decisions still matches
                                         # docs/decisions
node tools/config-check.mjs            # the workflows and render.yaml parse and
                                       # say what they should. First in `npm test`,
                                       # because a workflow that does not parse
                                       # never reaches a runner -- CI cannot be
                                       # the thing that catches it
node tools/measure-delta.mjs  # re-measure the numbers the landing page quotes
node tools/record-demo.mjs    # re-record the GIF at the top of this file
```

`browser-test.mjs` drives the actual UI in Chrome via puppeteer-core (it uses
your installed Chrome, nothing is downloaded). Everything else drives the sync
classes directly, so the protocol can be shown correct without a browser in
the way -- and a UI bug cannot be mistaken for a protocol one.

Every harness drives the **real** client class over the **real** wire protocol,
not mocks. See [docs/done-checklist.md](docs/done-checklist.md).

## Layout

```
frontend/            Everything that runs in the browser.
  src/sync/            EditorSync interface + YjsSync + OTSync (run in Node too).
  src/net/             SimulatedSocket: latency, jitter, drop, partition.
  src/presence/        Remote cursor rendering. Engine-agnostic.
  src/ui/              React + CodeMirror 6.
  src/ui/landing/      The front door.
  src/ui/theme.css     The shared card washes.
  src/ui/prose.css     The long-form page shell: hero, sections, links.
  src/ui/marks.js      Formatting -> CodeMirror decorations. Engine-agnostic.
  src/ui/Toolbar.jsx   Formatting controls. Calls EditorSync.format() only.
  src/ui/format-commands.js  The formatting commands, shared by the toolbar
                       and the keyboard shortcuts.
  src/ui/attribute-values.js The formatting vocabulary, and the sanitisers
                       standing between a peer's values and the DOM.
  src/local-docs.js    Documents this browser made without an account.
  src/ui/docs/        The documents page: sections, row actions, sharing.
  src/ui/account/     Sign in, sign up, session.
  src/ui/share/       Who can open this document.
  src/ui/history/     Version list, preview and restore.
  src/api.js          The JSON API client, and where the session token lives.
  src/ui/lab/          Multi-replica view, per-replica network controls, the
                       decoded frame timeline, the server's own view, scripted
                       runs and the glossary.
  src/ui/comments/    Anchored threads: the sidebar, the highlight layer, and
                      the hook that owns neither positions nor bodies.
  src/ui/landing/LiveDemo.jsx  BOTH engines, the same partition, side by side:
                      real Y.Docs and the real TextOperation. In memory -- a
                      landing page that needs a running backend looks broken
                      exactly when it matters -- and the visitor cuts the wire.
  src/ui/landing/Internals.jsx What it is built on, in four lines, with the
                      SIGKILL durability record as the one measured one.
  src/ui/landing/Features.jsx  What it DOES: photographs of the real editor,
                      each captioned with the part that is not obvious.
  src/ui/decisions/   The ADRs as a route: a token renderer, a contents rail,
                      and no Markdown parser in the bundle.
  src/ui/authorship.js Authorship runs -> CodeMirror decorations. Its own
                       layer, and engine-agnostic: it cannot tell whether the
                       runs came free from a CRDT or from OT's parallel array.
  src/ui/export-markdown.js    RichText -> Markdown, and what it cannot carry.
  src/ui/StatusBar.jsx         Word and character count.

backend/             Everything that runs on the server.
  src/engines/         DocEngine interface + YjsEngine + OTEngine, including
                       whether an engine's frames may be merged (ADR-016).
  src/transport/metrics.js  Process-wide counters. Room stats die with the
                       room; these are what /api/health reports.
  src/transport/       WebSocket rooms, presence relay, routing.
  src/transport/api.js JSON API: accounts, documents, sharing, history.
  src/storage/         Update log, snapshots, archive, docs, ACL and comment
                       threads, on Postgres (ADR-019).
  src/storage/db.js    The connection pool, and the only file that knows we
                       are on Postgres. Schema-qualifies every statement
                       rather than trusting `search_path` through a pooler.
  src/storage/schema.js    The DDL, run on every boot. Idempotent, and holds
                       an advisory lock because `CREATE TABLE IF NOT EXISTS`
                       is not safe to run concurrently -- without it, the two
                       servers `npm run dev` starts race on a cold boot.
  src/storage/accounts.js  Users and sessions. Shared by BOTH engine servers.
  src/auth/            Verifying a provider's ID token, against its published
                       keys, with the algorithm pinned rather than read from
                       the token (ADR-020).
  src/cache/           A keyed cache with expiry: an in-process map, or Redis
                       when it is configured. Never storage -- every value is
                       derivable from Postgres and a miss is the normal case
                       (ADR-023).
  src/realtime/        The seams Redis will slot into: pub/sub, presence,
                       the room registry, and the bounded write buffer that
                       keeps a keystroke off the network round trip. All have
                       in-process implementations today (ADR-019).

shared/              Used by both, owned by neither.
  protocol/            Engine-agnostic envelope + one sub-protocol per engine.
  ot/                  The OT algorithm. Pure, no network, property-tested.
                       Plain-text and attributed operations, side by side.

tools/               Test harnesses (headless and real-browser).
  lib/markdown.mjs     Markdown -> typed tokens, at BUILD time. The reason
                       /decisions ships no parser and no HTML.
  generate-adr-index.mjs  docs/decisions/*.md -> the /decisions payload.
                       `--check` fails a stale one.
  bundle-budget.mjs    A ceiling on the gzipped bundle, enforced in CI. A
                       keystroke costs bytes measured to a fraction; this is
                       what stops the pages describing that from costing more
                       to load than a year of typing.
  a11y-test.mjs        Accessibility across every route, computed from the live
                       DOM and CSSOM rather than from a rule library.
  record-demo.mjs      Drives two real labs and encodes the README GIF.
docs/decisions/      ADRs.
docs/media/          Generated. Re-made by `npm run record`.
```

`frontend`, `backend` and `shared/*` are npm workspaces. Anything genuinely
common to both sides — this README, the root `package.json`, `.gitignore`,
`tools/`, `docs/` — deliberately stays at the root rather than being duplicated
or arbitrarily assigned to one side.

### Routes

| Route | What |
|---|---|
| `/` | Landing: what this is, what it does, and the way in |
| `/docs` | Your documents — owned, shared with you, and unowned ones this browser opened |
| `/doc?doc=…` | The editor. `&tab=` opens one tab of it |
| `/lab` | The lab |
| `/engines` | How each engine reconciles concurrent edits, worked through |
| `/decisions` | Every decision, briefly — the full record one click away |

The site nav carries the four sections — documents, lab, engines, decisions —
and every route on the site is one of them.

### HTTP API

Each server exposes a JSON API on its WebSocket port: accounts
(`/api/auth/*`, `/api/me`), documents (`/api/docs`), sharing
(`/api/docs/:id/share`), ownership (`/api/docs/:id/claim`), history
(`/api/docs/:id/history`, `/versions`, `/checkpoints`, `/restore`), comments
(`/api/docs/:id/comments`), tabs (`/api/docs/:id/tabs`), tasks
(`/api/docs/:id/tasks`), search (`/api/docs/search`), the trash
(`/api/docs/trash`, `/api/docs/:id/undelete`) and authorship
(`/api/docs/:id/authorship`).

`undelete`, not `restore`, and the distinction is not pedantry: `restore`
already exists on this API and rolls a **live** document back to an earlier
version (ADR-008). Two different operations with two different subjects -- one
takes a document you cannot open and makes it openable, the other takes one
you are reading and changes what it says.

Tabs and tasks are metadata in the strict sense the rule below means. A tab's
*content* never travels here — it is a document with a room of its own, reached
over the socket like any other — and what the tab endpoints serve is which tabs
exist, in what order, under what name.

Comments look like an exception to the rule below and are not. A comment is not
document *content* — but its anchor is engine-specific, so it is minted and
resolved behind the seam and the API only ever stores it as an opaque value.

`GET /api/health` is the one route with no session and no document id: it
answers in aggregates only -- engine, port, open rooms, connected clients,
document count, stored bytes, last write. Nothing in the UI renders it; it is
the ops endpoint, and `tools/landing-test.mjs` holds it to its contract. It reports no titles,
ids or owners on purpose, because an unauthenticated endpoint that named
documents would be a way to enumerate other people's by asking politely.

`POST /api/docs` does **not** require a session; the document it creates is
unowned. `POST /api/docs/:id/claim` is the one that does, because ownership is
a statement about a person.

The rule that governs what belongs there: **nothing that changes a document's
content goes over HTTP.** Content changes go over the WebSocket, where the
engine can order them and transform them against concurrent edits. Restore
looks like an exception and is not — it hands the engine a document and the
engine produces a normal edit.

Accounts are shared between the two servers; documents are not, because a
document's update log is bytes only its own engine can read.

The load-bearing idea is the **engine seam** — concurrency control is confined
to `engines/` and `sync/`, and nothing above those layers imports Yjs. See
ADR-002 for the rules and for the test of whether the seam held.

## Environment variables (server)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | WebSocket port (or `--port=`) |
| `ENGINE` | `yjs` | Active engine, `yjs` or `ot` (or `--engine=`) |
| `DATABASE_URL` | _(required)_ | Postgres connection string. There is no local-file fallback on purpose: a server that could silently degrade to a file would silently lose every document on the next deploy ([ADR-019](docs/decisions/019-postgres-source-of-truth.md)) |
| `DATABASE_URL_ADMIN` | _(unset)_ | The schema OWNER, and only for DDL. `DATABASE_URL` is a least-privilege role that cannot CREATE, so the schema is created by `npm run migrate` with this credential instead. Must be the DIRECT (non-pooler) endpoint. Unset on the running service is correct: boot then requires the schema to exist already and fails loudly if it does not (or `--database-url-admin=`) |
| `DB_APP_ROLE` | `collab_app` | The role `DATABASE_URL` authenticates as, granted DML on each schema as it is created. Only read while running DDL |
| `ALLOWED_ORIGINS` | _(unset)_ | Comma-separated origins allowed to call the API. Unset means any, which is what development wants and is safe here because credentials ride in the `Authorization` header and never in a cookie -- but a deployment that knows its front end's URL should set it anyway |
| `GOOGLE_CLIENT_ID` | _(unset)_ | The OAuth client id an ID token must name as its audience. **The same value the client compiles in as `VITE_GOOGLE_CLIENT_ID`, and both have to be set**: unset here, `/api/auth/google` answers 501 while the button still renders. Not a secret -- it ships in the bundle either way ([ADR-020](docs/decisions/020-federated-identity.md)) |
| `DB_SCHEMA` | the engine name | Which schema this server's documents live in, `yjs` or `ot` (or `--schema=`) |
| `COMPACT_AFTER` | `200` | Loose updates before the log is compacted |
| `ACCOUNTS_SCHEMA` | `accounts` | Users and sessions, shared by both servers (or `--accounts-schema=`) |
| `PERSIST_WINDOW_MS` | `25` | How long an accepted update may sit in memory before it reaches Postgres. `0` is write-through, which is what every harness asserting on the log uses (or `--persist-window=`) |
| `BROADCAST_WINDOW_MS` | `50` | How long outbound engine frames may be held so the engine can merge them. `0` turns batching off entirely (or `--broadcast-window=`) |
| `BATCH_MIN_CLIENTS` | `5` | Rooms smaller than this are never batched: the merged frame goes to everyone including the sender, and below five that costs more than it saves. Read off the measurement rather than picked ([ADR-016](docs/decisions/016-broadcast-batching.md)) (or `--batch-min-clients=`) |
| `REQUIRE_OWNER` | `false` | When true, documents with no owner are inaccessible rather than open, and creating one requires an account. The lab, guest documents and the test harnesses all rely on the default (or `--require-owner=`). **Not a hardening switch** — it turns off the product decision in [ADR-010](docs/decisions/010-guest-documents.md) that writing needs no account. Rate limit the `socket` tier instead |
| `REDIS_URL` | _(unset)_ | Redis, for the session cache and rate-limit counters. **Optional, and unset is a supported configuration** — on a single instance the in-process fallback has no network hop and is faster. What Redis buys at one instance is that both survive a restart, which on a host that sleeps when idle is routine ([ADR-023](docs/decisions/023-redis-as-a-cache-and-rate-limiting.md)). Must be the TCP url; `rediss://` implies TLS (or `--redis-url=`) |
| `REDIS_PREFIX` | `collab` | Namespace for every key. Postgres gets this from schemas; Redis has no equivalent, so one instance can be shared by both engines' servers and a laptop without their counters colliding |
| `SESSION_CACHE_MS` | `30000` | How long a session lookup may be served from cache. `userForToken` is two sequential Postgres queries on every authenticated request and every WebSocket upgrade. `0` disables it, which every harness uses so that session revocation is asserted against the strict path |
| `RATE_LIMIT_AUTH` | `10` per 15 min | Login, signup and Google sign-in, per client address. These hash a password with scrypt at ~100ms of blocked event loop, so they are a denial-of-service vector before they are a credential-stuffing one. `0` switches the tier off (window: `RATE_LIMIT_AUTH_WINDOW_MS`) |
| `RATE_LIMIT_WRITE` | `120` per min | Every other non-GET (window: `RATE_LIMIT_WRITE_WINDOW_MS`) |
| `RATE_LIMIT_READ` | `600` per min | Every GET. `/api/health` is exempt — it is the health check and the keep-alive cron target (window: `RATE_LIMIT_READ_WINDOW_MS`) |
| `RATE_LIMIT_SOCKET` | `120` per min | WebSocket upgrades, refused before the handshake. Opening an unknown document id creates that document, so unmetered this is unbounded creation (window: `RATE_LIMIT_SOCKET_WINDOW_MS`) |
| `RATE_LIMIT_DISABLED` | `false` | Turns every tier off (or the bare flag `--no-rate-limit`, which `npm run dev:server` passes). For the BROWSER harnesses: they drive real Chrome against the shared dev servers, so fourteen harnesses of page loads and reconnects land on one address inside one window and read as abuse. Production runs the server directly and is unaffected |

Flags beat env vars, which beat defaults — npm scripts cannot set env vars
portably on Windows.

## What is next

Richer op visualisation, then multi-node scale-out — the seams it needs are
already in `backend/src/realtime/` with in-process implementations behind them
([ADR-019](docs/decisions/019-postgres-source-of-truth.md)).

Every decision that got the project here is in
[docs/decisions/](docs/decisions/), and on [`/decisions`](#routes).
