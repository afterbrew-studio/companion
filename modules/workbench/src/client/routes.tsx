import { defineClientRoutes, lazyView } from '@moxxy/companion-sdk/client';

export const routes = defineClientRoutes([
  {
    match: { exact: '/today' },
    permission: 'workbench:read',
    component: lazyView(() => import('./pages/Today.js')),
  },
]);
