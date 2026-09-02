# ADR-021: Importing a document from Drive

**Status:** accepted

**Consequence:** An import produces an independent document, and whatever will not fit is reported.

A document can be brought in from Drive, and the question that matters is
whether it stays connected to the original. It cannot, sensibly: a two-way
bridge means two concurrency systems arbitrating one document, with one of them
winning, which inverts the thesis of this project.

So it is an import, not a sync. The file is exported once, converted into this
editor's own formatting, and becomes an ordinary document here. There is no
link back and the original is never written to.

Only the files you hand over are read, never everything you own, and nothing is
kept afterwards that would let this application read your Drive while you are
away. The whole job finishes in seconds, while you watch — so it needs no
standing permission and involves no server of ours at all.

What will not survive the conversion is counted and named rather than quietly
dropped. Tables become paragraphs: the grid is lost, the words are not. Pictures
stay hosted where they were, which means they can stop resolving later, and
that is reported too rather than fixed by copying them into the document
forever.
