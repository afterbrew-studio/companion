import { defineClientRoutes, page } from '@companion/core/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/inbox' },
    permission: 'workspaces:read',
    component: page(() => import('./pages/Inbox.js').then((m) => m.InboxPage)),
  },
]);
