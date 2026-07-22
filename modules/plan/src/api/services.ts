import { defineServices } from '@companion/core/server';
import { ProposalsStore } from './proposals-store.js';
import { SpecsStore } from './specs-store.js';
import { DocsStore } from './docs-store.js';
import { PlanStore } from './plan-store.js';
import { Proposals } from './proposals.js';
import { Specs } from './specs.js';
import { Docs } from './docs.js';
import { PlanService } from './plan-service.js';

/**
 * Construct the planning domain: the own stores (docs with the FTS5 probe
 * result), the narrow store facade over them plus code's repos/prs, and the
 * proposals/specs/docs services — then publish the bundle as `plan`. Wiring
 * mirrors the legacy composition root's construction order; the run-lifecycle
 * seam that unsticks proposals lives in onEnable (jobs.ts), not here.
 */
export default defineServices((ctx) => {
  const settings = ctx.services.get('settings');
  const operate = ctx.services.get('operate');
  const code = ctx.services.get('code');

  operate.registerRunTask({
    id: 'plan.analyses',
    label: 'Planning analyses',
    placeable: false,
    hint: 'proposal analyses, spec drafts, drift checks, documentation',
  });

  // Stores, in the legacy store/db.ts construction order.
  const proposalsStore = new ProposalsStore(ctx.db);
  const specsStore = new SpecsStore(ctx.db);
  const docsStore = new DocsStore(ctx.db, ctx.fts.available);

  const store = new PlanStore({
    proposals: proposalsStore,
    specs: specsStore,
    docs: docsStore,
    repos: code.repos,
    prs: code.prs,
    settings,
    notify: ctx.notify,
  });

  const proposals = new Proposals(store, operate.orchestrator, code.fixes, operate.checkouts, ctx.broadcast);
  const specs = new Specs(
    store,
    operate.orchestrator,
    operate.checkouts,
    proposals,
    (repo) => code.githubAccounts.clientFor('fetch', { repo }),
    ctx.broadcast,
  );
  const docs = new Docs(store, operate.orchestrator, operate.checkouts, ctx.broadcast);

  ctx.services.register('plan', new PlanService(proposals, specs, docs));
});
