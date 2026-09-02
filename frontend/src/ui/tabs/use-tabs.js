/**
 * The tab list for one document, and which tab is open.
 *
 * The split, which is the same one `use-comments.js` makes:
 *
 *   the server   owns the list -- titles, order, existence
 *   the socket   says when it changed
 *   this hook    owns which tab THIS person is looking at, and nothing else
 *
 * "Which tab is open" is deliberately local. It is a view state, not a
 * document state: two people reading the same document are usually reading
 * different parts of it, and a shared cursor into the tab strip would mean one
 * person's click yanks everyone else's screen away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../api.js';

/**
 * `activeId` is passed IN rather than kept here, because the thing it decides
 * is which document the sync layer is connected to -- and that connection is
 * owned by App. A hook holding its own copy would be a second answer to
 * "which tab am I in", and the two would disagree for one render every time
 * one changed, which is one render of the wrong document's text.
 */
export function useTabs({ sync, engine, docId, canEdit, activeId, onActivate }) {
  const [tabs, setTabs] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Same re-entrancy guard as the comments hook: `refresh` is called from a
  // socket event, and two frames in one tick would each fetch, with the later
  // response able to land first.
  const inflight = useRef(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const run = (async () => {
      try {
        const { tabs: list } = await api.listTabs(engine, docId);
        setTabs(list ?? []);
        setError(null);
        return list ?? [];
      } catch (e) {
        setError(e.message ?? String(e));
        return [];
      } finally {
        setLoading(false);
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, [engine, docId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => sync.on('tabs', () => { refresh(); }), [sync, refresh]);
  // A reconnect may have missed a frame. Cheap, and the alternative is a strip
  // that is quietly out of date for as long as the tab stays open.
  useEffect(() => sync.on('synced', () => { refresh(); }), [sync, refresh]);

  /**
   * Follow the tab the URL names, and fall back when it stops existing.
   *
   * The fallback is the load-bearing half. A collaborator can delete the tab
   * you are reading, and without this the editor keeps a socket open to a tab
   * the server now refuses -- which presents as a document that will not
   * connect, with no explanation.
   */
  useEffect(() => {
    if (!tabs.length) return;
    if (tabs.some((t) => t.tabId === activeId)) return;
    // Not while a fetch is in flight, and this guard is not defensive padding
    // -- without it, ADDING a tab immediately undid itself. `add` activates
    // the new tab and then re-reads the list, so there is one render in
    // between where `activeId` is the new tab and `tabs` is the list from
    // before it existed. This effect read that as "the tab you are in is
    // gone" and sent the person back to tab one, one frame after opening the
    // tab they had just asked for.
    //
    // A ref rather than state on purpose: `tabs` changing when the fetch lands
    // re-runs this effect anyway, so a genuinely missing tab is still caught
    // one render later.
    if (inflight.current) return;
    onActivate(tabs[0].tabId);
  }, [tabs, activeId, onActivate]);

  // Keep the address bar honest without adding a history entry per click:
  // switching tabs is not navigation, and Back should leave the document
  // rather than walk through every tab you looked at.
  useEffect(() => {
    const url = new URL(location.href);
    const current = url.searchParams.get('tab');
    const wanted = activeId === docId ? null : activeId;
    if (current === wanted) return;
    if (wanted) url.searchParams.set('tab', wanted);
    else url.searchParams.delete('tab');
    history.replaceState(null, '', url);
  }, [activeId, docId]);

  const active = useMemo(
    () => tabs.find((t) => t.tabId === activeId) ?? tabs[0] ?? null,
    [tabs, activeId]);

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

  const add = useCallback((title = 'Untitled tab') => wrap(async () => {
    const { tab } = await api.createTab(engine, docId, title);
    // Open it. Adding a tab you then have to find is a two-step version of one
    // action, and every editor that has tabs works this way.
    if (tab) onActivate(tab.tabId);
    return tab;
  }), [wrap, engine, docId, onActivate]);

  const rename = useCallback((tabId, title) => wrap(
    () => api.updateTab(engine, docId, tabId, { title })), [wrap, engine, docId]);

  const move = useCallback((tabId, index) => wrap(
    () => api.updateTab(engine, docId, tabId, { index })), [wrap, engine, docId]);

  const remove = useCallback((tabId) => wrap(async () => {
    await api.deleteTab(engine, docId, tabId);
    // Do not choose the next tab here. The effect above does it from the
    // refreshed list, which is also what happens when somebody ELSE deletes
    // the tab you are in -- one path, so both behave the same.
    return true;
  }), [wrap, engine, docId]);

  return {
    tabs, active, loading, error, refresh, add, rename, move, remove,
  };
}
