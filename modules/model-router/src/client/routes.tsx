import { defineClientRoutes, page } from '@moxxy/companion-sdk/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/model-router' },
    permission: 'model-router:read',
    component: page(() => import('./pages/ModelRouter.js').then((module) => module.ModelRouterPage)),
  },
]);
