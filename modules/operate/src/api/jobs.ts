import { defineJobs } from '@moxxy/companion-core/server';
import { createRunScopeResolver } from './ws-scope.js';

/**
 * Preserves the legacy boot order: recover+start immediately after
 * construction; resumePersistedQueue only after ALL modules' onEnable — i.e.
 * after module-code has registered its triage/pr-review resumers — and the
 * webhook tunnel re-opened last. The run-stream visibility resolver registers
 * here (and unregisters on disable), so private-workspace output and one
 * user's AI-Help chat never reach other users' sockets.
 */
let offConfigChanged: (() => void) | null = null;

export default defineJobs({
  onEnable: (ctx) => {
    const op = ctx.services.get('operate');
    ctx.ws.registerScopeResolver('operate', createRunScopeResolver(ctx));
    // Reconcile the tunnel with its config flag whenever the admin edits it.
    // The UI writes module config; nothing calls start/stop directly. The
    // WebhookTunnel broadcasts each transition itself so clients see
    // connecting, failure/retry, and the eventual public URL.
    offConfigChanged = ctx.bus.on('module-config.changed', ({ moduleId, keys }) => {
      if (moduleId !== 'operate' || !keys.includes('webhookTunnel')) return;
      const tunnel = ctx.services.get('operate').webhookTunnel;
      void (async () => {
        if (tunnel.enabled()) await tunnel.start();
        else await tunnel.stop();
      })().catch((err) => ctx.log.warn('webhook tunnel reconcile failed', { err: String(err) }));
    });
    op.orchestrator.recover();
    op.orchestrator.start();
  },
  /**
   * Watch for a queue that is not draining. Deliberately not a fast tick: the
   * condition is defined over 30 minutes of nothing happening, so checking it
   * every five is already ten times more often than it can change.
   */
  jobs: [
    {
      id: 'operate.queue-stall',
      everyMs: 5 * 60_000,
      run: (ctx) => {
        ctx.services.get('operate').orchestrator.checkQueueStall(30 * 60_000);
      },
    },
  ],
  postActivate: (ctx) => {
    const op = ctx.services.get('operate');
    op.orchestrator.resumePersistedQueue();
    // Re-expose the public webhook URL if the user had the tunnel enabled.
    op.webhookTunnel.restore();
  },
  onDisable: async (ctx) => {
    const op = ctx.services.get('operate');
    // Shut down FIRST, while the scope resolver is still registered: shutdown
    // stops live runs and broadcasts their final run.changed, and those must
    // stay visibility-scoped (a private run's record must not fan out to every
    // socket). Only then remove the resolver.
    await op.orchestrator.shutdown();
    ctx.ws.unregisterScopeResolver('operate');
    offConfigChanged?.();
    offConfigChanged = null;
    op.webhookTunnel.close();
  },
});
