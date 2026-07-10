import { lazy, type ComponentType } from 'react';
import { defineClientRoutes, type RouteProps } from '@companion/core/client';

/** React.lazy over a named page export, widened to the RouteProps contract. */
const page = (load: () => Promise<ComponentType<RouteProps>>): ComponentType<RouteProps> =>
  lazy(async () => ({ default: await load() }));

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
