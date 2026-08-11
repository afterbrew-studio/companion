import assert from 'node:assert/strict';
import test from 'node:test';
import buildRoutes from '../dist/api/routes.js';

/**
 * The HTTP edge: `kind` is validated against what this build can construct a
 * client for, and the credential fields carry their tri-state (absent keeps,
 * string replaces, null clears) through zod unharmed.
 */

function harness() {
  const calls = [];
  const runtime = {
    list: () => [],
    ready: () => true,
    get: () => ({ id: 'p', label: 'P', kind: 'openai', models: [] }),
    create: (body) => {
      calls.push(['create', body]);
      return { id: 'p' };
    },
    update: async (id, body) => {
      calls.push(['update', id, body]);
      return { id };
    },
    getMcp: () => ({ id: 's', label: 'S', transport: 'http', url: 'https://mcp.example/mcp', command: null }),
    updateMcp: (id, body) => {
      calls.push(['updateMcp', id, body]);
      return { id };
    },
  };
  const routes = buildRoutes({ services: { get: () => runtime } });
  const run = (method, path, params, body) => {
    const found = routes.find((r) => r.method === method && r.path === path);
    return found.run(params, new URLSearchParams(), body, null, null, '127.0.0.1');
  };
  return { run, calls };
}

test('the create edge rejects a kind this build cannot construct', async () => {
  const { run } = harness();
  await assert.rejects(() => run('POST', '/api/model-providers', {}, { label: 'X', kind: 'made-up' }));
});

test('the create edge accepts every built-in kind', async () => {
  const { run } = harness();
  for (const kind of ['anthropic', 'openai', 'azure', 'openai-compatible']) {
    await run('POST', '/api/model-providers', {}, { label: 'X', kind, baseUrl: 'https://llm.example/v1' });
  }
});

test('a patch may not switch a provider to an unknown kind', async () => {
  const { run } = harness();
  await assert.rejects(() => run('PATCH', '/api/model-providers/:id', { id: 'p' }, { kind: 'made-up' }));
});

test('a create may not carry a null apiKey; clearing is a patch-only idea', async () => {
  const { run } = harness();
  await assert.rejects(() =>
    run('POST', '/api/model-providers', {}, { label: 'X', kind: 'openai', apiKey: null }),
  );
});

test('the provider patch carries the tri-state credential through the edge', async () => {
  const { run, calls } = harness();
  await run('PATCH', '/api/model-providers/:id', { id: 'p' }, { apiKey: null });
  await run('PATCH', '/api/model-providers/:id', { id: 'p' }, { apiKey: 'fresh' });
  await run('PATCH', '/api/model-providers/:id', { id: 'p' }, { enabled: false });
  assert.equal(calls[0][2].apiKey, null);
  assert.equal(calls[1][2].apiKey, 'fresh');
  assert.equal('apiKey' in calls[2][2], false, 'an absent key stays absent, which is what "keep" means');
});

test('the MCP patch carries the tri-state secret through the edge', async () => {
  const { run, calls } = harness();
  await run('PATCH', '/api/mcp-servers/:id', { id: 's' }, { secret: null });
  await run('PATCH', '/api/mcp-servers/:id', { id: 's' }, { label: 'Renamed' });
  assert.equal(calls[0][2].secret, null);
  assert.equal('secret' in calls[1][2], false);
});
