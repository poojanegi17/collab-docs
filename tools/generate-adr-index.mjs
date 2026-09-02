/**
 * docs/decisions/*.md -> frontend/public/decisions.json
 *
 * A static asset rather than a bundled import, deliberately: the prose has
 * no business in the download for the landing page, and as a file in `public/`
 * it is fetched by the one route that renders it and by nobody else.
 *
 * There was briefly a second output -- a small index for a ledger panel on the
 * landing page. That panel became the /decisions route, and the index became a
 * JSON file in `frontend/src/` that no frontend code imported. Deleted rather
 * than kept "in case": the harness reads this file instead.
 *
 * Nothing here is authored. Number, title, status and the one-line consequence
 * are read out of the ADR, so the ledger cannot drift from the document it
 * summarises -- the failure mode of every hand-maintained index.
 * Adding an ADR means writing the ADR and re-running this.
 *
 *   node tools/generate-adr-index.mjs          # write
 *   node tools/generate-adr-index.mjs --check  # verify it is up to date (CI)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './lib/markdown.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'docs', 'decisions');

const OUT = join(root, 'frontend', 'public', 'decisions.json');

const parseAdr = (file) => {
  const text = readFileSync(join(SRC, file), 'utf8');

  const title = /^#\s*ADR-(\d+):\s*(.+?)\s*$/m.exec(text);
  if (!title) throw new Error(`${file}: no "# ADR-NNN: title" heading`);

  const status = /^\*\*Status:\*\*\s*(.+?)\s*$/m.exec(text);
  if (!status) throw new Error(`${file}: no "**Status:** ..." line`);

  // The one line the ledger shows. Required rather than optional: an ADR with
  // no stated consequence is one whose author has not finished thinking, and a
  // blank row in the ledger is worse than a build that says so.
  const consequence = /^\*\*Consequence:\*\*\s*(.+?)\s*$/m.exec(text);
  if (!consequence) throw new Error(`${file}: no "**Consequence:** ..." line`);

  // Everything below the Consequence line is the document proper. The heading
  // and the metadata lines are rendered from the fields above, so including
  // them again would print each ADR's title twice.
  const bodyAt = text.indexOf(consequence[0]) + consequence[0].length;

  return {
    id: title[1],
    title: title[2],
    status: status[1].trim(),
    consequence: consequence[1],
    // Where the ADRs are BROWSABLE is a deployment fact, not a property of the
    // decision, so the panel composes any URL from one configured base rather
    // than baking a repo path into fifteen rows.
    file,
    blocks: parse(text.slice(bodyAt), file),
  };
};

const adrs = readdirSync(SRC)
  .filter((f) => /^\d{3}-.*\.md$/.test(f))
  .sort()
  .map(parseAdr);


const json = `${JSON.stringify({ adrs })}
`;

if (process.argv.includes('--check')) {
  const current = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return null; } })();
  if (current !== json) {
    console.error('decisions.json is stale - run: node tools/generate-adr-index.mjs');
    process.exit(1);
  }
  console.log(`decisions.json up to date (${adrs.length} decisions)`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${adrs.length} decisions`
    + ` (${(json.length / 1024).toFixed(1)} KB)`);
}
