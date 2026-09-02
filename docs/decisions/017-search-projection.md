# ADR-017: Search reads a projection, not the log

**Status:** accepted

**Consequence:** One index serves both engines, and it may be a couple of seconds behind.

"Which of my documents mentions the aqueduct at Segovia" had no answer at
either end of the system. The client has never seen a document it is not open
on, and the server stores every document in full without being able to read a
word of it — which is exactly why storage survived a second engine untouched.

So search reads the plain text through the one part of the engine interface
that speaks content, and keeps its own index beside the documents. The index is
derived: it is authoritative about nothing, and dropping it loses nothing.

Re-reading a document cannot sit on the path of every keystroke, so indexing
lags behind typing by a short pause. The cost is stated rather than hidden: a
search may miss the last couple of seconds of writing.

A query is words, not a query language. Input is split on punctuation and each
word treated literally, so a title with brackets in it is not a syntax error
and a capitalised word never quietly means something. Results are limited to
what you are allowed to open.
