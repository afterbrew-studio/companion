import { defineJobs } from '@moxxy/companion-sdk/server';

let unregister: (() => void) | null = null;

/** Attach/detach the policy provider with the module runtime lifecycle. */
export default defineJobs({
  onEnable: (ctx) => {
    unregister?.();
    const router = ctx.services.get('model-router');
    unregister = ctx.services.get('operate').setRunRoutingProvider(router);
  },
  onDisable: () => {
    unregister?.();
    unregister = null;
  },
});
