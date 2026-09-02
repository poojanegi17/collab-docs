# ADR-008: Version history — retention, checkpoints, and restore as an edit

**Status:** accepted

**Consequence:** Restoring is an ordinary edit, so a restore can itself be undone.

History is only free if folding the log keeps what it folds. Folding old
changes into a snapshot and throwing them away leaves anything older than that
with no recoverable past at all.

So folding archives instead of deleting, and the archive and the live log
concatenate back into one ordered history. Each fold also leaves a checkpoint
behind for free, so rebuilding an old version is the nearest checkpoint plus a
short replay, and naming a version is just labelling one of them.

Restoring appends the old text as a new edit rather than rewinding. Rewinding
would destroy every version after the one restored, and restoring is the thing
people do by accident. Under the CRDT the old characters are still there
underneath, which is what lets a restore merge with someone else's concurrent
typing instead of clobbering it.

Archived history ages out on a schedule, with checkpoints and the changes they
need pruned in step so no version is offered that cannot be rebuilt. Named
checkpoints are kept for good.
