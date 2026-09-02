# ADR-019: Postgres is the source of truth; anything in front of it is a cache

**Status:** accepted

**Consequence:** Nothing durable lives on the local disk, so a deploy that wipes it loses nothing.

The host throws its filesystem away on every deploy and every restart. A
document's history is the document, so anything durable kept there is destroyed
each time. A persistent disk is the host's own answer to that, and it pins the
service to a single machine.

So one database holds everything durable, keeping each engine's documents and
the shared list of people separated as before. There is no quiet fallback to a
local file: a server that degraded to the disk when it could not reach the
database would lose every document at the next restart, so it refuses to start
instead.

A keystroke is no longer a free write — it crosses a network — so writes are
gathered into a short window before being sent. That is a real reduction in
durability, bounded, configurable, and turned off entirely wherever a test
asserts on what was written.

Everything in front of the database may be lost: cursors, fan-out, the list of
open rooms, the write buffer. A change is durable when the database has it, and
nothing else is allowed to claim otherwise.
