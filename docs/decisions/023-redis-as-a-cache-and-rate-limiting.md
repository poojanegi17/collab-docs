# ADR-023: Redis is optional, and rate limiting comes first

**Status:** accepted

**Consequence:** An unauthenticated request can no longer buy a tenth of a second of this server's only thread.

Checking a password is deliberately slow — about a tenth of a second of work —
because that is what makes guessing at a stolen copy of it expensive. But this
server has one thread and signing in needs no account, so the same property
turns a cheap request into a tenth of a second of blocked server. A few hundred
a second and it answers nothing at all, including the connections carrying
every open document.

So requests are counted and limited centrally, before they reach anything, in
four tiers. Centrally, because a limit each route has to remember to apply is
one that a new route will forget.

| tier | covers | default |
|---|---|---|
| sign-in | login, signup, signing in with a provider | 10 per 15 min |
| write | every other change | 120 per minute |
| read | everything that only reads | 600 per minute |
| connect | opening a document connection | 120 per minute |

Counting is per address, never per account: counting sign-in attempts per email
would hand anyone a way to lock a specific person out of their own account. New
connections are counted before they are accepted, because opening an unknown
document creates it.

Redis is optional and its absence is a supported configuration, not a degraded
one — on a single machine, counting in memory is faster. What Redis buys is
counters that survive a restart, since a limit held in memory hands an attacker
a fresh allowance for waiting.
