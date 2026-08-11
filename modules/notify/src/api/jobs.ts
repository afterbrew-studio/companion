import { defineJobs, log } from '@moxxy/companion-sdk/server';
import { notificationProviders } from './notification-providers.js';
import { smtpNotificationProvider } from './smtp-provider.js';

let unsubscribe: (() => void) | null = null;
let unregisterProviders: Array<() => void> = [];
let pruneTimer: ReturnType<typeof setInterval> | null = null;

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
    unsubscribe?.();
    unsubscribe = null;
    for (const unregister of unregisterProviders) unregister();
    unregisterProviders = [];
    try {
      const providers = [...notificationProviders(() => ctx.config.publicUrl ?? null), smtpNotificationProvider()];
      for (const provider of providers) {
        unregisterProviders.push(ctx.services.get('integrations').registerProvider(provider));
      }
    } catch (error) {
      for (const unregister of unregisterProviders.reverse()) unregister();
      unregisterProviders = [];
      throw error;
    }
    try {
      unsubscribe = ctx.bus.on('notification.raised', (notification) => {
        void notify.fanOut(notification).catch((err) => log.warn('outbound fan-out failed', { err: String(err) }));
      });
      notify.pruneHistory();
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = setInterval(() => {
        try {
          notify.pruneHistory();
        } catch (error) {
          log.warn('notification delivery-history prune failed', { err: String(error) });
        }
      }, 6 * 60 * 60_000);
      pruneTimer.unref();
    } catch (error) {
      unsubscribe?.();
      unsubscribe = null;
      for (const unregister of unregisterProviders.reverse()) unregister();
      unregisterProviders = [];
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = null;
      throw error;
    }
  },
  onDisable: () => {
    // Dropping the subscription is what "disabled" means here: the inbox keeps
    // working, nothing leaves the instance.
    unsubscribe?.();
    unsubscribe = null;
    for (const unregister of unregisterProviders) unregister();
    unregisterProviders = [];
    if (pruneTimer) clearInterval(pruneTimer);
    pruneTimer = null;
  },
});
