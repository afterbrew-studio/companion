import { defineClientRoutes, page } from '@companion/core/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/settings' },
    permission: 'settings:manage',
    component: page(() => import('./pages/Settings.js').then((m) => m.SettingsPage)),
  },
]);
