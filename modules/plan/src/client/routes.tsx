import { defineClientRoutes, page } from '@companion/core/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/proposals' },
    permission: 'proposals:read',
    component: page(() => import('./pages/Proposals.js').then((m) => m.ProposalsPage)),
  },
  {
    match: { prefix: '/specs' },
    permission: 'specs:read',
    component: page(() => import('./pages/Specs.js').then((m) => m.SpecsPage)),
  },
  {
    match: { prefix: '/docs' },
    permission: 'docs:read',
    component: page(() => import('./pages/Docs.js').then((m) => m.DocsPage)),
  },
]);
