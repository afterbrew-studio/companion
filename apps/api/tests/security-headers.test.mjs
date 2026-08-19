import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startHttpServer } from '../dist/http/server.js';

test('every response carries a hashed CSP and baseline browser hardening', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'companion-http-'));
  const importMap = '{"imports":{"probe":"/probe.js"}}';
  writeFileSync(join(root, 'index.html'), `<script type="importmap">${importMap}</script><main>ok</main>`);
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    authMode: 'password',
    kernel: { rawRouter: { active: false } },
    hub: { handleUpgrade() {} },
    staticDir: root,
    publicUrl: 'https://companion.example.test',
  });
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  const csp = response.headers.get('content-security-policy') ?? '';
  const expectedHash = createHash('sha256').update(importMap).digest('base64');

  assert.match(csp, new RegExp(`script-src 'self' 'sha256-${expectedHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
  assert.doesNotMatch(csp.match(/script-src[^;]*/)?.[0] ?? '', /unsafe-inline/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('permissions-policy') ?? '', /camera=\(\)/);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
});

test('static requests select only boot-indexed files and reject traversal-shaped paths', async (t) => {
  const container = mkdtempSync(join(tmpdir(), 'companion-static-'));
  const root = join(container, 'web');
  mkdirSync(root);
  writeFileSync(join(root, 'index.html'), '<main>app</main>');
  mkdirSync(join(root, 'desk'));
  writeFileSync(join(root, 'desk', 'index.html'), '<main>desk</main>');
  writeFileSync(join(root, 'asset.js'), 'console.log("safe")');
  writeFileSync(join(container, 'outside.txt'), 'must not be served');
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    authMode: 'password',
    kernel: { rawRouter: { active: false } },
    hub: { handleUpgrade() {} },
    staticDir: root,
  });
  t.after(() => {
    server.close();
    rmSync(container, { recursive: true, force: true });
  });
  const port = server.address().port;

  assert.deepEqual(await rawGet(port, '/ordinary/spa/route'), { status: 200, body: '<main>app</main>' });
  assert.deepEqual(await rawGet(port, '/desk/'), { status: 200, body: '<main>desk</main>' });
  assert.deepEqual(await rawGet(port, '/desk/missions/one'), { status: 200, body: '<main>desk</main>' });
  assert.equal((await rawGet(port, '/%2e%2e/outside.txt')).status, 403);
  assert.equal((await rawGet(port, '/..%5coutside.txt')).status, 403);
  assert.equal((await rawGet(port, '/bad%zz')).status, 400);

  // The path was safe when indexed, but becomes a symlink before it is read.
  // The server must validate the opened descriptor instead of following it.
  rmSync(join(root, 'asset.js'));
  symlinkSync(join(container, 'outside.txt'), join(root, 'asset.js'));
  assert.equal((await rawGet(port, '/asset.js')).status, 404);
});

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    req.end();
  });
}
