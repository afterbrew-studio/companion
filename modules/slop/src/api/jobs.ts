import { defineJobs } from '@companion/core/server';

/**
 * Replay wiring: a queued detection that was still waiting when the daemon
 * last stopped survives in operate's durable run queue; the resumer rebuilds
 * the prompt from the stored args and re-enqueues fresh. Entries wait durably
 * until this registers, so a disabled slop module never strands or drops them.
 * (No unregister API exists — matching code's resumer precedent.)
 */
export default defineJobs({
  onEnable: (ctx) => {
    const slop = ctx.services.get('slop');
    ctx.services
      .get('operate')
      .orchestrator.registerResumer('slop-detect', (a) => slop.detect(String(a.repo), Number(a.number)));
  },
});
