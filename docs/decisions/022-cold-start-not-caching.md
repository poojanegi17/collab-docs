# ADR-022: Boot maintenance runs after the port opens

**Status:** accepted

**Consequence:** The first visit waits for a container to start, and for nothing else.

The site is slow on the first visit after a quiet period, and the obvious
suspect is the database. Two measurements say otherwise.

The two suspensions are not the same size. The database wakes in a few hundred
milliseconds; the machine hosting the site takes tens of seconds. The database
was under one percent of the wait.

A cache could not have helped either, because the wait was housekeeping done
before the site started answering at all — and a cache of the database cannot
tell you which rows the database is missing. None of that work is needed to
serve a request, so it now runs after the door is open, and a scheduled ping
keeps the machine awake, which keeps the database warm as a side effect.

Housekeeping can therefore be interrupted, so a document may go unindexed
across a boot that was cut short. Every task is safe to run again and does so
next time, which is why it is allowed to fail without taking the server down.
