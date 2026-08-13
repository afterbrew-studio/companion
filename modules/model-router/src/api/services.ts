import { defineServices } from '@moxxy/companion-sdk/server';
import { ModelRouterService } from './model-router-service.js';
import { ModelRouterStore } from './model-router-store.js';

export default defineServices((ctx) => {
  const service = new ModelRouterService(
    new ModelRouterStore(ctx.db),
    ctx.services.get('operate'),
    () => ctx.broadcast({ t: 'model-router.changed' }),
  );
  // Materialise the default row before the provider can be enabled.
  service.policy();
  ctx.services.register('model-router', service);
});
