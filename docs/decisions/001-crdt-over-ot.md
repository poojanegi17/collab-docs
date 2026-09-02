# ADR-001: Use a CRDT (Yjs) first, not OT

**Status:** accepted

**Consequence:** Offline editing is nearly free, but a document never shrinks back to just its text.

Two families of algorithm solve live collaboration. One sends every edit to a
central server that rewrites it against everything the sender had not seen yet.
The other gives every character a permanent identity, so edits merge in any
order, on any copy, with no referee.

We took the second, reusing a proven implementation of the data structure and
writing the network, server, presence and persistence around it by hand. The
merging is the subtle part, and reusing it removes a whole class of bugs we
would otherwise have written ourselves.

The payoff is that the server relays bytes it never has to understand, which is
what makes working offline cheap. The price is size: deleted characters leave
markers behind, so a document costs more than the words in it and never gets
smaller again.

The other approach was built later, as a second engine to compare against
rather than to ship. Writing it first would have spent the entire budget on
getting one transform right.
