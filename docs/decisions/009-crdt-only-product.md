# ADR-009: CRDT for the product, OT for the lab

**Status:** accepted

**Consequence:** The product is CRDT-only; the choice moved to the lab, where it is shown rather than asked.

Offering both engines everywhere makes somebody choose a concurrency algorithm
before they can write anything down — with real consequences, since under one of
them work done offline is discarded — and with nothing in the product to judge
the choice against. Two buttons teach nobody the difference; they only ask.

So every document on the site is a CRDT. No engine picker and no engine badge,
which with one engine would label every row identically.

The other engine stays, whole: the engine, the shared transform and every
property test, with its server still running. The seam is only real while a
second implementation keeps it honest.

The lab is where the engine is a choice, next to the machinery that makes the
comparison legible — real replicas, injectable partitions and a decoded
timeline. The price is that a document made on one engine does not exist on the
other, which is cheaper than asking a writer to pick an algorithm.
