import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionMcpServer, resolveMcpBaseUrl } from '../dist/mcp.js';

const action = {
  id: 'spec.create',
  title: 'Create specification',
  description: 'Save reviewed requirements.',
  access: ['workbench:read', 'specs:read', 'specs:manage'],
  impact: 'local',
  arguments: [
    { name: 'repo', type: 'string', required: true, description: 'Repository as owner/name' },
    { name: 'title', type: 'string', required: true, description: 'Specification title' },
    { name: 'content', type: 'string', required: true, description: 'Complete Markdown specification' },
  ],
};

function modernMeta(protocolVersion = '2026-07-28') {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

async function initializedServer(api) {
  const server = new CompanionMcpServer(api);
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  });
  assert.equal(response.result.protocolVersion, '2025-11-25');
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(
    await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    null,
  );
  return server;
}

test('retains the legacy lifecycle and exposes read plus prepare tools, never execute', async () => {
  const server = await initializedServer(async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/workbench/actions/catalog');
    return { actions: [action] };
  });
  const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = response.result.tools;

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['companion_today', 'companion_get', 'companion_list_prepared_actions', 'companion_prepare_spec_create'],
  );
  assert.equal(tools.some((tool) => /execute/i.test(tool.name)), false);
  const prepare = tools.at(-1);
  assert.deepEqual(prepare.inputSchema.required, ['workspaceId', 'repo', 'title', 'content']);
  assert.equal(prepare.inputSchema.additionalProperties, false);
  assert.equal(prepare.annotations.destructiveHint, false);
  assert.match(prepare.description, /never executes/);
  assert.equal('execution' in prepare, false);
});

test('supports stateless 2026 discovery and direct tool listing', async () => {
  const server = new CompanionMcpServer(async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/workbench/actions/catalog');
    return { actions: [action] };
  });
  const discover = await server.handle({
    jsonrpc: '2.0',
    id: 'discover',
    method: 'server/discover',
    params: { _meta: modernMeta() },
  });

  assert.equal(discover.result.resultType, 'complete');
  assert.deepEqual(discover.result.supportedVersions, [
    '2026-07-28',
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
  ]);
  assert.deepEqual(discover.result.capabilities, { tools: { listChanged: false } });
  assert.equal(discover.result.ttlMs, 0);
  assert.equal(discover.result.cacheScope, 'private');
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'companion');

  const response = await server.handle({
    jsonrpc: '2.0',
    id: 'tools',
    method: 'tools/list',
    params: { _meta: modernMeta() },
  });
  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result.ttlMs, 0);
  assert.equal(response.result.cacheScope, 'private');
  assert.equal(response.result.tools.at(-1).name, 'companion_prepare_spec_create');
  assert.equal('execution' in response.result.tools.at(-1), false);

  const removedPing = await server.handle({
    jsonrpc: '2.0',
    id: 'ping',
    method: 'ping',
    params: { _meta: modernMeta() },
  });
  assert.equal(removedPing.error.code, -32601);
});

test('modern requests require metadata and report supported versions', async () => {
  const missing = await new CompanionMcpServer(async () => ({ actions: [] })).handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {},
  });
  assert.equal(missing.error.code, -32602);

  const unsupported = await new CompanionMcpServer(async () => ({ actions: [] })).handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: { _meta: modernMeta('2099-01-01') },
  });
  assert.equal(unsupported.error.code, -32022);
  assert.equal(unsupported.error.data.requested, '2099-01-01');
  assert.equal(unsupported.error.data.supported[0], '2026-07-28');
});

test('modern prepare tool sends one typed proposal and returns the pending card', async () => {
  const calls = [];
  const server = new CompanionMcpServer(async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.endsWith('/catalog')) return { actions: [action] };
    return { action: { id: 'action-1', status: 'pending', ...body } };
  });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      _meta: modernMeta(),
      name: 'companion_prepare_spec_create',
      arguments: {
        workspaceId: 'ws-1',
        repo: 'acme/app',
        title: 'Search',
        content: '# Search\n\nAcceptance criteria.',
      },
    },
  });

  assert.deepEqual(calls, [
    { method: 'GET', path: '/api/workbench/actions/catalog', body: undefined },
    {
      method: 'POST',
      path: '/api/workbench/actions/spec.create/prepare',
      body: {
        workspaceId: 'ws-1',
        source: 'mcp',
        request: {
          action: 'spec.create',
          repo: 'acme/app',
          title: 'Search',
          content: '# Search\n\nAcceptance criteria.',
        },
      },
    },
  ]);
  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result._meta['io.modelcontextprotocol/serverInfo'].name, 'companion');
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.data.action.status, 'pending');
});

test('generic API tool is GET-only and rejects normalized path escapes', async () => {
  const calls = [];
  const server = await initializedServer(async (method, path) => {
    calls.push({ method, path });
    return { ok: true };
  });

  const read = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'companion_get', arguments: { path: '/api/prs?state=open' } },
  });
  assert.equal(read.result.isError, false);
  assert.deepEqual(calls, [{ method: 'GET', path: '/api/prs?state=open' }]);

  const escaped = await server.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'companion_get', arguments: { path: '/api/../admin' } },
  });
  assert.equal(escaped.result.isError, true);
  assert.match(escaped.result.content[0].text, /stay under \/api/);
});

test('malformed calls and unknown tools use protocol errors', async () => {
  const server = await initializedServer(async () => ({ actions: [action] }));
  const malformed = await server.handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'companion_get', arguments: 'not-an-object' },
  });
  assert.equal(malformed.error.code, -32602);

  const unknown = await server.handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'companion_execute_action', arguments: {} },
  });
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /Unknown tool/);
});

test('remote URL accepts http(s) only and never embeds credentials', () => {
  const before = process.env.COMPANION_URL;
  const tokenBefore = process.env.COMPANION_TOKEN;
  try {
    process.env.COMPANION_URL = 'https://companion.example.test/';
    delete process.env.COMPANION_TOKEN;
    assert.throws(() => resolveMcpBaseUrl('http://127.0.0.1:8901'), /COMPANION_TOKEN is required/);
    process.env.COMPANION_TOKEN = 'remote-test-token';
    assert.equal(resolveMcpBaseUrl('http://127.0.0.1:8901'), 'https://companion.example.test');
    process.env.COMPANION_URL = 'file:///tmp/companion';
    assert.throws(() => resolveMcpBaseUrl('http://127.0.0.1:8901'), /http or https/);
    process.env.COMPANION_URL = 'https://token@companion.example.test';
    assert.throws(() => resolveMcpBaseUrl('http://127.0.0.1:8901'), /must not contain credentials/);
  } finally {
    if (before === undefined) delete process.env.COMPANION_URL;
    else process.env.COMPANION_URL = before;
    if (tokenBefore === undefined) delete process.env.COMPANION_TOKEN;
    else process.env.COMPANION_TOKEN = tokenBefore;
  }
});
