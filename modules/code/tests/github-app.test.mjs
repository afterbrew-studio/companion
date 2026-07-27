import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { appJwt, installationLogin, mintInstallationToken } from '../dist/api/github-app.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

/** A GitHub that actually checks the app JWT, so a broken signature cannot pass. */
async function githubApp({ expiresIn = 3600, installLogin = 'acme-corp' } = {}) {
  const minted = [];
  const server = createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const jwt = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const [h, p, sig] = jwt.split('.');
    if (!h || !p || !sig) return json(401, { message: 'no app jwt' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${p}`);
    if (!verifier.verify(publicKey, Buffer.from(sig, 'base64url'))) {
      return json(401, { message: 'bad signature' });
    }
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (claims.iss !== '123456') return json(401, { message: 'wrong app id' });
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now || claims.iat > now) return json(401, { message: 'jwt outside its window' });

    if (req.url === '/app/installations/777') return json(200, { account: { login: installLogin } });
    if (req.url === '/app/installations/777/access_tokens' && req.method === 'POST') {
      const token = `ghs_installation_${minted.length}`;
      minted.push(token);
      return json(201, { token, expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() });
    }
    json(404, { message: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    api: `http://127.0.0.1:${server.address().port}`,
    minted,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test('the app JWT is RS256, issued by the app, and inside GitHub ten-minute window', () => {
  const [header, payload] = appJwt('123456', PEM).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  assert.equal(claims.iss, '123456');
  // Backdated, or a daemon with a slightly fast clock fails every mint with an
  // error that says nothing about clocks.
  assert.ok(claims.iat < now, 'iat must be backdated');
  assert.ok(claims.exp - now <= 600, 'GitHub rejects a JWT valid for more than ten minutes');
  assert.ok(claims.exp > now);
});

test('a private key that is not a PEM fails with a message naming the cause', () => {
  assert.throws(() => appJwt('123456', 'not a key'), /not a valid PEM/);
});

test('minting returns the installation token and when it dies', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const before = Date.now();

  const minted = await mintInstallationToken(gh.api, '123456', '777', PEM);
  assert.equal(minted.token, 'ghs_installation_0');
  assert.ok(minted.expiresAt > before, 'an expiry in the past would re-mint on every check');
  assert.ok(minted.expiresAt - before <= 3_600_000 + 5_000);
});

test('identity comes from the installation, because an app has no viewer', async (t) => {
  const gh = await githubApp({ installLogin: 'acme-corp' });
  t.after(gh.close);
  assert.equal(await installationLogin(gh.api, '123456', '777', PEM), 'acme-corp');
});

test('a key that does not belong to the app is refused, not silently accepted', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  await assert.rejects(() => mintInstallationToken(gh.api, '123456', '777', other), /rejected the app credentials/);
});

test('the wrong App ID is refused', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  await assert.rejects(() => mintInstallationToken(gh.api, '999999', '777', PEM), /rejected the app credentials/);
});

test('an installation that is gone names the likely cause', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  await assert.rejects(() => mintInstallationToken(gh.api, '123456', '404', PEM), /no such installation/);
});
