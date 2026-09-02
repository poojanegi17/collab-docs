# ADR-004: OT engine — server authority and bounded history

**Status:** accepted

**Consequence:** Server authority is real: work done while offline is discarded on reconnect.

An edit here describes a walk across the whole document rather than a position
and some text. Positional edits cannot be combined with one another, and
combining them is exactly what keeps a slow link from building an unbounded
backlog of typing.

The server decides the order. When two edits collide it always resolves them
the same way round, identically on every copy — that is the concrete meaning of
"server-authoritative". Each client keeps exactly one edit in flight, which
bounds how much history the server has to rewrite for anybody.

History is finite, so a client returning after too long cannot be caught up. It
is sent the current document and loses its unsent work, rather than silently
corrupting the shared one. That is the honest cost of this design, and the
reason the product does not use it.

The transform is checked against thousands of randomly generated documents on
every build, and the generator is seeded so any failure can be replayed exactly.
