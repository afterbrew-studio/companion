import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { IntegrationsService } from '../dist/api/integrations-service.js';
import { IntegrationsStore } from '../dist/api/integrations-store.js';
import { IntegrationUnavailableError } from '../dist/api/provider.js';
import migrations from '../dist/api/migrations.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const values = new Map();
  const secrets = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
    keys: () => [...values.keys()],
  };
  const messages = [];
  const store = new IntegrationsStore(db);
  const service = new IntegrationsService(store, secrets, (message) => messages.push(message));
  return { db, service, store, values, messages };
}

function provider(id = 'vendor.review') {
  return {
    descriptor: {
      id,
      moduleId: 'vendor',
      vendor: 'Vendor',
      title: 'Vendor review',
      description: 'A test review provider.',
      category: 'review',
      capabilities: ['code-review'],
      scopes: ['instance', 'workspace', 'repository'],
      connectionMode: 'required',
      execution: 'remote',
      fields: [
        { key: 'region', label: 'Region', kind: 'text', required: true },
        { key: 'token', label: 'Token', kind: 'secret', required: true },
      ],
    },
    review: async () => ({ kind: 'skipped', summary: 'test' }),
  };
}

function connection(service, id, scope, over = {}) {
  return service.createConnection({
    providerId: 'vendor.review',
    name: id,
    scope,
    enabled: true,
    config: { region: 'eu', token: `${id}-secret` },
    ...over,
  }, null);
}

test('secret fields are write-only and only their configured names cross the catalog boundary', () => {
  const { db, service, values } = fixture();
  service.registerProvider(provider());
  const record = connection(service, 'shared', { kind: 'instance' });

  assert.deepEqual(record.config, { region: 'eu' });
  assert.deepEqual(record.configuredSecrets, ['token']);
  assert.doesNotMatch(JSON.stringify(service.catalog(null)), /shared-secret/);
  assert.equal(values.get(`connection:${record.id}:token`), 'shared-secret');
  db.close();
});

test('vendor validation runs against prospective secrets before anything is persisted', () => {
  const { db, service, values } = fixture();
  const adapter = provider();
  service.registerProvider({
    ...adapter,
    validateConfig: (config, secret) => {
      if (config.region !== 'eu' || secret('token') !== 'accepted-secret') {
        throw new Error('vendor configuration is invalid');
      }
    },
  });

  assert.throws(
    () => connection(service, 'rejected', { kind: 'instance' }),
    /vendor configuration is invalid/,
  );
  assert.equal(service.catalog(null).connections.length, 0);
  assert.equal(values.size, 0);

  const accepted = connection(service, 'accepted', { kind: 'instance' }, {
    config: { region: 'eu', token: 'accepted-secret' },
  });
  assert.throws(
    () => service.updateConnection(accepted.id, { config: { region: 'us', token: 'replacement' } }),
    /vendor configuration is invalid/,
  );
  assert.deepEqual(service.getConnection(accepted.id).config, { region: 'eu' });
  assert.equal(values.get(`connection:${accepted.id}:token`), 'accepted-secret');
  db.close();
});

test('an ordered route skips an unavailable primary but keeps real provider failures visible', () => {
  const { db, service } = fixture();
  service.registerProvider(provider());
  const primary = connection(service, 'primary', { kind: 'workspace', workspaceId: 'ws-1' }, { enabled: false });
  const fallback = connection(service, 'fallback', { kind: 'instance' });
  const scope = { kind: 'repository', workspaceId: 'ws-1', repo: 'acme/app' };
  service.setRoute('code-review', scope, [
    { providerId: 'vendor.review', connectionId: primary.id },
    { providerId: 'vendor.review', connectionId: fallback.id },
  ]);

  assert.deepEqual(service.resolveTargets('code-review', scope).map((target) => target.ref.connectionId), [fallback.id]);
  assert.throws(
    () => service.resolveTargets('code-review', scope, { providerId: 'vendor.review', connectionId: primary.id }),
    IntegrationUnavailableError,
  );
  db.close();
});

test('personal connections are invisible to another caller and cannot enter shared routing', () => {
  const { db, service } = fixture();
  const base = provider();
  service.registerProvider({
    ...base,
    descriptor: { ...base.descriptor, supportsPersonal: true },
  });
  const mine = service.createConnection({
    providerId: 'vendor.review',
    name: 'mine',
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    enabled: true,
    config: { region: 'eu', token: 'personal-secret' },
  }, 'ana');
  const scope = { kind: 'repository', workspaceId: 'ws-1', repo: 'acme/app' };

  assert.equal(service.resolveTargets('code-review', scope, { providerId: 'vendor.review', connectionId: mine.id }, 'ana').length, 1);
  assert.throws(
    () => service.resolveTargets('code-review', scope, { providerId: 'vendor.review', connectionId: mine.id }, 'bob'),
    IntegrationUnavailableError,
  );
  assert.throws(
    () => service.setRoute('code-review', scope, [{ providerId: 'vendor.review', connectionId: mine.id }]),
    /personal connections cannot be shared/,
  );
  db.close();
});

test('removing a connection also removes its stale references from durable routes', () => {
  const { db, service, values } = fixture();
  service.registerProvider(provider());
  const one = connection(service, 'one', { kind: 'instance' });
  const two = connection(service, 'two', { kind: 'instance' });
  const scope = { kind: 'workspace', workspaceId: 'ws-1' };
  service.setRoute('code-review', scope, [
    { providerId: 'vendor.review', connectionId: one.id },
    { providerId: 'vendor.review', connectionId: two.id },
  ]);

  service.removeConnection(one.id);
  assert.deepEqual(service.effectiveRoute('code-review', scope).targets, [
    { providerId: 'vendor.review', connectionId: two.id },
  ]);
  assert.equal([...values.keys()].some((key) => key.includes(one.id)), false);
  db.close();
});

test('an empty route clears the override and removing its last connection restores inheritance', () => {
  const { db, service } = fixture();
  service.registerProvider(provider());
  const instance = connection(service, 'instance', { kind: 'instance' });
  const repo = connection(service, 'repo', { kind: 'repository', workspaceId: 'ws-1', repo: 'acme/app' });
  const instanceScope = { kind: 'instance' };
  const repoScope = { kind: 'repository', workspaceId: 'ws-1', repo: 'acme/app' };
  service.setRoute('code-review', instanceScope, [{ providerId: 'vendor.review', connectionId: instance.id }]);
  service.setRoute('code-review', repoScope, [{ providerId: 'vendor.review', connectionId: repo.id }]);

  service.setRoute('code-review', repoScope, []);
  assert.equal(service.effectiveRoute('code-review', repoScope).sourceScope.kind, 'instance');
  assert.equal(service.effectiveRoute('code-review', repoScope).targets[0].connectionId, instance.id);

  service.setRoute('code-review', repoScope, [{ providerId: 'vendor.review', connectionId: repo.id }]);
  service.removeConnection(repo.id);
  assert.equal(service.effectiveRoute('code-review', repoScope).sourceScope.kind, 'instance');
  assert.equal(service.effectiveRoute('code-review', repoScope).targets[0].connectionId, instance.id);
  db.close();
});

test('provider and route capability ids are bounded platform identifiers', () => {
  const { db, service } = fixture();
  const malformed = provider();
  assert.throws(
    () => service.registerProvider({
      ...malformed,
      descriptor: { ...malformed.descriptor, capabilities: ['../../admin'] },
    }),
    /invalid integration capability/,
  );
  assert.throws(
    () => service.effectiveRoute('x'.repeat(121), { kind: 'instance' }),
    /invalid integration capability/,
  );
  db.close();
});

test('provider output is bounded and validated before it crosses into a consumer module', async () => {
  const { db, service } = fixture();
  const adapter = provider();
  service.registerProvider({
    ...adapter,
    review: async () => ({
      kind: 'draft',
      summary: 'Too many findings',
      reviewBody: 'No provider may make durable state unbounded.',
      coverage: 'complete',
      findings: Array.from({ length: 501 }, () => ({
        severity: 'minor',
        title: 'Bounded finding',
        file: null,
        line: null,
        reason: 'reason',
        impact: 'impact',
        suggestion: 'suggestion',
        confidence: 0.8,
      })),
    }),
  });
  const bounded = connection(service, 'bounded', { kind: 'instance' });
  const [target] = service.resolveTargets(
    'code-review',
    { kind: 'instance' },
    { providerId: 'vendor.review', connectionId: bounded.id },
  );

  await assert.rejects(
    () => service.executeReview(target, { signal: new AbortController().signal }),
    /at most 500/,
  );
  db.close();
});

test('optional providers may run connectionless while required providers may not', () => {
  const { db, service } = fixture();
  const optional = provider('vendor.optional');
  service.registerProvider({
    ...optional,
    descriptor: {
      ...optional.descriptor,
      connectionMode: 'optional',
      fields: [],
      defaultFor: ['code-review'],
    },
  });
  service.registerProvider(provider('vendor.required'));

  assert.equal(service.resolveTargets('code-review', { kind: 'instance' })[0].connection, null);
  assert.throws(
    () => service.setRoute('code-review', { kind: 'instance' }, [
      { providerId: 'vendor.required', connectionId: null },
    ]),
    /requires a connection/,
  );
  db.close();
});

test('provider ids and default capability ownership are unique', () => {
  const { db, service } = fixture();
  const first = provider('vendor.first');
  service.registerProvider({
    ...first,
    descriptor: { ...first.descriptor, connectionMode: 'optional', fields: [], defaultFor: ['code-review'] },
  });
  assert.throws(() => service.registerProvider(first), /already owned/);

  const second = provider('vendor.second');
  assert.throws(
    () => service.registerProvider({
      ...second,
      descriptor: { ...second.descriptor, connectionMode: 'optional', fields: [], defaultFor: ['code-review'] },
    }),
    /already has default provider/,
  );
  db.close();
});

test('secrets are redacted from provider health, errors and review output', async () => {
  const { db, service } = fixture();
  const adapter = provider();
  service.registerProvider({
    ...adapter,
    validateConfig: (_config, secret) => {
      if (secret('token') === 'reject-me') throw new Error('bad token reject-me');
    },
    probe: async (access) => ({
      status: 'unavailable',
      message: `credential ${access.secret('token')} expired`,
      checkedAt: Date.now(),
    }),
    review: async (access, request) => {
      if (request.fail) throw new IntegrationUnavailableError(`credential ${access.secret('token')} rejected`);
      return {
        kind: 'draft',
        summary: `used ${access.secret('token')}`,
        reviewBody: `body ${access.secret('token')}`,
        coverage: 'complete',
        findings: [],
      };
    },
  });
  assert.throws(
    () => connection(service, 'rejected-secret', { kind: 'instance' }, {
      config: { region: 'eu', token: 'reject-me' },
    }),
    (error) => !String(error).includes('reject-me') && String(error).includes('[redacted]'),
  );

  const record = connection(service, 'safe-secret', { kind: 'instance' }, {
    config: { region: 'eu', token: 'top-secret' },
  });
  const checked = await service.testConnection(record.id);
  assert.equal(checked.health.message, 'credential [redacted] expired');
  const [target] = service.resolveTargets(
    'code-review',
    { kind: 'instance' },
    { providerId: 'vendor.review', connectionId: record.id },
  );
  const result = await service.executeReview(target, { signal: new AbortController().signal });
  assert.equal(result.summary, 'used [redacted]');
  assert.equal(result.reviewBody, 'body [redacted]');
  await assert.rejects(
    () => service.executeReview(target, { fail: true, signal: new AbortController().signal }),
    (error) =>
      error instanceof IntegrationUnavailableError &&
      !String(error).includes('top-secret') &&
      String(error).includes('[redacted]'),
  );
  db.close();
});

test('a failed database update restores the previous secret value', () => {
  const { db, service, store, values } = fixture();
  service.registerProvider(provider());
  const atomic = connection(service, 'atomic', { kind: 'instance' });
  store.update = () => {
    throw new Error('database unavailable');
  };

  assert.throws(
    () => service.updateConnection(atomic.id, { config: { region: 'us', token: 'replacement' } }),
    /database unavailable/,
  );
  assert.equal(values.get(`connection:${atomic.id}:token`), 'atomic-secret');
  db.close();
});
