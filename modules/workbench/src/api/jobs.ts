import { defineJobs } from '@moxxy/companion-sdk/server';

/** Never replay a proposal whose external write may have crossed a daemon restart. */
export default defineJobs({
  postActivate: (ctx) => {
    const failed = ctx.services.get('workbench').actions.recover();
    if (failed > 0) ctx.log.warn('marked interrupted Workbench actions failed', { failed });
  },
});
