import { defineJobs, log } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

let unsubscribe: (() => void) | null = null;

/**
 * Deleting an account must also delete the personal connections it owned,
 * secrets included; otherwise they linger, invisible to everyone yet still
 * resolvable. Core announces the deletion on the bus; the cleanup lives with
 * the module that owns the tables.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const integrations = ctx.services.get('integrations');
    unsubscribe?.();
    unsubscribe = ctx.bus.on('auth.user.deleted', ({ username }) => {
      try {
        const removed = integrations.removeConnectionsOwnedBy(username);
        if (removed > 0) {
          log.info(`integrations: removed ${removed} personal connection(s) of deleted user '${username}'`);
        }
      } catch (error) {
        log.warn('integrations: personal-connection cleanup failed', { err: String(error) });
      }
    });
  },
  onDisable: () => {
    unsubscribe?.();
    unsubscribe = null;
  },
});
