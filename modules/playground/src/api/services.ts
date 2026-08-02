import { defineServices } from '@moxxy/companion-sdk/server';
import { PlaygroundService } from './playground-service.js';

/** Registers the module-owned stores/orchestrator and its runner task label. */
export default defineServices((ctx) => {
  ctx.services.get('operate').registerRunTask({
    id: 'playground.run',
    label: 'Playground & dry-runs',
    placeable: false,
  });
  ctx.services.register('playground', new PlaygroundService(ctx.db, ctx));
});
