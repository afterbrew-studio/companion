import { defineClientRoutes, page, lazyView, type RouteProps } from '@companion/core/client';

// The digest-in-the-making loader view of a report run (regex outranks the
// /digest prefix on specificity, so ordering here doesn't matter).
const DigestLiveRoute = lazyView(async () => {
  const { DigestLivePage } = await import('./pages/DigestLive.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => <DigestLivePage key={params.repo} repo={params.repo!} />;
  return { default: Wrapped };
});

export const routes = defineClientRoutes([
  {
    match: { prefix: '/automations' },
    permission: 'automations:manage',
    component: page(() => import('./pages/Automations.js').then((m) => m.AutomationsPage)),
  },
  {
    match: { regex: /^\/digest\/([\w.-]+)\/([\w.-]+)\/live$/, params: (m) => ({ repo: `${m[1]}/${m[2]}` }) },
    permission: 'reports:read',
    component: DigestLiveRoute,
  },
  // The digest surface is automations-owned (it generates the digests); the
  // entry sits in the Workspace sidebar group and gates on reports:read.
  {
    match: { prefix: '/digest' },
    permission: 'reports:read',
    component: page(() => import('./pages/Digest.js').then((m) => m.DigestPage)),
  },
]);
