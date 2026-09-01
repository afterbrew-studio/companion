import assert from 'node:assert/strict';
import test from 'node:test';
import { octopusAdapterConfig, startOctopusReview } from '../dist/api/octopus-adapter.js';

test('octopus adapter config is absent until both URL and token are set', () => {
  assert.equal(octopusAdapterConfig({}), null);
  assert.equal(octopusAdapterConfig({ COMPANION_OCTOPUS_URL: 'https://octopus.example' }), null);
  assert.deepEqual(
    octopusAdapterConfig({
      COMPANION_OCTOPUS_URL: 'https://octopus.example/',
      COMPANION_OCTOPUS_TOKEN: 'tok',
    }),
    { baseUrl: 'https://octopus.example', token: 'tok' },
  );
});

test('startOctopusReview POSTs the CLI adapter and never applies a label', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null });
    if (String(url).includes('by-remote')) {
      return { ok: true, json: async () => ({ id: 'repo-1', fullName: 'acme/app' }) };
    }
    return { ok: true, json: async () => ({ message: 'Review started', prNumber: 12 }) };
  };
  const result = await startOctopusReview({
    baseUrl: 'https://octopus.example',
    token: 'tok',
    remoteUrl: 'https://github.com/acme/app.git',
    prNumber: 12,
    correlationId: 'corr-1',
    headSha: 'abc123',
    fetch: fetchImpl,
  });
  assert.equal(result.repoId, 'repo-1');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /by-remote/);
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /\/api\/cli\/repos\/repo-1\/review$/);
  assert.deepEqual(JSON.parse(calls[1].body), {
    prNumber: 12,
    correlationId: 'corr-1',
    headSha: 'abc123',
  });
  assert.equal(calls.every((call) => !String(call.body ?? '').includes('review:octopus')), true);
});
