import { defineJobs, log } from '@moxxy/companion-sdk/server';

let unsubscribe: (() => void) | null = null;

/**
 * The one subscription this module exists for. Every inbox entry in the product
 * is minted by `ctx.notify.emit`, which raises `notification.raised`, so
 * subscribing here delivers whatever any module raises, including modules
 * added later, without either side knowing about the other.
 *
 * The handler never awaits and never rethrows: the notification is already in
 * the inbox, and the operation that raised it has moved on.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const notify = ctx.services.get('notify');
    unsubscribe = ctx.bus.on('notification.raised', (notification) => {
      void notify.fanOut(notification).catch((err) => log.warn('outbound fan-out failed', { err: String(err) }));
    });
  },
  onDisable: () => {
    // Dropping the subscription is what "disabled" means here: the inbox keeps
    // working, nothing leaves the instance.
    unsubscribe?.();
    unsubscribe = null;
  },
});
