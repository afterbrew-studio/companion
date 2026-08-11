import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { OidcClient } from '../dist/api/oidc-client.js';
import { safeReturnTo } from '../dist/api/routes.js';

const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherSigning = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ecSigning = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const publicJwk = {
  ...signing.publicKey.export({ format: 'jwk' }),
  kid: 'key-1',
  use: 'sig',
  alg: 'RS256',
  key_ops: ['verify'],
};
const rotatedPublicJwk = {
  ...otherSigning.publicKey.export({ format: 'jwk' }),
  kid: 'key-1',
  use: 'sig',
  alg: 'RS256',
  key_ops: ['verify'],
};
const ecPublicJwk = {
  ...ecSigning.publicKey.export({ format: 'jwk' }),
  kid: 'ec-key-1',
  use: 'sig',
  alg: 'ES256',
  key_ops: ['verify'],
};

/**
 * A provider that enforces PKCE and signs every ID token. The client has to
 * prove the complete flow: a claims-only decoder would now accept the forged
 * key and nonce cases below and fail the suite.
 */
async function idp(overrides = {}) {
  const codes = new Map();
  let rotated = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url, base);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      if (overrides.oversizedDiscovery) {
        res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
        res.write('{"padding":"');
        res.write('x'.repeat(1_000_001));
        return res.end('"}');
      }
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        jwks_uri: `${base}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
        ...overrides.discovery,
      });
    }
    if (url.pathname === '/jwks') {
      return json(200, overrides.jwks ?? { keys: [rotated ? rotatedPublicJwk : publicJwk] });
    }
    if (url.pathname === '/authorize') {
      const code = `code-${codes.size}`;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge'),
        method: url.searchParams.get('code_challenge_method'),
        nonce: url.searchParams.get('nonce'),
      });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      return req.on('end', () => {
        const auth = req.headers.authorization ?? '';
        // RFC 6749 2.3.1 / RFC 7617: split on the first ':', then form-decode
        // each half. A client that skips the encoding fails here, as it would
        // against a compliant provider.
        const decoded = Buffer.from(auth.slice(6), 'base64').toString();
        const sep = decoded.indexOf(':');
        let id = '';
        let secret = '';
        try {
          const formDecode = (part) => decodeURIComponent(part.replace(/\+/g, '%20'));
          id = formDecode(sep < 0 ? decoded : decoded.slice(0, sep));
          secret = formDecode(sep < 0 ? '' : decoded.slice(sep + 1));
        } catch {
          // malformed escapes: fall through to the mismatch below
        }
        if (id !== 'client-1' || secret !== (overrides.secret ?? 'shh')) return json(401, { error: 'invalid_client' });
        const form = new URLSearchParams(body);
        const code = form.get('code');
        const entry = codes.get(code);
        if (!entry) return json(400, { error: 'invalid_grant' });
        codes.delete(code);
        const verifier = form.get('code_verifier') ?? '';
        const derived = createHash('sha256').update(verifier).digest('base64url');
        if (entry.method !== 'S256' || derived !== entry.challenge) return json(400, { error: 'invalid_grant' });
        const response = { access_token: 'at-1', token_type: overrides.tokenType ?? 'Bearer' };
        if (!overrides.omitIdToken) {
          response.id_token = idToken(
            base,
            entry.nonce,
            overrides.claims,
            overrides.header,
            overrides.signingKey ?? (rotated ? otherSigning.privateKey : signing.privateKey),
          );
        }
        json(200, response);
      });
    }
    if (url.pathname === '/userinfo') {
      if (req.headers.authorization !== 'Bearer at-1') return json(401, { error: 'invalid_token' });
      return json(200, {
        sub: 'u-1',
        preferred_username: 'Alice.SSO',
        email: 'alice@corp.test',
        name: 'Alice SSO',
        ...overrides.userinfo,
      });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    rotateSigningKey: () => {
      rotated = true;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

function idToken(issuer, nonce, claims = {}, header = {}, signingKey = signing.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const completeHeader = { alg: 'RS256', kid: 'key-1', typ: 'JWT', ...header };
  const protectedHeader = encode(completeHeader);
  const payload = encode({
    iss: issuer,
    sub: 'u-1',
    aud: 'client-1',
    exp: now + 600,
    iat: now,
    nonce,
    ...claims,
  });
  const key = completeHeader.alg === 'ES256'
    ? { key: signingKey, dsaEncoding: 'ieee-p1363' }
    : signingKey;
  const signature = sign('sha256', Buffer.from(`${protectedHeader}.${payload}`), key).toString('base64url');
  return `${protectedHeader}.${payload}.${signature}`;
}

const clientFor = (base, claim = 'preferred_username', policy) =>
  new OidcClient(base, 'client-1', 'shh', 'openid profile email', claim, policy);

test('an invalid maximum authentication age fails closed', () => {
  assert.throws(
    () => clientFor('https://identity.example', 'preferred_username', { maxAuthAgeSeconds: Number.NaN }),
    /non-negative number/,
  );
});

/** Drive the redirect chain the browser would, and hand back what the callback sees. */
async function handshake(client, base) {
  const authorization = new URL(await client.authorizeUrl(`${base}/back`, '/board'));
  const res = await fetch(authorization, { redirect: 'manual' });
  const back = new URL(res.headers.get('location'));
  return {
    authorization,
    code: back.searchParams.get('code'),
    state: back.searchParams.get('state'),
  };
}

test('a signed PKCE handshake yields the userinfo identity bound by sub', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = clientFor(provider.base);
  const { code, state } = await handshake(client, provider.base);

  const { identity, returnTo } = await client.complete(code, state, `${provider.base}/back`);
  assert.equal(identity.username, 'alice.sso', 'usernames are normalised, so casing cannot fork an account');
  assert.equal(identity.email, 'alice@corp.test');
  assert.equal(identity.displayName, 'Alice SSO');
  assert.equal(returnTo, '/board');
});

test('an ES256 ID token verifies against a P-256 provider key', async (t) => {
  const provider = await idp({
    discovery: { id_token_signing_alg_values_supported: ['ES256'] },
    jwks: { keys: [ecPublicJwk] },
    header: { alg: 'ES256', kid: 'ec-key-1' },
    signingKey: ecSigning.privateKey,
  });
  t.after(provider.close);
  const client = clientFor(provider.base);
  const { code, state } = await handshake(client, provider.base);
  const { identity } = await client.complete(code, state, `${provider.base}/back`);
  assert.equal(identity.username, 'alice.sso');
});

test('the authorize URL carries S256 PKCE, state and nonce', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const url = new URL(await clientFor(provider.base).authorizeUrl(`${provider.base}/back`, '/'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), `${provider.base}/back`);
  assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 43);
  assert.ok((url.searchParams.get('state') ?? '').length >= 32);
  assert.ok((url.searchParams.get('nonce') ?? '').length >= 32);
});

test('a state is single-use, so a replayed callback cannot mint a second session', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = clientFor(provider.base);
  const { code, state } = await handshake(client, provider.base);
  await client.complete(code, state, `${provider.base}/back`);

  await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), /unknown or expired/);
});

test('a state the client never issued is refused', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = clientFor(provider.base);
  const { code } = await handshake(client, provider.base);
  await assert.rejects(() => client.complete(code, 'forged-state', `${provider.base}/back`), /unknown or expired/);
});

test('a client secret with a colon and non-ASCII survives the Basic header form-encoded', async (t) => {
  const secret = 'p@ss:wörd +/%';
  const provider = await idp({ secret });
  t.after(provider.close);
  const client = new OidcClient(provider.base, 'client-1', secret, 'openid profile email', 'preferred_username');
  const { code, state } = await handshake(client, provider.base);
  const { identity } = await client.complete(code, state, `${provider.base}/back`);
  assert.equal(identity.username, 'alice.sso');
});

test('a code issued to one client cannot be redeemed with another client secret', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const good = clientFor(provider.base);
  const { code, state } = await handshake(good, provider.base);

  const bad = new OidcClient(provider.base, 'client-1', 'wrong', 'openid', 'sub');
  const own = await handshake(bad, provider.base);
  await assert.rejects(() => bad.complete(own.code, own.state, `${provider.base}/back`), /token exchange failed \(401\)/);
  await good.complete(code, state, `${provider.base}/back`);
});

for (const [name, claims, message] of [
  ['a different issuer', { iss: 'https://evil.test' }, /different provider/],
  ['a different audience', { aud: 'other-client' }, /different client/],
  ['a wrong authorized party', { aud: ['client-1', 'api'], azp: 'other-client' }, /authorized party/],
  ['an expired token', { exp: 1_000 }, /expired/],
  ['no expiry', { exp: undefined }, /missing exp/],
  ['no issued-at time', { iat: undefined }, /missing iat/],
  ['a wrong nonce', { nonce: 'not-the-request-nonce' }, /nonce does not match/],
]) {
  test(`an id_token from ${name} is refused`, async (t) => {
    const provider = await idp({ claims });
    t.after(provider.close);
    const client = clientFor(provider.base);
    const { code, state } = await handshake(client, provider.base);
    await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), message);
  });
}

test('an unsigned algorithm and a signature from an unknown private key are refused', async (t) => {
  const unsigned = await idp({ header: { alg: 'none' } });
  t.after(unsigned.close);
  const unsignedClient = clientFor(unsigned.base);
  const first = await handshake(unsignedClient, unsigned.base);
  await assert.rejects(
    () => unsignedClient.complete(first.code, first.state, `${unsigned.base}/back`),
    /disallowed signing algorithm/,
  );

  const forged = await idp({ signingKey: otherSigning.privateKey });
  t.after(forged.close);
  const forgedClient = clientFor(forged.base);
  const second = await handshake(forgedClient, forged.base);
  await assert.rejects(
    () => forgedClient.complete(second.code, second.state, `${forged.base}/back`),
    /signature is invalid/,
  );
});

test('a same-kid signing-key rotation refreshes JWKS once and stays bound to that key', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = clientFor(provider.base);
  const first = await handshake(client, provider.base);
  await client.complete(first.code, first.state, `${provider.base}/back`);

  provider.rotateSigningKey();
  const second = await handshake(client, provider.base);
  const result = await client.complete(second.code, second.state, `${provider.base}/back`);
  assert.equal(result.identity.username, 'alice.sso');
});

test('userinfo cannot switch the subject after the ID token was verified', async (t) => {
  const provider = await idp({ userinfo: { sub: 'someone-else' } });
  t.after(provider.close);
  const client = clientFor(provider.base);
  const { code, state } = await handshake(client, provider.base);
  await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), /subject does not match/);
});

test('OIDC can require the provider-specific MFA assurance and a recent login', async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const provider = await idp({ claims: { acr: 'urn:corp:mfa', auth_time: now } });
  t.after(provider.close);
  const client = clientFor(provider.base, 'preferred_username', {
    requiredAcr: 'urn:corp:mfa',
    maxAuthAgeSeconds: 300,
  });
  const { authorization, code, state } = await handshake(client, provider.base);
  assert.equal(authorization.searchParams.get('acr_values'), 'urn:corp:mfa');
  assert.equal(authorization.searchParams.get('max_age'), '300');
  await client.complete(code, state, `${provider.base}/back`);
});

test('missing required assurance fails closed', async (t) => {
  const provider = await idp({ claims: { acr: 'urn:corp:password' } });
  t.after(provider.close);
  const client = clientFor(provider.base, 'preferred_username', { requiredAcr: 'urn:corp:mfa' });
  const { code, state } = await handshake(client, provider.base);
  await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), /required authentication assurance/);
});

test('a missing ID token fails closed even when userinfo is available', async (t) => {
  const provider = await idp({ omitIdToken: true });
  t.after(provider.close);
  const client = clientFor(provider.base);
  const { code, state } = await handshake(client, provider.base);
  await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), /no id_token/);
});

test('a non-Bearer access token is refused before userinfo', async (t) => {
  const provider = await idp({ tokenType: 'MAC' });
  t.after(provider.close);
  const client = clientFor(provider.base);
  const { code, state } = await handshake(client, provider.base);
  await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), /no supported token_type/);
});

test('chunked OIDC metadata is rejected while it crosses the response-size limit', async (t) => {
  const provider = await idp({ oversizedDiscovery: true });
  t.after(provider.close);
  await assert.rejects(
    () => clientFor(provider.base).authorizeUrl(`${provider.base}/back`, '/'),
    /OIDC discovery is too large/,
  );
});

test("usernameClaim 'email' fails closed when the provider does not assert email_verified", async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = clientFor(provider.base, 'email');
  const { code, state } = await handshake(client, provider.base);
  await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), /email_verified/);
});

test("usernameClaim 'email' signs in when the provider asserts email_verified: true", async (t) => {
  const provider = await idp({ userinfo: { email_verified: true } });
  t.after(provider.close);
  const client = clientFor(provider.base, 'email');
  const { code, state } = await handshake(client, provider.base);
  const { identity } = await client.complete(code, state, `${provider.base}/back`);
  assert.equal(identity.username, 'alice@corp.test');
});

test('spam from one address cannot evict another address pending sign-in', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = clientFor(provider.base);
  // The legitimate attempt (default address) starts first.
  const { code, state } = await handshake(client, provider.base);
  // More /start hits than the global cap, all from one spamming address: with
  // pure FIFO eviction these would push the legitimate state out.
  for (let i = 0; i < 1_005; i++) {
    await client.authorizeUrl(`${provider.base}/back`, '/', '203.0.113.9');
  }
  const { identity } = await client.complete(code, state, `${provider.base}/back`);
  assert.equal(identity.username, 'alice.sso');
});

test('an issuer mismatch that is only a trailing slash says so', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = new OidcClient(`${provider.base}/`, 'client-1', 'shh', 'openid', 'preferred_username');
  await assert.rejects(() => client.authorizeUrl(`${provider.base}/back`, '/'), /only by a trailing slash/);
});

test('a missing username claim fails the sign-in rather than inventing one', async (t) => {
  const provider = await idp();
  t.after(provider.close);
  const client = clientFor(provider.base, 'upn');
  const { code, state } = await handshake(client, provider.base);
  await assert.rejects(() => client.complete(code, state, `${provider.base}/back`), /no 'upn' claim/);
});

for (const [name, discovery, message] of [
  ['token endpoint', { token_endpoint: undefined }, /missing token_endpoint/],
  ['JWKS endpoint', { jwks_uri: undefined }, /missing jwks_uri/],
  ['signing algorithms', { id_token_signing_alg_values_supported: undefined }, /missing id_token_signing/],
  ['exact issuer', { issuer: 'https://different.example' }, /does not exactly match/],
  ['secure endpoint', { jwks_uri: 'http://identity.example/jwks' }, /must use HTTPS/],
]) {
  test(`discovery with an invalid ${name} is a hard failure`, async (t) => {
    const provider = await idp({ discovery });
    t.after(provider.close);
    await assert.rejects(() => clientFor(provider.base).authorizeUrl(`${provider.base}/back`, '/'), message);
  });
}

test('OIDC return targets stay on the Companion origin', () => {
  assert.equal(safeReturnTo('/#/board?task=1'), '/#/board?task=1');
  assert.equal(safeReturnTo('//evil.example/path'), '/');
  assert.equal(safeReturnTo('/\\evil.example/path'), '/');
  assert.equal(safeReturnTo('/safe\n//evil.example'), '/');
  assert.equal(safeReturnTo('https://evil.example/path'), '/');
});
