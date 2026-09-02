/**
 * The shared checklist for one document (ADR-015).
 *
 * Structurally the dullest hook in the project, and that is the finding worth
 * writing down: a task list is collaborative without being concurrent. Two
 * people ticking the same box agree about the outcome, two people adding items
 * do not conflict, and nobody edits the same sentence character by character
 * -- so none of the machinery the text needs earns its place here. HTTP writes,
 * a socket frame that says "changed", and one re-read.
 *
 * Scoped to the DOCUMENT, so it is the same list from every tab: the hook is
 * handed `docId` and never the tab it is being rendered next to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api.js';

export function useTasks({ sync, engine, docId, user, localUser, canEdit }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const inflight = useRef(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      try {
        const { tasks: list } = await api.listTasks(engine, docId);
        setTasks(list ?? []);
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
  }, [engine, docId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => sync.on('tasks', () => { refresh(); }), [sync, refresh]);
  useEffect(() => sync.on('synced', () => { refresh(); }), [sync, refresh]);

  /** Who to credit on a guest document, where there is no session (ADR-010). */
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

  const add = useCallback((body) => wrap(
    () => api.createTask(engine, docId, { body, ...authorFields })),
  [wrap, engine, docId, authorFields]);

  /**
   * Tick or untick.
   *
   * The new state is applied to local state before the request lands. A
   * checkbox that waits for a round trip before moving feels broken on a slow
   * connection, and this is the one control in the app people click in
   * sequence. `refresh` replaces the guess with the server's answer either
   * way, including when the request fails.
   */
  const setDone = useCallback((taskId, done) => {
    setTasks((list) => list.map((t) => (t.id === taskId ? { ...t, done } : t)));
    return wrap(() => api.updateTask(engine, docId, taskId, { done, ...authorFields }));
  }, [wrap, engine, docId, authorFields]);

  const edit = useCallback((taskId, body) => wrap(
    () => api.updateTask(engine, docId, taskId, { body })), [wrap, engine, docId]);

  const remove = useCallback((taskId) => wrap(
    () => api.deleteTask(engine, docId, taskId)), [wrap, engine, docId]);

  /** Open first, then done -- and stable within each half. */
  const ordered = useMemo(() => {
    const open = tasks.filter((t) => !t.done);
    const done = tasks.filter((t) => t.done);
    return { open, done, all: [...open, ...done] };
  }, [tasks]);

  return {
    tasks, ...ordered, loading, error, refresh, add, setDone, edit, remove,
    openCount: ordered.open.length,
  };
}
