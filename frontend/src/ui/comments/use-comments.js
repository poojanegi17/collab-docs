/**
 * All the comment state for one document, in one hook.
 *
 * The split of responsibilities is the interesting part, and it is the same
 * split ADR-012 argues for:
 *
 *   the server   owns thread bodies, and (under OT) the authoritative anchors
 *   the engine   owns where an anchor IS right now, in current coordinates
 *   this hook    owns neither, and never computes a position itself
 *
 * That last line is load-bearing. It would be easy to keep a `{from, to}` in
 * React state and map it through edits here -- and it would be wrong under OT
 * for the reason the property tests measure, and redundant under the CRDT.
 * Positions are read back out of the sync layer every time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api.js';

export function useComments({ sync, engine, docId, user, localUser, canEdit }) {
  const [threads, setThreads] = useState([]);
  const [ranges, setRanges] = useState(new Map());
  const [activeId, setActiveId] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Guards a re-entrancy problem rather than a performance one: `refresh` is
  // called from a socket event, and two frames arriving in one tick would each
  // fetch and each call trackAnchors, with the later response able to land
  // first and install stale anchors.
  const inflight = useRef(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      try {
        const { threads: list } = await api.listComments(engine, docId);
        setThreads(list ?? []);
        // Hand the engine the anchors it should keep current. It resolves
        // them; we never do.
        sync.trackAnchors((list ?? []).map((t) => ({ id: t.id, anchor: t.anchor })));
        setRanges(new Map(sync.resolvedAnchors()));
        setError(null);
      } catch (e) {
        setError(e.message ?? String(e));
      } finally {
        setLoading(false);
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, [sync, engine, docId]);

  useEffect(() => { refresh(); }, [refresh]);

  // The engine tells us when anchors move -- on every keystroke under OT, on
  // every transaction under the CRDT. Bodies are untouched, so this does not
  // re-fetch anything.
  useEffect(() => sync.on('anchors', (m) => setRanges(new Map(m))), [sync]);

  // The server tells us when the LIST changed. Only then do we go back to HTTP.
  useEffect(() => sync.on('comments', () => { refresh(); }), [sync, refresh]);

  // Re-read after a reconnect. Under OT this is the moment the server's
  // authoritative anchors replace whatever this client transformed while it
  // was away, which is the whole point of the server owning them (ADR-012).
  useEffect(() => sync.on('synced', () => { refresh(); }), [sync, refresh]);

  /** Author fields, only consulted for guest documents (ADR-010). */
  const authorFields = useMemo(() => (user
    ? {}
    : { authorName: localUser?.name, authorColor: localUser?.color }), [user, localUser]);

  const wrap = useCallback(async (fn) => {
    if (!canEdit) return null;
    try {
      const result = await fn();
      await refresh();
      return result;
    } catch (e) {
      setError(e.message ?? String(e));
      return null;
    }
  }, [canEdit, refresh]);

  const addThread = useCallback(({ from, to, quote, body }) => wrap(async () => {
    // The anchor is minted by the engine at the moment of asking, and carries
    // whatever that engine needs -- a pair of relative positions, or a pair of
    // indices plus the revision they were measured against.
    const anchor = sync.createAnchor(from, to);
    const { thread } = await api.createThread(engine, docId, {
      anchor, quote, body, ...authorFields,
    });
    setActiveId(thread.id);
    return thread;
  }), [wrap, sync, engine, docId, authorFields]);

  const reply = useCallback((threadId, body) => wrap(
    () => api.replyToThread(engine, docId, threadId, { body, ...authorFields })),
  [wrap, engine, docId, authorFields]);

  const resolve = useCallback((threadId, resolved) => wrap(
    () => api.resolveThread(engine, docId, threadId, resolved)),
  [wrap, engine, docId]);

  const remove = useCallback((threadId) => wrap(
    () => api.deleteThread(engine, docId, threadId)),
  [wrap, engine, docId]);

  const removeComment = useCallback((threadId, commentId) => wrap(
    () => api.deleteComment(engine, docId, threadId, commentId)),
  [wrap, engine, docId]);

  /**
   * Threads joined to their current positions.
   *
   * A thread whose anchor resolves to nothing is `orphaned` here even when the
   * server still thinks otherwise -- under the CRDT the server relays bytes
   * and cannot know, so the client is the only party that can see it.
   */
  const decorated = useMemo(() => threads.map((t) => {
    const range = ranges.get(t.id) ?? null;
    return { ...t, range, orphaned: t.orphaned || range === null };
  }), [threads, ranges]);

  /** What the editor draws. Orphaned threads have nothing to draw. */
  const commentRanges = useMemo(() => decorated
    .filter((t) => t.range)
    .map((t) => ({ id: t.id, from: t.range.from, to: t.range.to, resolved: t.resolved })),
  [decorated]);

  return {
    threads: decorated,
    commentRanges,
    activeId,
    setActiveId,
    loading,
    error,
    addThread,
    reply,
    resolve,
    remove,
    removeComment,
    refresh,
  };
}
