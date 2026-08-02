import { defineJobs } from '@moxxy/companion-sdk/server';

export default defineJobs({
  onEnable: (ctx) => {
    const planner = ctx.services.get('planner');
    const reset = planner.resetDangling();
    if (reset > 0) ctx.log.info(`marked ${reset} interrupted planning session(s) as retryable failures`);
    const compacted = planner.compactEvents();
    if (compacted > 0) ctx.log.info(`compacted ${compacted} old planning event(s)`);
  },
});
