# ADR-011: Attributes that carry values, and the boundary they need

**Status:** accepted

**Consequence:** A collaborator's formatting value is untrusted input and meets an allowlist before it reaches the page.

Growing eight on-or-off marks into a word-processor toolbar needs no change to
the machinery underneath, which does not care what the marks are called. What
had to be decided is what the new ones are.

There turn out to be three kinds: flags like bold, values like colour, size,
font and links, and line-level ones like headings and alignment. Only the
middle kind becomes styling or a link on the page, and it is written by whoever
is editing and arrives over the network — which makes it untrusted input.

So exactly one place turns a value into something the page renders, and it
checks against a list of what is allowed rather than trying to neutralise what
is not. A refused value drops the formatting and keeps the words. The check
lives at the point of rendering, not the point of typing, because an attacker
need not use the typing path at all.

Bulleted and numbered are one setting with two values, not two independent
switches, so a line can never claim to be both. The number on an ordered list
is worked out from the lines above rather than stored, since storing it would
make every insertion rewrite the document.
