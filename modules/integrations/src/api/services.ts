import { defineServices } from '@moxxy/companion-sdk/server';
import { IntegrationsStore } from './integrations-store.js';
import { IntegrationsService } from './integrations-service.js';

export default defineServices((ctx) => {
  ctx.services.register(
    'integrations',
    new IntegrationsService(new IntegrationsStore(ctx.db), ctx.secrets, ctx.broadcast),
  );
});
