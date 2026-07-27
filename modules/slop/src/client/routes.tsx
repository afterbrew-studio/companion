import { defineClientRoutes, lazyView } from '@moxxy-ai/companion-sdk/client';

export const routes = defineClientRoutes([
  {
    // Exact beats regex in the matcher, so /slop/rules never lands here.
    match: { regex: /^\/slop\/([A-Za-z0-9_-]+)$/, params: (m) => ({ id: m[1]! }) },
    permission: 'slop:read',
    component: lazyView(() => import('./pages/SlopDetection.js')),
  },
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
