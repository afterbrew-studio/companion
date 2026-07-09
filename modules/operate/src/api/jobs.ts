import { defineJobs } from '@companion/core/server';

/**
 * Preserves the legacy boot order: recover+start immediately after
 * construction; resumePersistedQueue only after ALL modules' onEnable — i.e.
 * after module-code has registered its triage/pr-review resumers — and the
 * webhook tunnel re-opened last.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const op = ctx.services.get('operate');
    op.orchestrator.recover();
    op.orchestrator.start();
  },
  postActivate: (ctx) => {
    const op = ctx.services.get('operate');
    op.orchestrator.resumePersistedQueue();
    // Re-expose the public webhook URL if the user had the tunnel enabled.
    op.webhookTunnel.restore();
  },
  onDisable: async (ctx) => {
    const op = ctx.services.get('operate');
    await op.orchestrator.shutdown();
    op.webhookTunnel.close();
  },
});
