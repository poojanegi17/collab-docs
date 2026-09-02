import { useEffect } from 'react';

/**
 * Loads the display typeface at runtime.
 *
 * It lives in a hook rather than in index.html because the request is optional:
 * the token set names a full fallback stack, so a page renders correctly the
 * whole time this is in flight, and forever if it never arrives. Putting it in
 * the document head would make every route -- including the lab, which is an
 * instrument and has no business fetching a webfont -- wait on a third party.
 *
 * Reference counted. Three surfaces use this now, and an unmount that removed
 * the stylesheet while another page still wanted it would flip the whole app
 * back to the fallback face mid-navigation.
 */
const HREF = 'https://fonts.googleapis.com/css2'
  + '?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap';

let users = 0;
let nodes = [];

export function useDisplayFont() {
  useEffect(() => {
    users++;
    if (users === 1) {
      nodes = [
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
        { rel: 'stylesheet', href: HREF },
      ].map((attrs) => {
        const link = Object.assign(document.createElement('link'), attrs);
        document.head.appendChild(link);
        return link;
      });
    }
    return () => {
      users--;
      if (users === 0) {
        nodes.forEach((l) => l.remove());
        nodes = [];
      }
    };
  }, []);
}
