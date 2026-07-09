import { defineServices } from '@companion/core/server';
import { WorkspacesStore } from './workspaces-store.js';
import { NotificationsStore } from './notifications-store.js';
import { NotificationsService } from './notifications-service.js';

/**
 * Construct the access-control store (ensuring a default workspace) and the
 * notification inbox, then publish both. `notifications` is what the kernel's
 * `ctx.notify` proxy resolves to, so it must register here.
 */
export default defineServices((ctx) => {
  const workspaces = new WorkspacesStore(ctx.db);
  workspaces.ensureDefault();
  ctx.services.register('workspace', workspaces);

  const notificationsStore = new NotificationsStore(ctx.db);
  const notifications = new NotificationsService(notificationsStore, ctx.broadcast);
  ctx.services.register('notifications', notifications);
});
