import { defineClientRoutes, page, lazyView, type RouteProps } from '@companion/core/client';

export const routes = defineClientRoutes([
  {
    match: { regex: /^\/runs\/([A-Za-z0-9_-]+)$/, params: (m) => ({ runId: m[1]! }) },
    permission: 'runs:read',
    // Legacy App.tsx remounted the detail page on run switch (key={runId}) so
    // transcript state never bleeds between runs — the wrapper keeps that.
    component: lazyView(async () => {
      const { RunDetail } = await import('./pages/RunDetail.js');
      return {
        default: ({ params }: RouteProps): JSX.Element => <RunDetail key={params.runId} runId={params.runId!} />,
      };
    }),
  },
  {
    match: { prefix: '/runners' },
    permission: 'runners:manage',
    component: page(() => import('./pages/Runners.js').then((m) => m.RunnersPage)),
  },
  {
    match: { prefix: '/runs' },
    permission: 'runs:read',
    component: page(() => import('./pages/RunsPage.js').then((m) => m.RunsPage)),
  },
  {
    match: { prefix: '/skills' },
    permission: 'skills:manage',
    component: page(() => import('./pages/Skills.js').then((m) => m.SkillsPage)),
  },
  {
    match: { prefix: '/providers' },
    permission: 'settings:manage',
    component: page(() => import('./pages/Providers.js').then((m) => m.ProvidersPage)),
  },
]);
