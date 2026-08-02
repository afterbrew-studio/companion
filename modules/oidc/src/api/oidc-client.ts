import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** The two endpoints the handshake needs, plus userinfo. Discovered, never guessed. */
export interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint: string;
  readonly issuer: string;
}

export interface Identity {
  readonly username: string;
  readonly email?: string;
  readonly displayName?: string;
}

/** One in-flight authorization, remembered between /start and /callback. */
interface Pending {
  readonly verifier: string;
  readonly createdAt: number;
  readonly returnTo: string;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const base64url = (b: Buffer): string => b.toString('base64url');

/**
 * Authorization Code flow with PKCE, using **userinfo** rather than verifying
 * the ID token's signature.
 *
 * That is a deliberate choice, and it is spec-legal: OIDC Core 3.1.3.7 allows a
 * client to skip ID token signature validation when the token came directly
 * from the token endpoint over TLS, which is exactly this path (a confidential
 * client, server to server). Doing it the other way would mean fetching JWKS,
 * matching `kid`, and implementing RS256/ES256 verification with key rotation:
 * a dependency and a meaningful attack surface, to re-derive a fact TLS already
 * established. The claims that must still be checked (`iss`, `aud`, `exp`) are
 * checked below.
 *
 * PKCE and `state` are NOT optional here: `state` is the CSRF defence on the
 * callback, and PKCE stops an intercepted code from being redeemed by anyone
 * else. Both are single-use.
 */
export class OidcClient {
  private discovery: { at: number; value: Discovery } | null = null;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly scopes: string,
    private readonly usernameClaim: string,
  ) {}

  /** Cached for an hour: providers rotate endpoints rarely and a per-login fetch is a needless dependency on their uptime. */
  private async discover(): Promise<Discovery> {
    if (this.discovery && Date.now() - this.discovery.at < 3_600_000) return this.discovery.value;
    const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OIDC discovery failed: ${url} returned ${res.status}`);
    const value = (await res.json()) as Discovery;
    for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'issuer'] as const) {
      if (typeof value[key] !== 'string') throw new Error(`OIDC discovery is missing ${key}`);
    }
    this.discovery = { at: Date.now(), value };
    return value;
  }

  /** Where to send the browser, plus the `state` the callback must echo back. */
  async authorizeUrl(redirectUri: string, returnTo: string): Promise<string> {
    const { authorization_endpoint } = await this.discover();
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(32));
    this.sweep();
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    this.pending.set(state, { verifier, createdAt: Date.now(), returnTo });
    const url = new URL(authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: this.scopes,
      state,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  /**
   * Redeem the code and return the identity. Throws on anything unexpected;
   * the caller turns that into a failed sign-in, never a partial one.
   */
  async complete(code: string, state: string, redirectUri: string): Promise<{ identity: Identity; returnTo: string }> {
    const entry = this.take(state);
    if (!entry) throw new Error('unknown or expired sign-in attempt; start again from the login page');

    const { token_endpoint, userinfo_endpoint, issuer } = await this.discover();
    const tokenRes = await fetch(token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Client credentials in the header, never the query string.
        authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
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
    const token = (await tokenRes.json()) as { access_token?: string; id_token?: string };
    if (!token.access_token) throw new Error('token response carried no access_token');

    if (token.id_token) this.assertIdTokenClaims(token.id_token, issuer);

    const infoRes = await fetch(userinfo_endpoint, {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!infoRes.ok) throw new Error(`userinfo failed (${infoRes.status})`);
    const claims = (await infoRes.json()) as Record<string, unknown>;

    const raw = claims[this.usernameClaim];
    const username = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!username) throw new Error(`the provider returned no '${this.usernameClaim}' claim to use as a username`);
    return {
      identity: {
        username,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        displayName: typeof claims.name === 'string' ? claims.name : undefined,
      },
      returnTo: entry.returnTo,
    };
  }

  /**
   * Signature aside (see the class comment), these three claims still have to
   * hold: a token minted by another issuer, or for another client, or already
   * expired, is not a sign-in.
   */
  private assertIdTokenClaims(idToken: string, issuer: string): void {
    const part = idToken.split('.')[1];
    if (!part) throw new Error('malformed id_token');
    let claims: { iss?: unknown; aud?: unknown; exp?: unknown };
    try {
      claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as typeof claims;
    } catch {
      throw new Error('malformed id_token payload');
    }
    if (claims.iss !== issuer) throw new Error('id_token was issued by a different provider');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) throw new Error('id_token was issued for a different client');
    if (typeof claims.exp !== 'number') throw new Error('id_token is missing exp or it is not numeric');
    if (claims.exp * 1000 <= Date.now()) throw new Error('id_token has expired');
  }

  /** Single use, constant-time: a `state` is a capability to complete a login. */
  private take(state: string): Pending | null {
    this.sweep();
    for (const [known, entry] of this.pending) {
      const a = Buffer.from(known);
      const b = Buffer.from(state);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        this.pending.delete(known);
        return entry;
      }
    }
    return null;
  }

  /** Abandoned attempts must not accumulate: this map is reachable by anyone who can load the login page. */
  private sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [state, entry] of this.pending) if (entry.createdAt < cutoff) this.pending.delete(state);
  }
}
