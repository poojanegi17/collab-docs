# ADR-016: Batch broadcasts in a window, and let the engine decide

**Status:** accepted

**Consequence:** Messages drop 24x in a busy room; bytes barely move, because the bytes are the edits.

Relaying one person's keystroke to everyone else in the room means traffic in a
document grows with the square of the people in it. This is the first thing in
the system to break.

So outgoing changes are held for a fiftieth of a second, merged into one, and
sent once to the whole room. The engine has to allow it, and only the CRDT can:
its changes merge by construction, and applying one twice does nothing.

Measured with everyone typing, the number of messages collapses — about 25 times fewer
at a hundred editors — while the bytes fall by only about a third. Every client
genuinely needs every edit and no window makes an edit smaller, so the
quadratic cost never went away. What batching buys is paying it in bytes rather
than in messages, and a message is the expensive unit.

Below five people in a room batching is a loss, because the merged message goes
to everyone including whoever sent it, so it is switched off there — a
threshold read off the measurements rather than picked. The delay it adds stays
under the point where a remote cursor stops feeling live.
