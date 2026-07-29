import { defineClientRoutes, page, lazyView, type RouteProps } from '@moxxy/companion-core/client';

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
    // Must precede the /runners prefix match, like /runs/:id above.
    match: { regex: /^\/runners\/([A-Za-z0-9_-]+)$/, params: (m) => ({ id: m[1]! }) },
    permission: 'runners:connect',
    component: lazyView(async () => {
      const { RunnerSettingsPage } = await import('./pages/RunnerSettings.js');
      return {
        default: ({ params }: RouteProps): JSX.Element => <RunnerSettingsPage key={params.id} id={params.id!} />,
      };
    }),
  },
  {
    match: { prefix: '/runners' },
    permission: 'runners:connect',
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
  {
    match: { prefix: '/spend' },
    permission: 'settings:manage',
    component: page(() => import('./pages/Spend.js').then((m) => m.SpendPage)),
  },
  {
    match: { prefix: '/task-models' },
    permission: 'settings:manage',
    component: page(() => import('./pages/TaskModels.js').then((m) => m.TaskModelsPage)),
  },
]);
