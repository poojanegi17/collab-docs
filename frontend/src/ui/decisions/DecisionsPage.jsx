import React, { useEffect, useMemo, useState } from 'react';
import './decisions.css';
import { Markdown } from './Markdown.jsx';
import { Diagram, DiagramDefs } from '../diagram/Diagram.jsx';
import { BRIEFS } from './briefs.js';
import { useDisplayFont } from '../use-display-font.js';

/**
 * The decision record.
 *
 * The landing page's ledger is a summary and says so; this is the thing it
 * summarises. It is a route rather than a link to a file tree for one reason:
 * the decision record is the least common artifact in this repository, and a
 * reader who has to leave the site to find it mostly does not.
 *
 * Each decision is a card: a picture of the shape it takes, two sentences, and
 * the one-line consequence. The record itself is one click behind it, and it
 * is deliberately short -- a few plain paragraphs -- rather than an essay a
 * reader has to finish to learn what was decided.
 *
 * The prose is fetched, not bundled -- it has no business in the download for
 * the front page. See tools/generate-adr-index.mjs.
 */

const STATE = { loading: 'loading', ready: 'ready', failed: 'failed' };

export function DecisionsPage() {
  const [data, setData] = useState(null);
  const [state, setState] = useState(STATE.loading);
  const [open, setOpen] = useState(() => new Set());

  useDisplayFont();

  useEffect(() => {
    let cancelled = false;
    fetch('/decisions.json')
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((body) => { if (!cancelled) { setData(body); setState(STATE.ready); } })
      .catch(() => { if (!cancelled) setState(STATE.failed); });
    return () => { cancelled = true; };
  }, []);

  // Newest first, matching the landing ledger: the recent decisions are the
  // ones a reader arriving from that panel just saw.
  const adrs = useMemo(() => (data ? [...data.adrs].reverse() : []), [data]);

  /**
   * A deep link opens the record it points at.
   *
   * `/engines` links to `#adr-004` to justify a claim it just made, so landing
   * on a collapsed card would answer the question with a summary of itself.
   * Runs once, after the fetch: the element does not exist before then, which
   * is also why the browser's own scroll-to-anchor has already given up by the
   * time this happens and the scroll is redone here.
   */
  useEffect(() => {
    if (state !== STATE.ready) return undefined;

    const openFromHash = () => {
      const id = decodeURIComponent(window.location.hash.replace('#', ''));
      if (!id.startsWith('adr-')) return;
      setOpen((prev) => new Set(prev).add(id.slice(4)));
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'start' });
      });
    };

    openFromHash();
    /*
     * And again on `hashchange`, which is not belt and braces -- it is the
     * only path for a reader who is ALREADY on this page. Changing nothing but
     * the fragment does not reload the document, so React never remounts and
     * an effect keyed on load state never runs again: the URL would say
     * adr-016 while the card sat closed. Caught by tools/landing-test.mjs,
     * which navigates to the page and then to an anchor on it.
     */
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, [state]);

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  if (state === STATE.loading) {
    return <div className="dec-page dec-thin"><p className="dec-note">Loading the decision record…</p></div>;
  }
  if (state === STATE.failed) {
    return (
      <div className="dec-page dec-thin">
        <a className="dec-back" href="/">&larr; back</a>
        <p className="dec-note">
          The decision record could not be loaded. It is generated into
          <code> frontend/public/decisions.json</code> by
          <code> tools/generate-adr-index.mjs</code>, which runs as part of
          <code> npm run build</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="dec-page">
      <DiagramDefs />

      <header className="dec-head">
        <a className="dec-back" href="/">&larr; collab-docs</a>
        <h1>Decisions</h1>
        <p className="dec-lede">
          Every non-obvious choice, written down when it was made rather than
          reconstructed afterwards. A picture and two sentences each — the full
          record is one click away on any of them.
        </p>
        {/* No dates anywhere on this page. A decision is not made better or
            worse by when it was taken, and a reader scanning for the argument
            does not need a timeline -- the numbers already carry the order. */}
        <p className="dec-meta">{adrs.length} decisions</p>
      </header>

      <main className="dec-grid">
        {adrs.map((a) => {
          const extra = BRIEFS[a.id];
          const isOpen = open.has(a.id);
          return (
            <article className="dec-card" id={`adr-${a.id}`} key={a.id}>
              <div className="adr-kicker">
                <span className="adr-kicker-num">ADR-{a.id}</span>
                <span className={`adr-status is-${a.status.replace(/\s+/g, '-')}`}>{a.status}</span>
              </div>

              <h2 className="adr-h">{a.title}</h2>

              {extra?.diagram && (
                <div className="dec-dia"><Diagram spec={extra.diagram} /></div>
              )}

              {/* The brief, then the consequence. Two different jobs: what was
                  decided, and what it did to the system. */}
              {extra?.brief && <p className="dec-brief">{extra.brief}</p>}
              <p className="adr-consequence">{a.consequence}</p>

              <button
                type="button"
                className="dec-more"
                aria-expanded={isOpen}
                aria-controls={`adr-full-${a.id}`}
                onClick={() => toggle(a.id)}
              >
                {isOpen ? 'Hide the full record' : 'Read the full record'}
              </button>

              {/* Rendered only when open. The full record is tens of thousands
                  of words of markdown blocks; mounting them all and hiding them
                  with CSS costs the same as never having collapsed them. */}
              {isOpen && (
                <div className="adr-prose" id={`adr-full-${a.id}`}>
                  <Markdown blocks={a.blocks} shift={1} />
                </div>
              )}
            </article>
          );
        })}
      </main>
    </div>
  );
}
