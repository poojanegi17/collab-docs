/**
 * Google sign-in: the token verifier, and the route that trusts it.
 *
 *   node tools/google-auth-test.mjs
 *
 * WHY THERE IS A FAKE GOOGLE IN HERE. Every assertion worth making about a
 * token verifier is a REFUSAL -- a token signed by the wrong key, addressed to
 * another client, expired, tampered with after signing, or claiming `alg:
 * none`. None of those can be obtained from the real Google, which only ever
 * issues valid tokens to the client that asked. So this stands up an issuer it
 * holds the private key for: an HTTP server publishing a JWKS, and a signer
 * that will produce whatever malformed token an assertion needs.
 *
 * That is also why `backend/src/auth/google-token.js` takes its JWKS URI and
 * issuer list as parameters. The alternative -- a verifier with a test mode --
 * would mean the checks that run in production are not the checks under test,
 * which for this particular file would defeat the point of having tests.
 *
 * The positive case is one assertion. The other twenty are the negatives.
 *
 * Owns its own port for the issuer and its own port for the server.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ISSUER_PORT = 8108;
const PORT = 8109;
const B = `http://localhost:${PORT}`;
const JWKS_URI = `http://localhost:${ISSUER_PORT}/certs`;
const ISSUER = 'https://accounts.example.test';
const CLIENT_ID = '1234567890-abcdefg.apps.googleusercontent.com';

const { createGoogleVerifier } = await import('../backend/src/auth/google-token.js');
const { scratchSchemas, scratchEnv, resetSchemas } = await import('./test-schema.mjs');
const { schema, accountsSchema } = scratchSchemas('googleauth');

let pass = 0, fail = 0;
/** Every server spawned, so a failure part-way through still cleans up. */
const children = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

/** Assert that `fn` refuses, and say what it refused with when it does not. */
const refuses = async (name, fn) => {
  try {
    await fn();
    check(name, false, 'it was ACCEPTED');
  } catch (err) {
    check(name, true, err.message);
  }
};

// ---- a Google that this test controls --------------------------------------

const b64 = (value) => Buffer.from(
  typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const signing = makeKey('key-1');
const rotated = makeKey('key-2');
// Never published. A token signed with this is a forgery by definition.
const attacker = makeKey('key-1');

/** Which keys the JWKS currently publishes, and how often it has been asked. */
let published = [signing];
let jwksRequests = 0;

const issuer = http.createServer((req, res) => {
  jwksRequests++;
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
  res.end(JSON.stringify({ keys: published.map((k) => k.jwk) }));
});
await new Promise((r) => issuer.listen(ISSUER_PORT, r));

const SECOND = 1000;
const now = () => Date.now();

/**
 * Build a token. Every part is overridable, because the tests are about what
 * happens when one of them is wrong.
 */
function token({
  key = signing,
  // `null` means "omit the kid entirely". It cannot be `undefined`, which is
  // indistinguishable from not passing the option at all and would silently
  // take the default below -- a test for a missing kid that quietly supplies
  // one passes without testing anything.
  kid = key.kid,
  alg = 'RS256',
  signature,             // supplied to forge one, omitted to sign properly
  ...claims
} = {}) {
  const header = b64({ alg, ...(kid === null ? {} : { kid }), typ: 'JWT' });
  const payload = b64({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: '110000000000000000001',
    email: 'person@example.com',
    email_verified: true,
    name: 'A Person',
    iat: Math.floor(now() / 1000) - 10,
    exp: Math.floor(now() / 1000) + 3600,
    ...claims,
  });
  if (signature !== undefined) return `${header}.${payload}.${signature}`;
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(key.privateKey).toString('base64url')}`;
}

const verifier = createGoogleVerifier({
  clientId: CLIENT_ID, jwksUri: JWKS_URI, issuers: [ISSUER],
});

console.log('\nGoogle sign-in\n');
console.log('  the verifier\n');

// ---- the one positive ------------------------------------------------------
const claims = await verifier.verify(token());
check('a well-formed token verifies and yields its claims',
  claims.sub === '110000000000000000001' && claims.email === 'person@example.com'
  && claims.name === 'A Person');

// ---- signature -------------------------------------------------------------
await refuses('a token signed by an unpublished key is refused, even with a known kid',
  () => verifier.verify(token({ key: attacker })));

await refuses('a payload edited after signing is refused', () => {
  const [header, , signature] = token().split('.');
  // The classic: take a real token and change who it says you are.
  const forged = b64({
    iss: ISSUER, aud: CLIENT_ID, sub: '1', email: 'victim@example.com',
    email_verified: true, exp: Math.floor(now() / 1000) + 3600,
  });
  return verifier.verify(`${header}.${forged}.${signature}`);
});

// The two algorithm-confusion attacks. `none` asks the verifier to skip the
// signature; `HS256` asks it to verify an HMAC keyed with the PUBLIC key,
// which an attacker also has because it is published.
await refuses('alg: none is refused',
  () => verifier.verify(token({ alg: 'none', signature: '' })));
await refuses('alg: HS256 is refused',
  () => verifier.verify(token({ alg: 'HS256' })));

await refuses('an unknown kid is refused',
  () => verifier.verify(token({ kid: 'no-such-key' })));
await refuses('a token with no kid is refused',
  () => verifier.verify(token({ kid: null })));

// ---- claims ----------------------------------------------------------------
await refuses('a token for a different client is refused',
  () => verifier.verify(token({ aud: 'someone-elses-client.apps.googleusercontent.com' })));
await refuses('an aud ARRAY not containing this client is refused',
  () => verifier.verify(token({ aud: ['a', 'b'] })));
check('an aud array containing this client is accepted',
  !!await verifier.verify(token({ aud: [CLIENT_ID, 'other'] })).catch(() => null));

await refuses('a token from another issuer is refused',
  () => verifier.verify(token({ iss: 'https://accounts.evil.test' })));

await refuses('an expired token is refused',
  () => verifier.verify(token({ exp: Math.floor((now() - 3600 * SECOND) / 1000) })));
await refuses('a token with no exp is refused',
  () => verifier.verify(token({ exp: undefined })));
await refuses('a token issued in the future is refused',
  () => verifier.verify(token({ iat: Math.floor((now() + 3600 * SECOND) / 1000) })));
await refuses('a token that is not valid yet is refused',
  () => verifier.verify(token({ nbf: Math.floor((now() + 3600 * SECOND) / 1000) })));

// This is what makes linking a Google sign-in to an existing account safe --
// without it a token could assert an address its holder does not own, and
// linking on address means inheriting whatever that address already owns.
await refuses('an unverified email is refused',
  () => verifier.verify(token({ email_verified: false })));
await refuses('a missing email is refused',
  () => verifier.verify(token({ email: undefined })));
await refuses('a missing subject is refused',
  () => verifier.verify(token({ sub: undefined })));

// ---- shape -----------------------------------------------------------------
await refuses('a non-JWT is refused', () => verifier.verify('not.a.jwt'));
await refuses('an empty credential is refused', () => verifier.verify(''));
await refuses('a missing credential is refused', () => verifier.verify(undefined));
await refuses('a two-segment token is refused', () => verifier.verify('a.b'));
await refuses('an oversized credential is refused',
  () => verifier.verify(`${'x'.repeat(9000)}.y.z`));

// ---- key handling ----------------------------------------------------------
const before = jwksRequests;
await verifier.verify(token());
await verifier.verify(token());
check('the key set is cached rather than refetched per sign-in',
  jwksRequests === before, `${jwksRequests - before} extra fetches`);

/**
 * Key rotation, on a clock this test controls.
 *
 * Google publishes a new key before it starts signing with it, so a
 * long-running process will eventually meet a `kid` it has never seen and has
 * to refetch, or every sign-in fails until the process restarts. But refetching
 * on ANY unknown kid makes a token carrying a random one a free way to make
 * this server call Google, once per request -- so the refetch is rate limited,
 * and both halves of that are asserted here.
 *
 * The clock is injected rather than waited out: the alternative is a test that
 * sleeps for a minute.
 */
let clock = now();
const rotating = createGoogleVerifier({
  clientId: CLIENT_ID, jwksUri: JWKS_URI, issuers: [ISSUER], now: () => clock,
});
await rotating.verify(token());          // populates the key cache

published = [signing, rotated];
const tooSoon = await rotating.verify(token({ key: rotated })).catch((e) => e);
check('an unknown kid does not refetch immediately, so it cannot be used to call Google',
  tooSoon instanceof Error, tooSoon instanceof Error ? tooSoon.message : 'it was ACCEPTED');

clock += 61 * SECOND;
const rotatedClaims = await rotating.verify(token({ key: rotated })).catch((e) => e);
check('and once the refetch window passes, the rotated-in key is picked up',
  rotatedClaims?.sub === '110000000000000000001',
  rotatedClaims instanceof Error ? rotatedClaims.message : '');

// ---- the route -------------------------------------------------------------

console.log('\n  the route\n');
try {
await resetSchemas(schema, accountsSchema);

const api = async (p, { method = 'GET', body, token: bearer } = {}) => {
  const res = await fetch(B + p, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/**
 * Spawn a server and wait for it to say it is listening.
 *
 * The `exit` rejection is not defensive padding. Waiting only for the word
 * "listening" means a server that dies during boot -- a bad migration, a
 * syntax error, a refused connection -- is a harness that hangs forever with
 * no output, holding its ports, which is exactly what a stray backtick in the
 * DDL did while this file was being written. Failing here instead reports the
 * exit code next to the child's stderr, which is already on this terminal.
 */
const start = (env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'backend/src/index.js')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  child.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(child); });
  child.once('exit', (code) => reject(new Error(`server exited with code ${code} before listening`)));
});

const server = await start({
  ...scratchEnv({ schema, accountsSchema, port: PORT }),
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_JWKS_URI: JWKS_URI,
  GOOGLE_ISSUERS: ISSUER,
});

const googleUser = (claims) => api('/api/auth/google', {
  method: 'POST', body: { credential: token(claims) },
});

// A first sign-in creates the account.
const first = await googleUser({ sub: 'sub-alice', email: 'alice@example.com', name: 'Alice' });
check('a first Google sign-in creates a user and returns a session',
  first.status === 200 && !!first.body.token && first.body.user.email === 'alice@example.com',
  JSON.stringify(first.body).slice(0, 120));

check('the password hash never leaves the server',
  !JSON.stringify(first.body).includes('password'));

// The session is an ordinary session. Nothing downstream knows it came from
// Google, which is the property that kept this feature small.
const me = await api('/api/me', { token: first.body.token });
check('the returned token is an ordinary session token',
  me.status === 200 && me.body.user.id === first.body.user.id);

// The `sub` is the key, not the email -- so a rename in Google still finds the
// same account here.
const again = await googleUser({ sub: 'sub-alice', email: 'alice@example.com', name: 'Alice B' });
check('signing in again returns the SAME user, not a second one',
  again.body.user?.id === first.body.user.id);

// A Google account whose address already has a password account here: linked,
// not duplicated, and not refused.
const bob = await api('/api/auth/signup', {
  method: 'POST', body: { email: 'bob@example.com', name: 'Bob', password: 'hunter2hunter2' },
});
const bobGoogle = await googleUser({ sub: 'sub-bob', email: 'bob@example.com', name: 'Bob' });
check('a Google sign-in links to an existing password account for the same address',
  bobGoogle.status === 200 && bobGoogle.body.user?.id === bob.body.user.id);

check('and that account can still sign in with its password', (await api('/api/auth/login', {
  method: 'POST', body: { email: 'bob@example.com', password: 'hunter2hunter2' },
})).status === 200);

// A Google-only user has no password. The refusal must be indistinguishable
// from an unknown address, or it is a free way to discover which addresses
// have accounts and how they sign in.
const noPassword = await api('/api/auth/login', {
  method: 'POST', body: { email: 'alice@example.com', password: 'hunter2hunter2' },
});
const unknown = await api('/api/auth/login', {
  method: 'POST', body: { email: 'nobody@example.com', password: 'hunter2hunter2' },
});
check('password login for a Google-only account is refused',
  noPassword.status === 401);
check('and is refused identically to an unknown address',
  noPassword.status === unknown.status && noPassword.body.error === unknown.body.error,
  `${noPassword.body.error} / ${unknown.body.error}`);

// The route must not become an oracle: every refusal reads the same, whatever
// was actually wrong with the token.
const forged = await api('/api/auth/google', {
  method: 'POST', body: { credential: token({ key: attacker }) },
});
const wrongAudience = await api('/api/auth/google', {
  method: 'POST', body: { credential: token({ aud: 'other' }) },
});
check('a forged token is refused by the route', forged.status === 401);
check('and every refusal reads the same, whatever was wrong',
  forged.body.error === wrongAudience.body.error && !/aud|signature|client/i.test(forged.body.error),
  forged.body.error);

check('a missing credential is refused rather than crashing',
  (await api('/api/auth/google', { method: 'POST', body: {} })).status === 401);

server.kill();

// A checkout with no Google project behind it must still boot and still serve
// every other route -- the feature is off, not broken.
//
// GOOGLE_CLIENT_ID is cleared EXPLICITLY rather than merely left unset. The
// child inherits this process's environment, and this process has been through
// config.js, which reads `.env.local` -- so on any machine where somebody has
// actually configured Google sign-in, "unset" is not what the child sees, and
// this assertion silently tests a configured server instead. It failed exactly
// that way the day the real client id was added.
const plain = await start({
  ...scratchEnv({ schema, accountsSchema, port: PORT + 1 }),
  GOOGLE_CLIENT_ID: '',
});
const offline = await fetch(`http://localhost:${PORT + 1}/api/auth/google`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ credential: token() }),
});
check('an unconfigured server reports the feature is off rather than failing',
  offline.status === 501);
plain.kill();
} catch (err) {
  check('the route suite ran to completion', false, err.message);
} finally {
  for (const child of children) child.kill();
  issuer.close();
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
