import { defineClientRoutes, page } from '@companion/core/client';

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
