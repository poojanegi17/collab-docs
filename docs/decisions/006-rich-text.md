# ADR-006: Rich text — formatting as an ordinary edit

**Status:** accepted

**Consequence:** Formatting rides on an ordinary edit, which saved nine collision cases in the transform.

Rich text over a tree structure is a research project. Over a flat sequence of
characters it is not, and this is meant to be an editor somebody would actually
write in, which plain text is not.

So bolding is expressed as "move across five characters and change how they
look". It neither inserts nor deletes, so the length arithmetic underneath is
untouched — a dedicated formatting edit would have added nine new collision
cases instead of none. Line-level formatting rides on the newline that ends the
line, which keeps the document flat rather than a tree.

Formatting is nearly free under the CRDT, where it lives on the character
itself, and costs real work under the other engine, which has to carry it
through every collision. Concurrent bold and un-bold is a tie with no
plain-text equivalent: both sides agree on the letters and disagree on the look.

Randomised testing found two bugs within a few hundred runs that no
hand-written test would have. Both left documents that still looked right,
which is why the checks compare whole documents rather than the visible text.
