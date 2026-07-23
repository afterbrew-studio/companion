import { defineJobs } from '@companion/core/server';

/**
 * Replay wiring: a queued detection that was still waiting when the daemon
 * last stopped survives in operate's durable run queue; the resumer rebuilds
 * the prompt from the stored args and re-enqueues fresh. Entries wait durably
 * until this registers, so a disabled slop module never strands or drops them.
 * (No unregister API exists — matching code's resumer precedent.)
 */
/**
 * The orphan sweep must run once per process, not per enable: onEnable also
 * fires on a live re-enable, where a 'running' row may belong to an agent run
 * that is genuinely still in flight (runs live in operate and survive this
 * module's disable). Only at first activation is a 'running' row provably a
 * dead process's orphan.
 */
let swept = false;

export default defineJobs({
  onEnable: (ctx) => {
    const slop = ctx.services.get('slop');
    // Sweep BEFORE the resumer registers: a replayed detection inserts its own
    // fresh row, which must not be caught by the sweep.
    if (!swept) {
      swept = true;
      slop.recoverInterrupted();
    }
    ctx.services
      .get('operate')
      .orchestrator.registerResumer('slop-detect', (a) =>
        slop.detect(String(a.repo), Number(a.number), String(a.userId)),
      );
  },
});
