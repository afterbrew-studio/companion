import { defineJobs } from '@companion/core/server';

/**
 * The schedule ticker's lifecycle: the legacy main() called
 * `automations.start()` right after construction and `automations.stop()` at
 * shutdown — here that maps to enable/disable, so toggling the module off
 * silences every scheduled automation (webhook delivery stops with the routes).
 */
export default defineJobs({
  onEnable: (ctx) => {
    ctx.services.get('automations').automations.start();
  },
  onDisable: (ctx) => {
    ctx.services.get('automations').automations.stop();
  },
});
