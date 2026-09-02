# ADR-012: Comment anchors — relative under CRDT, server-authoritative under OT

**Status:** accepted

**Consequence:** Measured: anchors converge under insertion and diverge under deletion.

A comment is attached to a range of text. Between writing it and reading it,
other people insert and delete around and inside that range, and it has to
still be about the same words.

Under the CRDT an anchor names a character and the character carries it, so
there is nothing to keep in step. Under the other engine the server owns
anchors: it already decides the order everything happens in, so it moves every
anchor once in that order — convergence from authority rather than from the
algorithm.

That holds for insertions and fails for deletions, and the failure was measured
rather than assumed. Deleting text that straddles an anchor destroys the
characters that located it, so two copies applying the same pair of changes in
opposite orders can legally land it in different places. Thousands of concurrent
insertions converge; one pinned counterexample shows the same thing breaking
the moment a delete is allowed.

Deleting every commented character orphans the comment rather than reattaching
it to text it was never about. The counterexample is pinned rather than
described, so nobody later "fixes" the divergence by quietly weakening the test.
