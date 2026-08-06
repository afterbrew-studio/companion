import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeService } from '../dist/api/runtime-service.js';

/**
 * Which run reaches which MCP server, and what it is handed when it does.
 *
 * This is the whole security boundary of the feature: the runtime applies no
 * policy of its own, so anything this filter lets through is reachable by an
 * agent, and anything it puts in a spec is a value that leaves the daemon.
 */

function row(overrides = {}) {
  const record = {
    id: 'srv',
    label: 'Server',
    transport: 'http',
    command: null,
    args: [],
    env: {},
    url: 'https://mcp.example/mcp',
    headers: {},
    access: ['workspace-write'],
    tools: null,
    workspaceIds: null,
    enabled: true,
    ...overrides,
  };
  return {
    id: record.id,
    label: record.label,
    transport: record.transport,
    command: record.command,
    args: JSON.stringify(record.args),
    env: JSON.stringify(record.env),
    url: record.url,
    headers: JSON.stringify(record.headers),
    access: JSON.stringify(record.access),
    tools: record.tools === null ? null : JSON.stringify(record.tools),
    workspace_ids: record.workspaceIds === null ? null : JSON.stringify(record.workspaceIds),
    enabled: record.enabled ? 1 : 0,
    created_at: 1,
  };
}

function service(rows, secrets = {}) {
  const kept = new Map(Object.entries(secrets));
  return new RuntimeService(
    { list: () => [] },
    { list: () => rows, get: (id) => rows.find((entry) => entry.id === id) ?? null },
    {
      get: (key) => kept.get(key) ?? null,
      set: (key, value) => kept.set(key, value),
      delete: (key) => kept.delete(key),
    },
    () => ({
      maxSteps: 40,
      turnTimeoutMinutes: 30,
      childMemoryMb: 1024,
      commandTimeoutMinutes: 10,
      approvalTimeoutMinutes: 10,
      toolOutputChars: 30_000,
    }),
    () => undefined,
  );
}

test('a server is offered only to the run accesses it names', () => {
  const runtime = service([row({ access: ['read-only', 'trusted-assistant'] })]);
  assert.equal(runtime.mcpFor('read-only').length, 1);
  assert.equal(runtime.mcpFor('trusted-assistant').length, 1);
  assert.equal(runtime.mcpFor('workspace-write').length, 0, 'an access it does not name gets nothing');
});

test('a server naming no access is reachable by no run at all', () => {
  const runtime = service([row({ access: [] })]);
  for (const access of ['read-only', 'workspace-write', 'trusted-assistant']) {
    assert.equal(runtime.mcpFor(access).length, 0, `${access} gets nothing`);
  }
});

test('a disabled server is never offered', () => {
  const runtime = service([row({ enabled: false })]);
  assert.equal(runtime.mcpFor('workspace-write').length, 0);
});

test('workspace scope narrows the same way a provider is narrowed', () => {
  const runtime = service([row({ workspaceIds: ['ws-a'] })]);
  assert.equal(runtime.mcpFor('workspace-write', 'ws-a').length, 1);
  assert.equal(runtime.mcpFor('workspace-write', 'ws-b').length, 0);
  // A run with no workspace must not inherit a scoped server: "unscoped" is a
  // narrower answer than "every workspace", never a wider one.
  assert.equal(runtime.mcpFor('workspace-write', null).length, 0);
  assert.equal(runtime.mcpFor('workspace-write').length, 0);
});

test('an unscoped server serves every run, including one with no workspace', () => {
  const runtime = service([row({ workspaceIds: null })]);
  assert.equal(runtime.mcpFor('workspace-write', 'ws-a').length, 1);
  assert.equal(runtime.mcpFor('workspace-write', null).length, 1);
});

test('the secret is substituted where the operator wrote it, and only there', () => {
  const runtime = service(
    [row({ headers: { authorization: 'Bearer ${secret}', 'x-tenant': 'acme' } })],
    { 'mcp:srv:secret': 's3cr3t' },
  );
  const [spec] = runtime.mcpFor('workspace-write');
  assert.equal(spec.transport.headers.authorization, 'Bearer s3cr3t');
  assert.equal(spec.transport.headers['x-tenant'], 'acme', 'a value without the placeholder is untouched');
});

test('a stdio server carries its secret in the environment the same way', () => {
  const runtime = service(
    [row({ transport: 'stdio', command: '/usr/bin/thing', url: null, env: { API_TOKEN: '${secret}' } })],
    { 'mcp:srv:secret': 'abc' },
  );
  const [spec] = runtime.mcpFor('workspace-write');
  assert.equal(spec.transport.kind, 'stdio');
  assert.equal(spec.transport.command, '/usr/bin/thing');
  assert.equal(spec.transport.env.API_TOKEN, 'abc');
});

/**
 * With no secret stored the placeholder resolves to nothing rather than being
 * sent verbatim. A server answering 401 is a diagnosable failure; one receiving
 * the literal text `${secret}` as a bearer token is not.
 */
test('an unset secret leaves an empty value, never the placeholder itself', () => {
  const runtime = service([row({ headers: { authorization: 'Bearer ${secret}' } })]);
  const [spec] = runtime.mcpFor('workspace-write');
  assert.equal(spec.transport.headers.authorization, 'Bearer ');
});

test('the record a browser reads carries whether a secret is set, never its value', () => {
  const runtime = service([row()], { 'mcp:srv:secret': 's3cr3t' });
  const [record] = runtime.listMcp();
  assert.equal(record.hasSecret, true);
  assert.ok(!JSON.stringify(record).includes('s3cr3t'), 'no field anywhere carries the credential');
  assert.equal(service([row()]).listMcp()[0].hasSecret, false);
});
