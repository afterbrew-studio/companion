import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
