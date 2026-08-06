import { defineServices } from '@moxxy/companion-sdk/server';
import { ProvidersStore } from './providers-store.js';
import { RuntimeService, type RuntimeConfig } from './runtime-service.js';

export default defineServices((ctx) => {
  const store = new ProvidersStore(ctx.db);
  const config = (): RuntimeConfig => {
    const values = ctx.moduleConfig.values();
    return {
      maxSteps: Number(values.maxSteps ?? 40),
      turnTimeoutMinutes: Number(values.turnTimeoutMinutes ?? 30),
      childMemoryMb: Number(values.childMemoryMb ?? 1024),
      commandTimeoutMinutes: Number(values.commandTimeoutMinutes ?? 10),
      approvalTimeoutMinutes: Number(values.approvalTimeoutMinutes ?? 10),
      toolOutputChars: Number(values.toolOutputChars ?? 30_000),
    };
  };
  const operate = ctx.services.get('operate');
  ctx.services.register(
    'runtime',
    new RuntimeService(store, ctx.secrets, config, () => {
      ctx.broadcast({ t: 'runtime.changed' });
      // Configuring the first credential is what turns this runtime from
      // `installed` into `ready`, and a machine that has never chosen a runtime
      // adopts it at that moment rather than at the next restart.
      void operate.runners.refreshRuntimes();
    }),
  );
  // The spend ceiling prices a run from the built-in Anthropic table, which
  // cannot know an operator's own endpoint. This is the only place that knows,
  // so it answers for the models it configured and the table stays the default.
  operate.setModelPriceResolver((model) => ctx.services.get('runtime').priceFor(model));
});
