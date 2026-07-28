import { defineServices } from '@moxxy/companion-sdk/server';
import { SlopStore } from './slop-store.js';
import { SlopService } from './slop-service.js';

/**
 * Construct the slop domain: the store over the detection/rule tables and the
 * service that runs the detection agent and applies verdicts. All deps are
 * hard (see the manifest) and resolved through the registry in topo order.
 * GitHub writes ride the 'pipelines' purpose, like triage and ai-review.
 */
export default defineServices((ctx) => {
  const store = new SlopStore(ctx.db);
  const code = ctx.services.get('code');
  const operate = ctx.services.get('operate');
  operate.registerRunTask({ id: 'slop.detect', label: 'Slop detection', placeable: false });
  ctx.services.register(
    'slop',
    new SlopService(
      store,
      code,
      operate.orchestrator,
      operate.checkouts,
      (c) => code.githubAccounts.clientFor('pipelines', c),
      () => ctx.services.tryGet('refinement'),
      () => {
        const label = ctx.moduleConfig.get('label');
        return typeof label === 'string' && label.trim() ? label.trim() : 'ai-slop';
      },
      ctx.broadcast,
      ctx.bus.emit.bind(ctx.bus),
    ),
  );
});
