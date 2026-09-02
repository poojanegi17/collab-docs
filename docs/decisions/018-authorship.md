# ADR-018: Authorship is free under the CRDT and built by hand under OT

**Status:** accepted

**Consequence:** The second asymmetry between the engines, and the first that favours the CRDT.

The CRDT already knows who wrote each character. Identity is not information
bolted on afterwards — it is the mechanism that puts the characters in order in
the first place.

The other engine structurally does not. It rewrites an incoming edit, applies
it and records the result; what survives is text, and the record of who typed
it never existed.

Both were built anyway, and the difference in what it cost is the finding. On
one side, reading what is already there, including for documents written before
the feature existed. On the other, a second record of one author per character,
kept in step by hand with every edit and against the rewritten version of it,
not the one the client sent.

Names are the sharper edge. The CRDT keeps identity inside the document, so it
merges like the text; the other engine has to learn names from whoever is
connected, so after a restart with nobody present the runs are right and the
names are gone. A document it wrote before this existed is unattributable,
permanently.
