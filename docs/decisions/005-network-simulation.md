# ADR-005: Network simulation by socket substitution

**Status:** accepted

**Consequence:** The lab can cut one replica off the network without a line of sync code knowing.

The lab needs to slow, drop and black-hole traffic for one client at a time,
and to show every frame going in both directions. The question is where that
hooks in.

It hooks in at the connection. The lab hands the sync layer something that
behaves exactly like a real connection and is not one, so nothing above it
changes and no engine code is aware. This is the payoff of writing the
transport by hand — you cannot instrument a dependency you do not own.

Three limits are deliberate. Frames are never reordered, because a real
connection does not do that and faking it would break a client for a reason
that cannot happen. Dropped frames are labelled a thought experiment. And a
partition is silent: the connection stays open, nothing crosses, no error
fires, which is nastier than pulling the cable.

Defects that no amount of green testing reaches become reproducible, because
the lab can create the condition rather than wait for it. Under a two-second
link, a burst of typing reaches the other replica in about 2.3 seconds with the
CRDT and about 6.1 with OT, where one edit in flight costs two round trips.
