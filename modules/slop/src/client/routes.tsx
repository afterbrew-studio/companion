import { defineClientRoutes, lazyView } from '@companion/core/client';

export const routes = defineClientRoutes([
  {
    match: { exact: '/slop/rules' },
    permission: 'slop:read',
    component: lazyView(() => import('./pages/SlopRules.js')),
  },
  {
    match: { exact: '/slop' },
    permission: 'slop:read',
    component: lazyView(() => import('./pages/Slop.js')),
  },
]);
