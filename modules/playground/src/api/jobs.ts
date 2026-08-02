import { defineJobs } from '@moxxy/companion-sdk/server';

/** Recover interrupted release gates and fence live work when disabling. */
export default defineJobs({
  onEnable: (ctx) => {
    const recovered = ctx.services.get('playground').production.recover();
    if (recovered > 0) {
      ctx.log.warn('recovered interrupted production evaluation suites', { recovered });
      ctx.broadcast({ t: 'playground.changed' });
    }
  },
  onDisable: async (ctx) => {
    await ctx.services.get('playground').production.stop();
  },
});
