# ADR-014: A tab is a document

**Status:** accepted

**Consequence:** A tab gets its own room, history and comments; sharing is inherited from the document.

Tabs are several independent bodies of text sharing one title, one owner and
one access list. A document here is already a precise thing, so the only real
question is where the seam goes.

Putting several texts inside one engine fails three ways: unrelated texts would
share one revision line, everything keyed by document would need re-plumbing,
and opening one tab would load all of them. So a tab is simply a document of
its own, with a name that says which document it belongs to.

Access is inherited, never copied. A per-tab copy of the permissions is a
second version of the truth, and its failure mode is a collaborator who can
read four tabs and not the fifth. A document with no tabs is one tab; adding a
second names the first rather than moving it, since moving it would rewrite a
history and orphan every comment.

Comments and history follow the tab, while the title, sharing and the task list
follow the document. Which tab you are looking at is your own view rather than
everyone's — a shared selection would yank other people's screens. Cursors are
per tab, so two people in different tabs are not editing the same text.
