import React from 'react';

/**
 * Render the token tree produced by `tools/lib/markdown.mjs`.
 *
 * There is no Markdown parser in this file and none in the bundle. The
 * conversion happened at build time in Node, and what arrives here is typed
 * tokens -- so this is a mapping from token to element, and there is no
 * `dangerouslySetInnerHTML` anywhere in the path. An unknown token renders as
 * nothing rather than as raw text, because the generator throws on constructs
 * it does not know and anything reaching here unrecognised is a bug upstream.
 */

function Inline({ nodes }) {
  return (
    <>
      {(nodes ?? []).map((n, i) => {
        switch (n.t) {
          case 'text': return <React.Fragment key={i}>{n.v}</React.Fragment>;
          case 'code': return <code key={i} className="md-code">{n.v}</code>;
          case 'strong': return <strong key={i}><Inline nodes={n.c} /></strong>;
          case 'em': return <em key={i}><Inline nodes={n.c} /></em>;
          case 'link': {
            // Relative links between the ADRs stay inside the page: every
            // decision is already rendered here, so following one should not
            // be a round trip to a file the reader may not be able to open.
            const local = /^(?:\.\/)?(\d{3})-[\w-]+\.md/.exec(n.href)
              ?? /decisions\/(\d{3})-[\w-]+\.md/.exec(n.href);
            const href = local ? `#adr-${local[1]}` : n.href;
            const external = /^https?:/.test(href);
            return (
              <a
                key={i}
                className="md-link"
                href={href}
                {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
              >
                <Inline nodes={n.c} />
              </a>
            );
          }
          default: return null;
        }
      })}
    </>
  );
}

export function Markdown({ blocks, shift = 0 }) {
  return (
    <>
      {(blocks ?? []).map((b, i) => {
        switch (b.t) {
          case 'heading': {
            // Shifted so a document's own `##` sits below the page's `<h1>`
            // and the ADR's `<h2>` title, rather than competing with them.
            const level = Math.min(6, b.d + shift);
            const Tag = `h${level}`;
            return <Tag key={i} className={`md-h md-h${level}`}><Inline nodes={b.c} /></Tag>;
          }
          case 'para':
            return <p key={i} className="md-p"><Inline nodes={b.c} /></p>;
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i} className="md-list">
                {b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}
              </Tag>
            );
          }
          case 'table':
            return (
              // Wrapped because these tables are wide and a phone is not. The
              // table scrolls; the page does not.
              <div key={i} className="md-table-wrap">
                <table className="md-table">
                  <thead>
                    <tr>{b.head.map((c, j) => <th key={j}><Inline nodes={c} /></th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>{row.map((c, k) => <td key={k}><Inline nodes={c} /></td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return <pre key={i} className="md-pre"><code>{b.v}</code></pre>;
          case 'quote':
            return (
              <blockquote key={i} className="md-quote">
                <Markdown blocks={b.c} shift={shift} />
              </blockquote>
            );
          case 'hr':
            return <hr key={i} className="md-hr" />;
          default:
            return null;
        }
      })}
    </>
  );
}
