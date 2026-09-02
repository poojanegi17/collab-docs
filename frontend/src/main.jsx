import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.jsx';
import { Lab } from './ui/lab/Lab.jsx';
import { Landing } from './ui/landing/Landing.jsx';
import { DocsPage } from './ui/docs/DocsPage.jsx';
import './ui/theme.css';
import './ui/styles.css';

/**
 * The long-form routes are split out of the main chunk.
 *
 * Everything used to be imported here, so opening the front page downloaded
 * the editor, the lab, /engines and /decisions whether or not
 * you ever visited one. That was already the wrong shape and the bundle
 * budget made it visible: adding diagrams to /decisions pushed the single
 * chunk over its ceiling, and the fix for "the front page is too big" is not
 * a bigger ceiling.
 *
 * These and not the others, deliberately. They are LEAF pages -- a
 * reader arrives, reads, and leaves -- so a chunk fetched on navigation costs
 * one request nobody is waiting on mid-interaction. The editor and the lab
 * stay eager: those are what somebody following a shared link is trying to
 * open, and a spinner in front of a document is worse than a larger download.
 */
const EnginesPage = lazy(() => import('./ui/engines/EnginesPage.jsx').then((m) => ({ default: m.EnginesPage })));
const DecisionsPage = lazy(() => import('./ui/decisions/DecisionsPage.jsx').then((m) => ({ default: m.DecisionsPage })));

/**
 * Three surfaces, no router dependency.
 *
 *   /       landing -- the explainer
 *   /docs   your documents
 *   /doc    editor    (?doc, ?client, ?engine, ?server)
 *   /lab    multi-replica lab
 *   /decisions  the decision record
 *   /engines    how concurrent edits are reconciled, in both engines
 *
 * Note the two are separate on purpose. The landing page is a designed
 * explainer with a fixed mosaic layout; a scrolling, sectioned document list
 * with per-row menus does not belong inside one of its tiles.
 *
 * Path-based because these are genuinely different pages, not states of one.
 * The `?lab` / `?doc=` query forms are kept as fallbacks for any static host
 * that does not rewrite unknown paths to index.html.
 */
const path = location.pathname.replace(/\/+$/, '');
const params = new URLSearchParams(location.search);

function route() {
  if (path === '/lab' || params.has('lab')) return <Lab />;
  if (path === '/decisions' || params.has('decisions')) return <DecisionsPage />;
  if (path === '/engines' || params.has('engines')) return <EnginesPage />;
  if (path === '/docs' || params.has('docs')) return <DocsPage />;
  if (path === '/doc' || params.has('doc')) return <App />;
  return <Landing />;
}

/*
 * One Suspense boundary around the lot. The fallback is deliberately almost
 * nothing: these chunks are tens of kilobytes on a connection that just
 * served the page, and a spinner that appears and vanishes inside 100ms reads
 * as a flicker rather than as progress.
 */
const element = <Suspense fallback={<div className="route-pending" />}>{route()}</Suspense>;

/**
 * Entrance boot, equivalent to the reference's inline <head> script: hide the
 * landing panels before the first paint so they can be revealed deliberately.
 *
 * It lives here rather than at module scope in Landing.jsx because that module
 * is imported on every route, and the class (plus its fail-safe timer) would
 * then be attached while you are editing a document.
 */
/* `route()` is called again here rather than reading `element.type`, which is
   now the Suspense wrapper for every route. */
if (route().type === Landing
  && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('motion-pending');
  window.__entranceFailsafe = setTimeout(
    () => document.documentElement.classList.remove('motion-pending'), 2400);
}

createRoot(document.getElementById('root')).render(element);
