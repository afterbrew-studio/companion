import { defineClientRoutes, lazyView } from '@moxxy/companion-sdk/client';

const DetectionPage = lazyView(() => import('./pages/SlopDetection.js'));
const RulesPage = lazyView(() => import('./pages/SlopRules.js'));
const QueuePage = lazyView(() => import('./pages/Slop.js'));

export const routes = defineClientRoutes([
  {
    // Exact beats regex in the matcher, so /contribution-quality/rules never lands here.
    match: { regex: /^\/contribution-quality\/([A-Za-z0-9_-]+)$/, params: (m) => ({ id: m[1]! }) },
    permission: 'slop:read',
    component: DetectionPage,
  },
  {
    match: { exact: '/contribution-quality/rules' },
    permission: 'slop:read',
    component: RulesPage,
  },
  {
    match: { exact: '/contribution-quality' },
    permission: 'slop:read',
    component: QueuePage,
  },
  // Compatibility for the module's original #/slop prefix: saved notifications,
  // bookmarks and deep links resolve to the same pages (the nav entry claims
  // these paths via `owns`).
  {
    match: { regex: /^\/slop\/([A-Za-z0-9_-]+)$/, params: (m) => ({ id: m[1]! }) },
    permission: 'slop:read',
    component: DetectionPage,
  },
  {
    match: { exact: '/slop/rules' },
    permission: 'slop:read',
    component: RulesPage,
  },
  {
    match: { exact: '/slop' },
    permission: 'slop:read',
    component: QueuePage,
  },
]);
