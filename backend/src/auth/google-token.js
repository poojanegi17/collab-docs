/**
 * Verifying a Google ID token.
 *
 * WHAT AN ID TOKEN IS, AND WHAT IT IS NOT. Google Identity Services hands the
 * BROWSER a signed JWT asserting "this person is sub=123, email=x, and I
 * checked". It is an assertion about identity and carries no authority over
 * any Google API -- reading a user's Drive needs a different grant entirely
 * (ADR-020). What it authorises here is one thing: starting a session in this
 * application.
 *
 * WHY THIS IS VERIFIED SERVER-SIDE AND CANNOT BE VERIFIED ANYWHERE ELSE. The
 * token arrives from the client, and anything the client can send, an attacker
 * can send. A JWT is three base64 segments and the middle one is readable with
 * `atob` -- so "decode it and trust the email" is a login form where the
 * password field is the account name. The only thing separating a real token
 * from a forged one is the signature, which is checked here, against keys
 * fetched from Google, before any claim in it is looked at.
 *
 * THE DEPENDENCY QUESTION. `google-auth-library` does this and is the
 * canonical answer. It is not used, for one reason that is about testing
 * rather than about weight: it resolves Google's certificate endpoint
 * internally, so a harness cannot point it at a local issuer, and the
 * assertions that matter here are all NEGATIVE -- a token signed by the wrong
 * key, addressed to the wrong audience, or claiming `alg: none` must be
 * refused. Those cannot be tested against the real Google. Every parameter
 * below is injectable so `tools/google-auth-test.mjs` can stand up an issuer
 * it holds the private key for and assert each refusal individually.
 *
 * The cost of that choice is that the checks are ours to get right, so they
 * are written out one at a time and named, rather than folded into a
 * condition. Each one has a test.
 */
import { createPublicKey, createVerify } from 'node:crypto';

/** Google's JWKS endpoint. Public, unauthenticated, and rotated regularly. */
export const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * Both spellings are legitimate for Google-issued ID tokens and which one you
 * get is not something to depend on, so both are accepted and nothing else is.
 */
export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * The one signature algorithm this accepts.
 *
 * Pinned rather than read from the token, which is the whole of the classic
 * JWT algorithm-confusion attack: a verifier that believes the header will
 * accept `alg: none` and skip the signature, or accept `alg: HS256` and verify
 * an attacker-forged HMAC using the PUBLIC key as the shared secret -- and
 * that key is public by definition. So the header's `alg` is not an
 * instruction. It is a claim, and it is checked against this.
 */
const ALGORITHM = 'RS256';

/** A JWT this long is not one Google issued; refuse before parsing anything. */
const MAX_TOKEN_BYTES = 8192;

/** How long an unknown `kid` may force a refetch. See `keyFor`. */
const MIN_REFETCH_MS = 60_000;

/** Fallback JWKS lifetime when the response carries no usable `cache-control`. */
const DEFAULT_JWKS_TTL_MS = 60 * 60 * 1000;

class TokenError extends Error {}

const fail = (reason) => { throw new TokenError(reason); };

/** One base64url segment -> parsed JSON, or a refusal. */
function decodeSegment(segment, what) {
  let json;
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8');
  } catch {
    return fail(`${what} is not base64url`);
  }
  try {
    const value = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fail(`${what} is not an object`);
    }
    return value;
  } catch {
    return fail(`${what} is not JSON`);
  }
}

/**
 * A verifier bound to one OAuth client id.
 *
 * @param {object} opts
 * @param {string} opts.clientId       the audience every token must name
 * @param {string} [opts.jwksUri]      overridden only by the harness
 * @param {string[]} [opts.issuers]    overridden only by the harness
 * @param {number} [opts.clockSkewMs]  tolerance on `exp` and `iat`
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.now]
 */
export function createGoogleVerifier({
  clientId,
  jwksUri = GOOGLE_JWKS_URI,
  issuers = GOOGLE_ISSUERS,
  // Server clocks drift, and a token that is one second old must not be
  // rejected as issued in the future. A minute is the usual allowance; it is
  // small enough that it does not meaningfully extend an expired token's life.
  clockSkewMs = 60_000,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  if (!clientId) throw new Error('createGoogleVerifier needs a clientId');

  /** @type {{ keys: Map<string, import('node:crypto').KeyObject>, expires: number }} */
  let cache = { keys: new Map(), expires: 0 };
  let lastFetch = 0;
  /** In-flight fetch, so a burst of sign-ins makes one request and not twenty. */
  let inFlight = null;

  async function fetchKeys() {
    const res = await fetchImpl(jwksUri);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const body = await res.json();
    const keys = new Map();
    for (const jwk of body?.keys ?? []) {
      // Only the keys this verifier could ever use. A JWKS may legitimately
      // carry others, and importing a key type we will not accept anyway is
      // a way to fail at boot over something irrelevant.
      if (jwk?.kty !== 'RSA' || (jwk.alg && jwk.alg !== ALGORITHM)) continue;
      if (!jwk.kid) continue;
      try {
        keys.set(String(jwk.kid), createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // A malformed key in an otherwise good set must not take the others
        // down with it.
      }
    }
    if (!keys.size) throw new Error('JWKS contained no usable RSA keys');

    // Google says how long its keys are good for, and honouring that is what
    // keeps this from either hammering the endpoint or holding a rotated key
    // until the process restarts.
    const maxAge = /max-age=(\d+)/.exec(res.headers?.get?.('cache-control') ?? '');
    const ttl = maxAge ? Number(maxAge[1]) * 1000 : DEFAULT_JWKS_TTL_MS;
    cache = { keys, expires: now() + ttl };
    lastFetch = now();
    return keys;
  }

  function refresh() {
    if (!inFlight) {
      inFlight = fetchKeys().finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  /**
   * The key for a `kid`, refetching when the set is stale or the kid is new.
   *
   * The second case is key rotation: Google publishes a new key before it
   * starts signing with it, but a process that has been up for a while will
   * still meet a `kid` it has never seen. Refetching on an unknown kid handles
   * that -- and is rate-limited, because otherwise a token carrying a random
   * kid is a free way to make this server call Google, once per request.
   */
  async function keyFor(kid) {
    if (cache.expires <= now()) await refresh();
    const known = cache.keys.get(kid);
    if (known) return known;
    if (now() - lastFetch < MIN_REFETCH_MS) return null;
    const keys = await refresh();
    return keys.get(kid) ?? null;
  }

  return {
    /**
     * @param {string} idToken
     * @returns {Promise<{sub: string, email: string, name: string, picture: string|null}>}
     * @throws when the token is not a currently-valid token for this client
     */
    async verify(idToken) {
      if (typeof idToken !== 'string' || !idToken) fail('no credential');
      if (Buffer.byteLength(idToken) > MAX_TOKEN_BYTES) fail('credential is too large');

      const parts = idToken.split('.');
      if (parts.length !== 3) fail('credential is not a JWT');
      const [encodedHeader, encodedPayload, encodedSignature] = parts;

      const header = decodeSegment(encodedHeader, 'header');
      // Before anything else, and before the payload is even decoded.
      if (header.alg !== ALGORITHM) fail(`unsupported alg: ${header.alg}`);
      if (typeof header.kid !== 'string' || !header.kid) fail('header has no kid');

      const key = await keyFor(header.kid);
      if (!key) fail('unknown signing key');

      const signature = Buffer.from(encodedSignature, 'base64url');
      const signed = `${encodedHeader}.${encodedPayload}`;
      const verifier = createVerify('RSA-SHA256');
      verifier.update(signed);
      verifier.end();
      // Everything above this line is untrusted input. Everything below it is
      // a statement Google signed.
      if (!verifier.verify(key, signature)) fail('signature does not verify');

      const payload = decodeSegment(encodedPayload, 'payload');

      if (!issuers.includes(payload.iss)) fail(`unexpected issuer: ${payload.iss}`);

      // `aud` is a string for Google ID tokens, but the JWT spec allows an
      // array and a verifier that assumes the string form silently accepts
      // every token in the array form.
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.includes(clientId)) fail('token is for a different client');

      const millis = (claim) => (typeof claim === 'number' ? claim * 1000 : NaN);
      const expires = millis(payload.exp);
      if (!Number.isFinite(expires)) fail('token has no exp');
      if (now() >= expires + clockSkewMs) fail('token has expired');

      const issued = millis(payload.iat);
      if (Number.isFinite(issued) && issued > now() + clockSkewMs) {
        fail('token was issued in the future');
      }
      const notBefore = millis(payload.nbf);
      if (Number.isFinite(notBefore) && now() + clockSkewMs < notBefore) {
        fail('token is not valid yet');
      }

      if (typeof payload.sub !== 'string' || !payload.sub) fail('token has no subject');
      if (typeof payload.email !== 'string' || !payload.email) fail('token has no email');

      // The claim that makes account linking safe. Without it, a token proving
      // control of some Google account could claim any address at all, and
      // linking on address means inheriting whatever that address already owns
      // here -- see `findOrCreateFromGoogle`. Google sends a boolean; the
      // string form appears in older documentation and costs nothing to accept.
      const verified = payload.email_verified;
      if (verified !== true && verified !== 'true') fail('email is not verified');

      return {
        sub: payload.sub,
        email: payload.email,
        name: typeof payload.name === 'string' ? payload.name : '',
        picture: typeof payload.picture === 'string' ? payload.picture : null,
      };
    },
  };
}
