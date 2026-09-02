# ADR-015: The task list is not a document

**Status:** accepted

**Consequence:** Deliberately not a CRDT — and the argument for why that instinct is wrong.

In a project built around CRDTs the instinct is to reach for the CRDT again,
and saying why that is wrong is the only interesting part of this decision.

Concurrent editing is expensive because two people change the same sequence at
overlapping positions and both changes have to survive. A checklist has none of
that shape: two additions are two rows, two ticks agree about the outcome, a
reword is last-writer-wins on a short string, and a deletion done twice is a
deletion. The only field two people race on is a checkbox, and when they race
they agree.

So tasks are rows, not text: changed and read over ordinary requests, with no
anchor into the document, because a task is about the document rather than
about a range inside it. Ticking is instant in the interface and confirmed by
the server, since a checkbox that waits for a round trip reads as broken.

The list belongs to the document rather than to a tab, and it behaves
identically under both engines with no engine-specific code — the claim being
tested is that there is no difference to hide. Tasks are not versioned:
restoring yesterday's prose should not roll back what is still to do.
