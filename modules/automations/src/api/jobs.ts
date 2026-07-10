import { defineJobs } from '@companion/core/server';

/**
 * The schedule ticker's lifecycle: the legacy main() called
 * `automations.start()` right after construction and `automations.stop()` at
 * shutdown — here that maps to enable/disable, so toggling the module off
 * silences every scheduled automation (webhook delivery stops with the routes).
 */
let offConfigChanged: (() => void) | null = null;

export default defineJobs({
  onEnable: (ctx) => {
    ctx.services.get('automations').automations.start();
    // The per-repo webhook URLs this module shows derive from operate's tunnel,
    // which follows operate's `webhookTunnel` config — refresh them on a change.
    offConfigChanged = ctx.bus.on('module-config.changed', ({ moduleId, keys }) => {
      if (moduleId === 'operate' && keys.includes('webhookTunnel')) ctx.broadcast({ t: 'repos.changed' });
    });
  },
  onDisable: (ctx) => {
    offConfigChanged?.();
    offConfigChanged = null;
    ctx.services.get('automations').automations.stop();
  },
});
