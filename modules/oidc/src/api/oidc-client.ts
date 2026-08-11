import {
  constants,
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

/** Endpoints and signing policy are discovered from the configured issuer. */
export interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint: string;
  readonly jwks_uri: string;
  readonly issuer: string;
  readonly id_token_signing_alg_values_supported: readonly string[];
}

export interface Identity {
  readonly username: string;
  readonly email?: string;
  readonly displayName?: string;
}

export interface OidcPolicy {
  /** Provider-specific assurance values which may satisfy this deployment. */
  readonly requiredAcr?: string;
  /** Force a recent IdP authentication; zero leaves the provider session policy in control. */
  readonly maxAuthAgeSeconds?: number;
}

/** One in-flight authorization, remembered between /start and /callback. */
interface Pending {
  readonly verifier: string;
  readonly nonce: string;
  readonly createdAt: number;
  readonly returnTo: string;
  /** Client address that started the attempt, for the per-address pending cap. */
  readonly address: string;
}

interface IdTokenClaims {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly azp?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly nbf?: unknown;
  readonly nonce?: unknown;
  readonly acr?: unknown;
  readonly auth_time?: unknown;
}

interface IdTokenHeader {
  readonly alg?: unknown;
  readonly kid?: unknown;
  readonly typ?: unknown;
}

const PENDING_TTL_MS = 10 * 60_000;
const CACHE_TTL_MS = 60 * 60_000;
const MAX_PENDING = 1_000;
/** One address exhausts its own budget long before it can touch anyone else's. */
const MAX_PENDING_PER_ADDRESS = 20;
const MAX_METADATA_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CLOCK_SKEW_SECONDS = 60;
const ALGORITHMS = new Set(['RS256', 'ES256']);
const base64url = (b: Buffer): string => b.toString('base64url');

/**
 * Confidential-client Authorization Code flow with PKCE and a signed ID token.
 *
 * The ID token is mandatory and verified against the issuer's rotating JWKS.
 * `state`, PKCE and `nonce` are independent single-use bindings: callback CSRF,
 * intercepted-code redemption and token replay must each fail at their own
 * boundary. Userinfo remains the profile source, but its `sub` must match the
 * cryptographically verified token before any Companion session is minted.
 */
export class OidcClient {
  private discovery: { at: number; value: Discovery } | null = null;
  private jwks: { at: number; uri: string; value: readonly JsonWebKey[] } | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly requiredAcr: readonly string[];
  private readonly maxAuthAgeSeconds: number;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly scopes: string,
    private readonly usernameClaim: string,
    policy: OidcPolicy = {},
  ) {
    this.requiredAcr = (policy.requiredAcr ?? '').split(/\s+/).filter(Boolean);
    const maxAuthAge = policy.maxAuthAgeSeconds ?? 0;
    if (!Number.isFinite(maxAuthAge) || maxAuthAge < 0) {
      throw new Error('maximum authentication age must be a non-negative number');
    }
    this.maxAuthAgeSeconds = Math.floor(maxAuthAge);
  }

  /** Cached for an hour; a `kid` miss below forces an immediate JWKS refresh. */
  private async discover(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.at < CACHE_TTL_MS) return this.discovery.value;
    const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    assertSecureEndpoint(url, 'issuer');
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OIDC discovery failed: ${url} returned ${res.status}`);
    const raw = await boundedJson(res, 'OIDC discovery');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('OIDC discovery is not an object');
    const value = raw as unknown as Discovery;
    for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'jwks_uri', 'issuer'] as const) {
      if (typeof value[key] !== 'string') throw new Error(`OIDC discovery is missing ${key}`);
      if (key !== 'issuer') assertSecureEndpoint(value[key], key);
    }
    if (value.issuer !== this.issuer) {
      const slashOnly = value.issuer.replace(/\/+$/, '') === this.issuer.replace(/\/+$/, '');
      throw new Error(
        slashOnly
          ? 'OIDC discovery issuer differs from the configured issuer only by a trailing slash; adjust the configured issuer to match it exactly'
          : 'OIDC discovery issuer does not exactly match the configured issuer',
      );
    }
    if (
      !Array.isArray(value.id_token_signing_alg_values_supported) ||
      !value.id_token_signing_alg_values_supported.every((alg) => typeof alg === 'string')
    ) {
      throw new Error('OIDC discovery is missing id_token_signing_alg_values_supported');
    }
    if (!value.id_token_signing_alg_values_supported.some((alg) => ALGORITHMS.has(alg))) {
      throw new Error('OIDC provider supports no allowed ID-token signing algorithm (RS256 or ES256)');
    }
    if (this.discovery?.value.jwks_uri !== value.jwks_uri) this.jwks = null;
    this.discovery = { at: Date.now(), value };
    return value;
  }

  /** Where to send the browser, plus the state/nonce the callback must prove. */
  async authorizeUrl(redirectUri: string, returnTo: string, address = 'unknown'): Promise<string> {
    const { authorization_endpoint } = await this.discover();
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(32));
    const nonce = base64url(randomBytes(24));
    this.sweep();
    // /start is unauthenticated, so a spammer must not be able to evict other
    // people's pending states through the global FIFO below. A per-address cap
    // (evicting that address's own oldest attempt) keeps one source contained;
    // the global cap stays as the memory backstop.
    let mine = 0;
    let oldestMine: string | null = null;
    for (const [known, entry] of this.pending) {
      if (entry.address !== address) continue;
      mine += 1;
      oldestMine ??= known;
    }
    if (mine >= MAX_PENDING_PER_ADDRESS && oldestMine !== null) this.pending.delete(oldestMine);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    this.pending.set(state, { verifier, nonce, createdAt: Date.now(), returnTo, address });
    const url = new URL(authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: this.scopes,
      state,
      nonce,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(key, value);
    }
    if (this.requiredAcr.length > 0) url.searchParams.set('acr_values', this.requiredAcr.join(' '));
    if (this.maxAuthAgeSeconds > 0) url.searchParams.set('max_age', String(this.maxAuthAgeSeconds));
    return url.toString();
  }

  /** Redeem one code and return only an identity bound to the signed token. */
  async complete(code: string, state: string, redirectUri: string): Promise<{ identity: Identity; returnTo: string }> {
    const entry = this.take(state);
    if (!entry) throw new Error('unknown or expired sign-in attempt; start again from the login page');

    const discovery = await this.discover();
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Client credentials in the header, never the query string. RFC 6749
        // 2.3.1: both halves are form-encoded before the ':' join, so a secret
        // containing ':' or non-ASCII cannot corrupt the header.
        authorization: `Basic ${Buffer.from(
          `${formEncode(this.clientId)}:${formEncode(this.clientSecret)}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: entry.verifier,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed (${tokenRes.status})`);
    const token = await boundedJson(tokenRes, 'OIDC token response');
    if (!token || typeof token !== 'object' || Array.isArray(token)) throw new Error('token response is not an object');
    const accessToken = Reflect.get(token, 'access_token');
    const idToken = Reflect.get(token, 'id_token');
    const tokenType = Reflect.get(token, 'token_type');
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('token response carried no access_token');
    if (typeof idToken !== 'string' || !idToken) throw new Error('token response carried no id_token');
    if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
      throw new Error('token response carried no supported token_type');
    }
    const verified = await this.verifyIdToken(idToken, discovery, entry);

    const infoRes = await fetch(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!infoRes.ok) throw new Error(`userinfo failed (${infoRes.status})`);
    const info = await boundedJson(infoRes, 'OIDC userinfo');
    if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('userinfo is not an object');
    const claims = info as Record<string, unknown>;
    if (typeof claims.sub !== 'string' || claims.sub !== verified.sub) {
      throw new Error('userinfo subject does not match the verified id_token');
    }

    const raw = claims[this.usernameClaim];
    const username = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!username) throw new Error(`the provider returned no '${this.usernameClaim}' claim to use as a username`);
    // An unverified email is an attacker-choosable identifier at some IdPs.
    // When it IS the account key, require the provider's explicit assertion.
    if (this.usernameClaim === 'email' && claims.email_verified !== true) {
      throw new Error(
        "the provider did not assert email_verified: true, which is required when 'email' is the username claim",
      );
    }
    return {
      identity: {
        username,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        displayName: typeof claims.name === 'string' ? claims.name : undefined,
      },
      returnTo: entry.returnTo,
    };
  }

  private async verifyIdToken(idToken: string, discovery: Discovery, entry: Pending): Promise<{ sub: string }> {
    const parts = idToken.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      throw new Error('malformed id_token');
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
    const header = parseTokenPart<IdTokenHeader>(encodedHeader, 'header');
    const claims = parseTokenPart<IdTokenClaims>(encodedClaims, 'payload');
    if (typeof header.alg !== 'string' || !ALGORITHMS.has(header.alg)) {
      throw new Error('id_token uses a disallowed signing algorithm');
    }
    if (!discovery.id_token_signing_alg_values_supported.includes(header.alg)) {
      throw new Error('id_token algorithm is not advertised by the provider');
    }
    if (typeof header.kid !== 'string' || !header.kid) throw new Error('id_token header is missing kid');
    if (header.typ !== undefined && header.typ !== 'JWT') throw new Error('id_token header has an unexpected typ');

    const signed = Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii');
    const signature = Buffer.from(encodedSignature, 'base64url');
    let key = await this.signingKey(discovery.jwks_uri, header.kid, header.alg, false);
    let valid = verifyTokenSignature(header.alg, key, signed, signature);
    if (!valid) {
      // A provider should rotate to a new kid, but some replace a key in place.
      // Refresh once on a cryptographic miss; never try another advertised key.
      key = await this.signingKey(discovery.jwks_uri, header.kid, header.alg, true);
      valid = verifyTokenSignature(header.alg, key, signed, signature);
    }
    if (!valid) throw new Error('id_token signature is invalid');

    if (claims.iss !== discovery.issuer) throw new Error('id_token was issued by a different provider');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.every((audience) => typeof audience === 'string') || !audiences.includes(this.clientId)) {
      throw new Error('id_token was issued for a different client');
    }
    if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== this.clientId) {
      throw new Error('id_token has an unexpected authorized party');
    }
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token is missing sub');

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number') throw new Error('id_token is missing exp or it is not numeric');
    if (claims.exp <= now - CLOCK_SKEW_SECONDS) throw new Error('id_token has expired');
    if (typeof claims.iat !== 'number') throw new Error('id_token is missing iat or it is not numeric');
    if (claims.iat > now + CLOCK_SKEW_SECONDS) throw new Error('id_token was issued in the future');
    if (claims.iat < Math.floor(entry.createdAt / 1000) - CLOCK_SKEW_SECONDS) {
      throw new Error('id_token predates this sign-in attempt');
    }
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now + CLOCK_SKEW_SECONDS)) {
      throw new Error('id_token is not active yet');
    }
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, entry.nonce)) {
      throw new Error('id_token nonce does not match this sign-in attempt');
    }
    if (this.requiredAcr.length > 0 && (typeof claims.acr !== 'string' || !this.requiredAcr.includes(claims.acr))) {
      throw new Error('id_token does not meet the required authentication assurance');
    }
    if (this.maxAuthAgeSeconds > 0) {
      if (typeof claims.auth_time !== 'number') throw new Error('id_token is missing auth_time');
      if (claims.auth_time > now + CLOCK_SKEW_SECONDS) throw new Error('id_token auth_time is in the future');
      if (claims.auth_time + this.maxAuthAgeSeconds < now - CLOCK_SKEW_SECONDS) {
        throw new Error('identity-provider authentication is too old');
      }
    }
    return { sub: claims.sub };
  }

  private async signingKey(uri: string, kid: string, algorithm: string, force: boolean): Promise<KeyObject> {
    let keys = await this.loadJwks(uri, force);
    let matches = matchingKeys(keys, kid, algorithm);
    if (matches.length === 0 && !force) {
      // Rotation must work before the hourly cache expires. One forced refresh
      // is enough; a second miss is a hard failure, never a fallback key.
      keys = await this.loadJwks(uri, true);
      matches = matchingKeys(keys, kid, algorithm);
    }
    if (matches.length !== 1) throw new Error(`OIDC JWKS has ${matches.length} matching signing keys for kid '${kid}'`);
    try {
      return createPublicKey({ key: matches[0]!, format: 'jwk' });
    } catch {
      throw new Error(`OIDC signing key '${kid}' is malformed`);
    }
  }

  private async loadJwks(uri: string, force: boolean): Promise<readonly JsonWebKey[]> {
    if (!force && this.jwks?.uri === uri && Date.now() - this.jwks.at < CACHE_TTL_MS) return this.jwks.value;
    assertSecureEndpoint(uri, 'jwks_uri');
    const res = await fetch(uri, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OIDC JWKS failed (${res.status})`);
    const raw = await boundedJson(res, 'OIDC JWKS');
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Reflect.get(raw, 'keys') : null;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 100) throw new Error('OIDC JWKS has no bounded key set');
    if (!keys.every((key) => key && typeof key === 'object' && !Array.isArray(key))) {
      throw new Error('OIDC JWKS contains a malformed key');
    }
    const value = keys as JsonWebKey[];
    this.jwks = { at: Date.now(), uri, value };
    return value;
  }

  /** Single use, constant-time: a state is a capability to complete a login. */
  private take(state: string): Pending | null {
    this.sweep();
    for (const [known, entry] of this.pending) {
      if (safeEqual(known, state)) {
        this.pending.delete(known);
        return entry;
      }
    }
    return null;
  }

  /** Abandoned attempts must not accumulate: this map is reachable from the public login page. */
  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of this.pending) if (entry.createdAt < cutoff) this.pending.delete(state);
  }
}

/** application/x-www-form-urlencoded encoding of one credential half. */
function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function verifyTokenSignature(algorithm: string, key: KeyObject, signed: Buffer, signature: Buffer): boolean {
  return algorithm === 'ES256'
    ? verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)
    : verify('sha256', signed, { key, padding: constants.RSA_PKCS1_PADDING }, signature);
}

function matchingKeys(keys: readonly JsonWebKey[], kid: string, algorithm: string): JsonWebKey[] {
  return keys.filter((key) => {
    if (key.kid !== kid || (key.use !== undefined && key.use !== 'sig') || (key.alg !== undefined && key.alg !== algorithm)) {
      return false;
    }
    const operations: unknown = Reflect.get(key, 'key_ops');
    if (operations !== undefined && (!Array.isArray(operations) || !operations.includes('verify'))) return false;
    if (algorithm === 'RS256') return key.kty === 'RSA';
    return key.kty === 'EC' && key.crv === 'P-256';
  });
}

function parseTokenPart<T extends object>(encoded: string, label: string): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as T;
  } catch {
    throw new Error(`malformed id_token ${label}`);
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertSecureEndpoint(raw: string, label: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`OIDC ${label} is not a URL`);
  }
  const loopbackHttp = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (url.protocol !== 'https:' && !loopbackHttp) throw new Error(`OIDC ${label} must use HTTPS`);
  if (url.username || url.password) throw new Error(`OIDC ${label} must not contain credentials`);
}

async function boundedJson(response: Response, label: string): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_METADATA_BYTES) {
      throw new Error(`${label} is too large`);
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_METADATA_BYTES) {
          await reader.cancel();
          throw new Error(`${label} is too large`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const text = Buffer.concat(chunks, total).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}
