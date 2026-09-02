# ADR-002: Isolate concurrency control behind an engine interface

**Status:** accepted

**Consequence:** Nothing above the engine layer knows which algorithm runs underneath, and a test enforces it.

The goal is to run both algorithms and compare them. They need different things
from a server: one can broadcast and forget, the other must hold the
authoritative document and answer the sender as well as everyone else. Assume
the first shape everywhere and adding the second stops being a feature and
becomes a rewrite.

So there is one interface on each side — one on the server, one in the editor —
and the engine sits behind it. Everything above it is written once: the editor,
formatting, cursors, comments, storage and the API. The only freedom the
interface grants is deciding who a reply goes to.

Three rules keep it honest. Nothing above the line names a specific engine,
storage keeps sealed bytes it never interprets, and cursors are handled by the
transport rather than the engine so they behave identically under both.

Adding the second engine should therefore touch the engine and almost nothing
else. If transport, storage or presence needed changes, the seam leaked.
ADR-004 reports how it went.
