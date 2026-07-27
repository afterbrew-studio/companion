import { defineJobs } from '@moxxy-ai/companion-sdk/server';

export default defineJobs({
  onEnable: (ctx) => {
    const reset = ctx.services.get('planner').resetDangling();
    if (reset > 0) ctx.log.info(`marked ${reset} interrupted planning session(s) as retryable failures`);
  },
});
