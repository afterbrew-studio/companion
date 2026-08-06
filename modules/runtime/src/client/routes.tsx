import { defineClientRoutes, page } from '@moxxy/companion-sdk/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/model-providers' },
    permission: 'runtime:read',
    component: page(() => import('./pages/Providers.js').then((m) => m.ProvidersPage)),
  },
]);
