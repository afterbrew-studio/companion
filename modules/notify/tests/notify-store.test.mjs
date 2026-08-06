import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { NotifyStore } from '../dist/api/notify-store.js';

test('delivery limits apply after immutable delivery-scope visibility', () => {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const store = new NotifyStore(db);
  const entry = (id, connectionId, createdAt) => ({
    id,
    connectionId,
    providerId: 'slack.webhook',
    connectionName: connectionId,
    title: id,
    status: 'delivered',
    httpStatus: 204,
    error: null,
    attempts: 1,
    createdAt,
  });

  const now = Date.now();
  store.logDelivery(entry('visible-older', 'visible', now - 1_000), { kind: 'workspace', workspaceId: 'ws-1' }, null);
  for (let index = 0; index < 120; index++) {
    store.logDelivery(
      entry(`other-${index}`, 'other-workspace', now + index),
      { kind: 'workspace', workspaceId: 'ws-2' },
      null,
    );
  }

  assert.deepEqual(
    store.deliveriesForScopes([{ kind: 'workspace', workspaceId: 'ws-1' }], 'alice', 100)
      .map((delivery) => delivery.id),
    ['visible-older'],
  );

  // Visibility follows the scope at delivery time, not a connection's later
  // destination. Moving or deleting the connection cannot move old titles.
  assert.deepEqual(
    store.deliveriesForScopes([{ kind: 'workspace', workspaceId: 'ws-2' }], 'alice', 100)
      .filter((delivery) => delivery.id === 'visible-older'),
    [],
  );
  db.close();
});
