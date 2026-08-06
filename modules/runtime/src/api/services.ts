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
      toolOutputChars: Number(values.toolOutputChars ?? 30_000),
    };
  };
  ctx.services.register(
    'runtime',
    new RuntimeService(store, ctx.secrets, config, () => ctx.broadcast({ t: 'runtime.changed' })),
  );
});
