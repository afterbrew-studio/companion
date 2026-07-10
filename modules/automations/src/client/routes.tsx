import { lazy, type ComponentType } from 'react';
import { defineClientRoutes, type RouteProps } from '@companion/core/client';

/** React.lazy over a named page export, widened to the RouteProps contract. */
const page = (load: () => Promise<ComponentType<RouteProps>>): ComponentType<RouteProps> =>
  lazy(async () => ({ default: await load() }));

export const routes = defineClientRoutes([
  {
    match: { prefix: '/automations' },
    permission: 'automations:manage',
    component: page(() => import('./pages/Automations.js').then((m) => m.AutomationsPage)),
  },
  // The digest surface is automations-owned (it generates the digests); the
  // entry sits in the Workspace sidebar group and gates on reports:read.
  {
    match: { prefix: '/digest' },
    permission: 'reports:read',
    component: page(() => import('./pages/Digest.js').then((m) => m.DigestPage)),
  },
]);
