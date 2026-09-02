/**
 * The security properties of the storage layer, asserted rather than believed.
 *
 *   node tools/security-check.mjs
 *
 * Facts that are only ever checked by hand stop being true quietly, and every
 * one of these is that kind: a role attribute someone widens to unblock a
 * migration, an identifier that starts being interpolated, a connection string
 * that finds its way into the client bundle.
 *
 * This asserts the CURRENT design. It is not a claim that the application is
 * secure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../backend/src/config.js';
import { Db } from '../backend/src/storage/db.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0, warn = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const note = (name, detail) => { console.log(`  WARN  ${name}  -- ${detail}`); warn++; };

console.log('\nSecurity checks\n');

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
console.log('1. the runtime role is least-privilege');
{
  const db = new Db({ connectionString: config.databaseUrl, schema: 'public', max: 2 });
  const me = await db.one('SELECT current_user AS who');
  const attrs = await db.one(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication
     FROM pg_roles WHERE rolname = current_user`);

  check('the server does not connect as the schema owner',
    me.who !== 'neondb_owner', `connected as "${me.who}"`);
  check('not SUPERUSER', attrs.rolsuper === false);
  check('not CREATEDB', attrs.rolcreatedb === false);
  check('not CREATEROLE', attrs.rolcreaterole === false);
  check('not BYPASSRLS', attrs.rolbypassrls === false);
  check('not REPLICATION', attrs.rolreplication === false);

  // What it must be ABLE to do, so a future tightening cannot break the app
  // silently: this file would fail rather than production.
  const can = async (label, sql, expect) => {
    let ok;
    try { await db.query(sql); ok = true; } catch { ok = false; }
    check(`${expect ? 'can' : 'cannot'} ${label}`, ok === expect);
  };
  await can('read the update log', 'SELECT 1 FROM yjs.updates LIMIT 1', true);
  await can('create a table', 'CREATE TABLE yjs._sec_probe (a int)', false);
  await can('create a schema', 'CREATE SCHEMA _sec_probe', false);
  await can('create a role', 'CREATE ROLE _sec_probe', false);
  await can('drop the update log', 'DROP TABLE yjs.updates', false);
  await can('read password hashes from pg_authid',
    'SELECT rolpassword FROM pg_authid LIMIT 1', false);
  await db.close();
}

// ---------------------------------------------------------------------------
console.log('\n2. the connection is encrypted and pooled');
{
  check('DATABASE_URL requires TLS',
    /sslmode=(require|verify-ca|verify-full)/.test(config.databaseUrl),
    config.databaseUrl.replace(/(:\/\/[^:]*:)[^@]*@/, '$1****@').split('?')[1] ?? '');

  // Neon terminates TLS at the pooler, so `pg_stat_ssl` inside the session
  // reports false and proves nothing. What DOES prove something: an
  // unencrypted connection must be refused.
  let plaintextRefused = false;
  try {
    const plain = new pg.Pool({
      connectionString: config.databaseUrl.replace(/sslmode=[a-z-]+/, 'sslmode=disable'),
      ssl: false,
      connectionTimeoutMillis: 10_000,
      max: 1,
    });
    await plain.query('SELECT 1');
    await plain.end();
  } catch { plaintextRefused = true; }
  check('the server refuses an unencrypted connection', plaintextRefused);

  const db = new Db({ connectionString: config.databaseUrl, schema: 'public' });
  check('the pool has a bounded size', db.pool.options.max > 0 && db.pool.options.max <= 20,
    `max=${db.pool.options.max}`);
  check('idle clients are reaped', db.pool.options.idleTimeoutMillis > 0,
    `${db.pool.options.idleTimeoutMillis}ms`);
  check('connecting cannot hang forever', db.pool.options.connectionTimeoutMillis > 0,
    `${db.pool.options.connectionTimeoutMillis}ms`);
  await db.close();
}

// ---------------------------------------------------------------------------
console.log('\n3. identifiers cannot be injected');
{
  // The only things ever interpolated into SQL are the schema name and the
  // app role. Both are validated; neither comes from a request.
  const rejects = (schema) => {
    try { new Db({ connectionString: config.databaseUrl, schema }); return false; }
    catch { return true; }
  };
  check('a schema name with a quote is rejected', rejects('a"b'));
  check('a schema name with a semicolon is rejected', rejects('a; DROP TABLE x'));
  check('a schema name with a space is rejected', rejects('a b'));
  check('an uppercase schema name is rejected', rejects('Yjs'));
  check('a legitimate schema name is accepted', !rejects('t_scratch_1'));

  const src = fs.readFileSync(path.join(root, 'backend/src/storage/store.js'), 'utf8')
    + fs.readFileSync(path.join(root, 'backend/src/storage/accounts.js'), 'utf8');
  // Every value reaches Postgres as $1, $2, ... A template literal carrying a
  // JS expression into a query string is the thing this forbids.
  const interpolated = [...src.matchAll(/query\(\s*`[^`]*\$\{([^}]+)\}/g)].map((m) => m[1]);
  check('no query in store.js or accounts.js interpolates a value',
    interpolated.length === 0, interpolated.join(', '));
}

// ---------------------------------------------------------------------------
console.log('\n4. no credential reaches the client');
{
  const dist = path.join(root, 'frontend/dist');
  if (!fs.existsSync(dist)) {
    note('the built bundle was not scanned', 'run `npm run build` first');
  } else {
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        e.isDirectory() ? walk(p) : files.push(p);
      }
    };
    walk(dist);
    const bad = files.filter((f) => {
      const t = fs.readFileSync(f);
      return /postgres(ql)?:\/\/|neondb_owner|collab_app|sslmode=/i.test(t.toString('utf8'));
    });
    check('the built bundle contains no connection string or role name',
      bad.length === 0, bad.map((f) => path.relative(root, f)).join(', '));
  }

  /**
   * Names that LOOK like a credential and are not one.
   *
   * The rule below is a shape heuristic on the variable's NAME, which is the
   * right kind of rule -- it catches the mistake before anyone has to reason
   * about a particular value -- and it therefore has false positives. This is
   * the list of them, and it is exact-match on purpose: `VITE_GOOGLE_API_KEY`
   * is exempt and `VITE_GOOGLE_API_KEY_2` is not, so widening it is always a
   * deliberate act with a name attached.
   *
   * VITE_GOOGLE_API_KEY is the Google Picker browser key (ADR-021). It is
   * published by design: `PickerBuilder.setDeveloperKey` runs in the page, so
   * there is no version of this feature where the key is not in the bundle. It
   * is not a bearer credential -- it identifies the project rather than
   * authorising anything, and what stops it being useful to somebody else is
   * the API and HTTP-referrer restrictions set on it in the Cloud console. If
   * that restriction is ever removed, this entry stops being true.
   *
   * Note what is NOT here and must never be: an OAuth CLIENT SECRET. It is
   * also "just" a Google credential and it is the opposite of publishable,
   * which is the reason this list names values one at a time.
   */
  const PUBLISHABLE = new Set(['VITE_GOOGLE_API_KEY']);

  const frontendSrc = path.join(root, 'frontend/src');
  const offenders = [];
  const walkSrc = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walkSrc(p); continue; }
      const t = fs.readFileSync(p, 'utf8');
      // A VITE_ variable is compiled into the bundle. Anything secret-shaped
      // read through one is a leak by construction.
      for (const m of t.matchAll(/import\.meta\.env\??\.(\w+)/g)) {
        if (/DATABASE|SECRET|PASSWORD|TOKEN|KEY|ADMIN/i.test(m[1])
          && !PUBLISHABLE.has(m[1])) {
          offenders.push(`${path.relative(root, p)}: ${m[1]}`);
        }
      }
    }
  };
  walkSrc(frontendSrc);
  check('no secret-shaped VITE_ variable is read by the client',
    offenders.length === 0, offenders.join(', '));
}

// ---------------------------------------------------------------------------
console.log('\n5. credentials are not committed or logged');
{
  const tracked = [];
  const { execSync } = await import('node:child_process');
  const files = execSync('git ls-files', { cwd: root }).toString().split('\n').filter(Boolean);
  for (const f of files) {
    if (/(^|\/)\.env|\.neon$|\.pem$|\.key$/.test(f)) { tracked.push(f); continue; }
    const full = path.join(root, f);
    let t;
    try { t = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (/postgres(ql)?:\/\/[^\s'"]*:[^\s'"@]+@/.test(t)) tracked.push(`${f} (connection string)`);
  }
  check('no credential or dotenv file is tracked by git',
    tracked.length === 0, tracked.join(', '));

  // The NAME may be logged; the VALUE may not.
  const serverFiles = ['backend/src/config.js', 'backend/src/storage/db.js',
    'backend/src/transport/server.js', 'backend/src/transport/api.js'];
  const leaks = [];
  for (const f of serverFiles) {
    const t = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of t.matchAll(/console\.\w+\(([^\n]*)\)/g)) {
      if (/\$\{[^}]*(databaseUrl|connectionString|DATABASE_URL)[^}]*\}/.test(m[1])) {
        leaks.push(`${f}: ${m[1].slice(0, 60)}`);
      }
    }
  }
  check('no log statement prints a connection string', leaks.length === 0, leaks.join('; '));
}

console.log(`\n${pass} passed, ${fail} failed${warn ? `, ${warn} warned` : ''}\n`);
process.exit(fail ? 1 : 0);
