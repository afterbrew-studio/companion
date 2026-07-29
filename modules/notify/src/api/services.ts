import { defineServices } from '@moxxy/companion-sdk/server';
import { NotifyStore } from './notify-store.js';
import { NotifyService } from './notify-service.js';

/**
 * Construct the outbound-delivery domain. The public URL comes from daemon
 * config and is read live, so an instance that learns its own address later
 * starts producing clickable links without a channel edit.
 */
export default defineServices((ctx) => {
  const store = new NotifyStore(ctx.db);
  ctx.services.register('notify', new NotifyService(store, () => ctx.config.publicUrl ?? null, ctx.broadcast));
});
