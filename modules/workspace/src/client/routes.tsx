import { lazy, type ComponentType } from 'react';
import { defineClientRoutes, type RouteProps } from '@companion/core/client';

/** React.lazy over a named page export, widened to the RouteProps contract. */
const page = (load: () => Promise<ComponentType<RouteProps>>): ComponentType<RouteProps> =>
  lazy(async () => ({ default: await load() }));

export const routes = defineClientRoutes([
  {
    match: { prefix: '/digest' },
    permission: 'reports:read',
    component: page(() => import('./pages/Digest.js').then((m) => m.DigestPage)),
  },
  {
    match: { prefix: '/inbox' },
    permission: 'workspaces:read',
    component: page(() => import('./pages/Inbox.js').then((m) => m.InboxPage)),
  },
]);
