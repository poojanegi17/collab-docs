# ADR-013: Images and tables, without introducing a tree

**Status:** accepted

**Consequence:** Neither engine changed at all, and no table-aware merge code exists anywhere.

The obvious way to add images and tables is a tree. Once the document is a
tree, every edit needs a path rather than a position and merging has to handle
nodes moving between parents — a research problem, for a feature that has
nothing to do with concurrency.

So an image is a single character that happens to carry a picture. It has one
position, so an insertion shifts it, a deletion removes it, a comment can
already point at it, and two people adding one at the same spot are already
ordered. The cost is that an image can be replaced but not edited.

A table is a run of lines with a separator character between cells. Text inside
a cell is ordinary document text, so two people typing in different cells are
just two people typing in one line. Merged cells, column widths and nested
tables are out, because each one smuggles the tree back in.

Nothing in either engine changed; the work is all in how the document is drawn.
It is asserted against both engines: an image survives concurrent editing
around it, and two clients typing in different cells converge. Pictures must be
linked rather than embedded, or every copy of the document would carry them
forever.
