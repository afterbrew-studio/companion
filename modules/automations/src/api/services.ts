import { defineServices } from '@companion/core/server';
import { AutomationsStore } from './automations-store.js';
import { Automations } from './automations.js';
import { Assistant } from './assistant.js';
import { AutomationsService } from './automations-service.js';

/**
 * Construct the reactor domain: the narrow store facade (this module owns no
 * tables — every member is another module's surface), the webhook receiver +
 * schedule ticker, and AI Help — then publish the bundle as `automations`.
 * Wiring mirrors the legacy composition root's construction order; the ticker
 * start/stop lives in onEnable/onDisable (jobs.ts), not here.
 */
export default defineServices((ctx) => {
  const settings = ctx.services.get('settings');
  const workspace = ctx.services.get('workspace');
  const reports = ctx.services.get('reports');
  const operate = ctx.services.get('operate');
  const code = ctx.services.get('code');

  operate.registerRunTask({ id: 'automations.assistant', label: 'AI Help', placeable: true });
  operate.registerRunTask({ id: 'automations.digest', label: 'Daily digests', placeable: false });
  const plan = ctx.services.get('plan');
  const core = ctx.services.get('core');

  const store = new AutomationsStore({
    db: ctx.db,
    repos: code.repos,
    issues: code.issues,
    prs: code.prs,
    runs: operate.runsStore,
    workspaces: workspace,
    reports,
    settings,
    notify: ctx.notify,
  });

  // Legacy parameter order, each dep resolved from its owner's bundle.
  const automations = new Automations(
    store,
    operate.orchestrator,
    code.triage,
    code.prReviews,
    code.prChecks,
    code.pipelines,
    code.sync,
    operate.checkouts,
    operate.webhookTunnel,
    plan.specs,
    (repo, username) => code.githubAccounts.clientFor('pipelines', { repo, username }),
    ctx.broadcast,
  );

  const assistant = new Assistant(store, operate.orchestrator, core, ctx.config);

  ctx.services.register('automations', new AutomationsService(automations, assistant));
});
