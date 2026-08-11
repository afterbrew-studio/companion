import { defineJobs } from '@moxxy/companion-sdk/server';

const DAY_MS = 24 * 60 * 60_000;

/**
 * module-workspace's lifecycle: the report retention sweep. Notifications
 * bound themselves on insert (NotificationsStore); reports had no bound at
 * all, so the table grew with every digest and analysis forever.
 */
export default defineJobs({
  jobs: [
    {
      id: 'workspace.reports.prune',
      everyMs: DAY_MS,
      run: (ctx) => {
        const raw = Number(ctx.moduleConfig.get('reportRetentionDays') ?? 365);
        const days = Number.isFinite(raw) && raw > 0 ? raw : 365;
        const removed = ctx.services.get('reports').prune(days * DAY_MS);
        if (removed > 0) ctx.log.info(`reports: pruned ${removed} entries older than ${days} days`);
      },
    },
  ],
});
