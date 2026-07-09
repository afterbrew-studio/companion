import { defineServices } from '@companion/core/server';
import { WorkspacesStore } from './workspaces-store.js';

/** Construct the access-control store, ensure a default workspace, and publish it. */
export default defineServices((ctx) => {
  const workspaces = new WorkspacesStore(ctx.db);
  workspaces.ensureDefault();
  ctx.services.register('workspace', workspaces);
});
