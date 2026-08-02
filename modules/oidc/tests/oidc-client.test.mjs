import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { OidcClient } from '../dist/api/oidc-client.js';
import { safeReturnTo } from '../dist/api/routes.js';

/**
 * A provider that actually enforces the protocol, so a client that skipped PKCE
 * or reused a code would fail here rather than quietly pass. `state` is never
 * echoed by this stub: it is the client's own memory, which is the point.
 */
async function idp(overrides = {}) {
  const codes = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, base);
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        userinfo_endpoint: `${base}/userinfo`,
        ...overrides.discovery,
      });
    }
    if (url.pathname === '/authorize') {
      const code = `code-${codes.size}`;
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge'),
        method: url.searchParams.get('code_challenge_method'),
      });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const auth = req.headers.authorization ?? '';
        const [id, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        if (id !== 'client-1' || secret !== 'shh') return json(401, { error: 'invalid_client' });
        const form = new URLSearchParams(body);
        const entry = codes.get(form.get('code'));
        if (!entry) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code'));
        const verifier = form.get('code_verifier') ?? '';
        const derived = createHash('sha256').update(verifier).digest('base64url');
        if (entry.method !== 'S256' || derived !== entry.challenge) return json(400, { error: 'invalid_grant' });
        json(200, { access_token: 'at-1', id_token: idToken(base, overrides.claims) });
      });
    }
    if (url.pathname === '/userinfo') {
      if (req.headers.authorization !== 'Bearer at-1') return json(401, { error: 'invalid_token' });
      return json(200, { sub: 'u-1', preferred_username: 'Alice.SSO', email: 'alice@corp.test', name: 'Alice SSO' });
    }
    json(404, { error: 'not_found' });
  });
  // listen() is async: address() is null until 'listening', so wait for the port.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    // fetch's agent keeps the socket alive, so close() alone would never resolve.
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Unsigned by design: the client verifies claims, not the signature (see its class comment). */
function idToken(issuer, over = {}) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ iss: issuer, aud: 'client-1', exp: 2000000000, ...over })}.x`;
}

const clientFor = (base, claim = 'preferred_username') =>
  new OidcClient(base, 'client-1', 'shh', 'openid profile email', claim);

/** Drive the redirect chain the browser would, and hand back what the callback sees. */
async function handshake(client, base) {
  const url = await client.authorizeUrl(`${base}/back`, '/board');
  const res = await fetch(url, { redirect: 'manual' });
  const back = new URL(res.headers.get('location'));
  return { code: back.searchParams.get('code'), state: back.searchParams.get('state') };
}

test('a full PKCE handshake yields the identity from userinfo', async (t) => {
  const p = await idp();
  t.after(p.close);
  const client = clientFor(p.base);
  const { code, state } = await handshake(client, p.base);

  const { identity, returnTo } = await client.complete(code, state, `${p.base}/back`);
  assert.equal(identity.username, 'alice.sso', 'usernames are normalised, so casing cannot fork an account');
  assert.equal(identity.email, 'alice@corp.test');
  assert.equal(identity.displayName, 'Alice SSO');
  assert.equal(returnTo, '/board');
});

test('the authorize URL carries S256 PKCE and a state', async (t) => {
  const p = await idp();
  t.after(p.close);
  const url = new URL(await clientFor(p.base).authorizeUrl(`${p.base}/back`, '/'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), `${p.base}/back`);
  assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 43);
  assert.ok((url.searchParams.get('state') ?? '').length >= 32);
});

test('a state is single-use, so a replayed callback cannot mint a second session', async (t) => {
  const p = await idp();
  t.after(p.close);
  const client = clientFor(p.base);
  const { code, state } = await handshake(client, p.base);
  await client.complete(code, state, `${p.base}/back`);

  await assert.rejects(() => client.complete(code, state, `${p.base}/back`), /unknown or expired/);
});

test('a state the client never issued is refused', async (t) => {
  const p = await idp();
  t.after(p.close);
  const client = clientFor(p.base);
  const { code } = await handshake(client, p.base);
  await assert.rejects(() => client.complete(code, 'forged-state', `${p.base}/back`), /unknown or expired/);
});

test('a code issued to one client cannot be redeemed with another client secret', async (t) => {
  const p = await idp();
  t.after(p.close);
  const good = clientFor(p.base);
  const { code, state } = await handshake(good, p.base);

  const bad = new OidcClient(p.base, 'client-1', 'wrong', 'openid', 'sub');
  // Give the impostor a state of its own; only the credentials differ.
  const own = await handshake(bad, p.base);
  await assert.rejects(() => bad.complete(own.code, own.state, `${p.base}/back`), /token exchange failed \(401\)/);
  // The honest flow still works, so the failure was the credentials, not the setup.
  await good.complete(code, state, `${p.base}/back`);
});

for (const [name, claims, message] of [
  ['a different issuer', { iss: 'https://evil.test' }, /different provider/],
  ['a different audience', { aud: 'other-client' }, /different client/],
  ['an expired token', { exp: 1000 }, /expired/],
  ['no expiry', { exp: undefined }, /missing exp/],
]) {
  test(`an id_token from ${name} is refused`, async (t) => {
    const p = await idp({ claims });
    t.after(p.close);
    const client = clientFor(p.base);
    const { code, state } = await handshake(client, p.base);
    await assert.rejects(() => client.complete(code, state, `${p.base}/back`), message);
  });
}

test('a missing username claim fails the sign-in rather than inventing one', async (t) => {
  const p = await idp();
  t.after(p.close);
  const client = clientFor(p.base, 'upn');
  const { code, state } = await handshake(client, p.base);
  await assert.rejects(() => client.complete(code, state, `${p.base}/back`), /no 'upn' claim/);
});

test('discovery missing an endpoint is a hard failure, not a guessed URL', async (t) => {
  const p = await idp({ discovery: { token_endpoint: undefined } });
  t.after(p.close);
  await assert.rejects(() => clientFor(p.base).authorizeUrl(`${p.base}/back`, '/'), /missing token_endpoint/);
});

test('OIDC return targets stay on the Companion origin', () => {
  assert.equal(safeReturnTo('/#/board?task=1'), '/#/board?task=1');
  assert.equal(safeReturnTo('//evil.example/path'), '/');
  assert.equal(safeReturnTo('/\\evil.example/path'), '/');
  assert.equal(safeReturnTo('/safe\n//evil.example'), '/');
  assert.equal(safeReturnTo('https://evil.example/path'), '/');
});
