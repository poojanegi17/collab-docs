/**
 * The deployment configuration parses, and says what it is supposed to say.
 *
 *   node tools/config-check.mjs
 *
 * WHY THIS EXISTS, WRITTEN DOWN BECAUSE IT COST THREE RED RUNS
 *
 * `ci.yml` carried a step named
 *
 *   - name: Sanitisers -- no javascript: links, no CSS escaping its property
 *
 * and that is not YAML. A plain scalar may not contain `: ` -- the parser
 * reads `javascript:` as the start of a second mapping key and rejects the
 * whole file. GitHub answered with "Invalid workflow file ... line 72" and
 * created NO JOBS: no steps, no logs, no workflow graph, and no re-run button,
 * because there was nothing to re-run. Three pushes in a row reported failure
 * without a single test having executed, and the badge was red for a reason
 * that had nothing to do with the code it claims to vouch for.
 *
 * Every other check in this repository asserts something about the product.
 * This one asserts something about the FILES THAT DECIDE WHETHER ANY OF THEM
 * RUN, which is a different and prior question.
 *
 * WHERE IT EARNS ITS KEEP, AND WHERE IT CANNOT
 *
 * On a developer's machine, mostly. A workflow that does not parse never
 * reaches a runner, so no step inside that workflow could ever have caught
 * this -- by the time CI is in a position to check, CI is what is broken. So
 * the guard has to run BEFORE the push, which is why it is in `npm test`
 * rather than only in a job.
 *
 * `render.yaml` is the opposite case and is checked here for the opposite
 * reason: nothing local reads it at all, so the first thing that ever parses
 * it is Render, mid-deploy, with the site down if it is wrong.
 *
 * WHY A REAL PARSER AND NOT A REGEX
 *
 * The property worth asserting is "the parser GitHub uses will accept this",
 * and only a parser can answer that. A regex for the colon case would have
 * caught this one bug and left every other malformed-YAML bug to be found the
 * same expensive way. `yaml` is a dev dependency; nothing ships it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** Parse, or report the failure the way the platform would. @returns {any|null} */
function load(rel) {
  const file = path.join(root, rel);
  if (!existsSync(file)) {
    check(`${rel} exists`, false);
    return null;
  }
  try {
    const doc = parse(readFileSync(file, 'utf8'));
    check(`${rel} is valid YAML`, true);
    return doc;
  } catch (err) {
    // The line number is the whole value of this message: it is what turns
    // "the file is broken" into "line 72 is broken".
    const line = err?.linePos?.[0]?.line;
    check(`${rel} is valid YAML`, false,
      `${line ? `line ${line}: ` : ''}${err.message.split('\n')[0]}`);
    return null;
  }
}

console.log('\nDeployment configuration\n');

// ---------------------------------------------------------------------------
console.log('1. every workflow parses and can actually be triggered');
{
  const dir = path.join(root, '.github/workflows');
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];
  check('there is at least one workflow', files.length > 0, `${files.length} found`);

  for (const f of files) {
    const doc = load(`.github/workflows/${f}`);
    if (!doc) continue;

    /*
     * `on:` is the one key a YAML 1.1 parser turns into a BOOLEAN. `on`, `yes`
     * and `no` are all booleans in that revision, so the trigger block can
     * arrive under the key `true` rather than `on` depending on the parser.
     * Reading both is not defensive coding for its own sake -- it is the
     * difference between this check working and this check reporting that
     * every workflow in the repository has no triggers.
     */
    const on = doc.on ?? doc[true];
    check(`${f}: declares at least one trigger`,
      Boolean(on) && Object.keys(on).length > 0,
      on ? Object.keys(on).join(', ') : 'none — this workflow can never run');

    const jobs = doc.jobs ?? {};
    check(`${f}: has jobs`, Object.keys(jobs).length > 0,
      Object.keys(jobs).join(', ') || 'none');

    for (const [name, job] of Object.entries(jobs)) {
      const steps = job?.steps ?? [];
      check(`${f}: job "${name}" has steps`, steps.length > 0, `${steps.length}`);
      // A step that neither runs a command nor uses an action does nothing,
      // and is always a mistake rather than a deliberate no-op.
      const empty = steps.filter((s) => !s?.run && !s?.uses);
      check(`${f}: every step in "${name}" runs something`, empty.length === 0,
        empty.length ? `${empty.length} step(s) with neither run: nor uses:` : '');
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n2. the Render blueprint parses and describes deployable services');
{
  const doc = load('render.yaml');
  if (doc) {
    const services = doc.services ?? [];
    check('render.yaml declares services', services.length > 0, `${services.length}`);

    for (const s of services) {
      const label = s?.name ?? '(unnamed)';
      check(`${label}: has a name and a type`, Boolean(s?.name && s?.type),
        `${s?.type ?? '?'}`);

      /*
       * A `web` service needs something to serve. A node one needs a start
       * command; a static one needs a directory of built files. Getting this
       * wrong is a deploy that builds, goes live and answers nothing.
       */
      if (s?.type === 'web' && s?.runtime !== 'static') {
        check(`${label}: has a startCommand`, Boolean(s?.startCommand),
          s?.startCommand ?? 'missing');
        // Without one, Render cannot tell a booting instance from a broken
        // one, and rolls out a dead deploy as though it were healthy.
        check(`${label}: has a healthCheckPath`, Boolean(s?.healthCheckPath),
          s?.healthCheckPath ?? 'missing');
      }
      if (s?.runtime === 'static') {
        check(`${label}: has a staticPublishPath`, Boolean(s?.staticPublishPath),
          s?.staticPublishPath ?? 'missing');
      }

      /*
       * THE ONE THAT IS ABOUT SECRECY. `sync: false` is how a value is marked
       * "prompt for this, never store it in the file". A secret written as a
       * literal `value:` would be committed, and this repository's whole
       * position on credentials (see tools/security-check.mjs) is that they
       * are never in the tree.
       */
      const leaked = (s?.envVars ?? []).filter((e) => {
        const key = String(e?.key ?? '');
        const secretish = /DATABASE_URL|REDIS_URL|_KEY$|_SECRET$|PASSWORD|TOKEN/i.test(key);
        return secretish && e?.value !== undefined;
      });
      check(`${label}: no secret carries a literal value`, leaked.length === 0,
        leaked.map((e) => e.key).join(', '));
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
