import React from 'react';

/**
 * Inline SVG only — no icon library, no raster assets.
 *
 * Two marks, because the page draws two. There are no brand logos here: this
 * project has no integrations, so shipping a third party's mark would claim
 * something untrue.
 */

/** The magnifier in the introduction's search field. */
export const Search = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="10.6" cy="10.6" r="7.1" stroke="#121212" strokeWidth="2.2" />
    <path d="M15.9 15.9 21 21" stroke="#121212" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

/** Trails the "Open the lab" link on the demo band. */
export const Arrow = () => (
  <svg className="arrow" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M2.6 8h10.2M9.1 4.3 12.8 8l-3.7 3.7" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
