import { defineJobs } from '@moxxy/companion-sdk/server';
import type { RunStatus } from '@companion/module-operate/contract';
import { ProposalsStore } from './proposals-store.js';
import { SpecsStore } from './specs-store.js';

/** Run statuses that end a run without producing a PR — proposals unstick on these. */
const TERMINAL_FAIL = new Set<RunStatus>(['failed', 'stopped', 'abandoned', 'interrupted']);

let unsubscribe: (() => void) | null = null;

/**
 * The run-lifecycle seam, wired at enable time: the legacy composition root
 * kept a proposals forward-ref inside its broadcast wrapper; here the reaction
 * subscribes to operate's server-bus signal instead — an implement run
 * reaching review flips its proposal to review, and a terminal failure
 * unsticks it. Enable also replays the legacy boot sweep for work left
 * dangling by the previous daemon life.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const plan = ctx.services.get('plan');

    // Boot sweep (legacy main() lines): stores are stateless wrappers over
    // ctx.db, so fresh instances sweep exactly the rows the services own.
    const dangling = new ProposalsStore(ctx.db).resetDangling();
    if (dangling > 0) ctx.log.info(`reset ${dangling} proposal(s) stuck in 'analyzing' from previous daemon life`);
    const danglingSpecs = new SpecsStore(ctx.db).resetDangling();
    if (danglingSpecs > 0)
      ctx.log.info(`marked ${danglingSpecs} spec(s) stuck in 'generating' as failed from previous daemon life`);

    unsubscribe = ctx.bus.on('run.changed', (run) => {
      if (run.status === 'review') plan.proposals.onRunReview(run.id);
      else if (TERMINAL_FAIL.has(run.status)) plan.proposals.onRunFailed(run.id);
    });
  },
  onDisable: () => {
    unsubscribe?.();
    unsubscribe = null;
  },
});
