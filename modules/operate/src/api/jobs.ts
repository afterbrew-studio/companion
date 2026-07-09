import { defineJobs } from '@companion/core/server';
import { createRunScopeResolver } from './ws-scope.js';

/**
 * Preserves the legacy boot order: recover+start immediately after
 * construction; resumePersistedQueue only after ALL modules' onEnable — i.e.
 * after module-code has registered its triage/pr-review resumers — and the
 * webhook tunnel re-opened last. The run-stream visibility resolver registers
 * here (and unregisters on disable), so private-workspace output and one
 * user's AI-Help chat never reach other users' sockets.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const op = ctx.services.get('operate');
    ctx.ws.registerScopeResolver('operate', createRunScopeResolver(ctx));
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
    ctx.ws.unregisterScopeResolver('operate');
    await op.orchestrator.shutdown();
    op.webhookTunnel.close();
  },
});
