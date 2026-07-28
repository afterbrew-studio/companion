import { defineServices } from '@moxxy/companion-sdk/server';
import { WorkspacesStore } from './workspaces-store.js';
import { NotificationsStore } from './notifications-store.js';
import { NotificationsService } from './notifications-service.js';
import { ReportsStore } from './reports-store.js';

/**
 * Construct the access-control store (ensuring a default workspace), the
 * notification inbox, and the reports store, then publish all three.
 * `notifications` is what the kernel's `ctx.notify` proxy resolves to, so it
 * must register here; `reports` is what producer modules (code, automations)
 * write their digests/analyses through.
 */
export default defineServices((ctx) => {
  const workspaces = new WorkspacesStore(ctx.db);
  workspaces.ensureDefault();
  ctx.services.register('workspace', workspaces);

  const notificationsStore = new NotificationsStore(ctx.db);
  const notifications = new NotificationsService(notificationsStore, ctx.broadcast);
  ctx.services.register('notifications', notifications);

  ctx.services.register('reports', new ReportsStore(ctx.db));
});
