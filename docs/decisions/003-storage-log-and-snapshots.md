# ADR-003: Append-only update log plus periodic snapshots

**Status:** accepted

**Consequence:** Kill the server mid-sentence, start it again, and nothing that was typed is lost.

Every keystroke produces a change. Rewriting the whole document for each one
costs more the longer the document gets, and makes storage the bottleneck long
before the network is.

So changes are appended to a log and never rewritten, which keeps a write the
same cost forever. Every so often the log is folded into a snapshot of the
document as it stood, so opening it later means reading one snapshot and a
short tail instead of replaying an entire history.

Writes never wait for a merge, so a keystroke is acknowledged immediately, and
recovery after a crash is just replaying that tail. Folding has to be
all-or-nothing, or a crash in the middle of it loses edits.

Storage never learns what any of the bytes mean, which is what lets both
engines share it. Snapshots hold the whole document, so a very large one makes
folding expensive — a later problem, not this one.
