import { defineClientRoutes, page } from '@moxxy/companion-sdk/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/playground/evaluations' },
    permission: 'playground:run',
    component: page(() => import('./pages/Evaluations.js').then((m) => m.EvaluationsPage)),
  },
  {
    match: { prefix: '/playground/pipelines' },
    permission: 'playground:run',
    component: page(() => import('./pages/PipelineLab.js').then((m) => m.PipelineLabPage)),
  },
  {
    match: { exact: '/playground' },
    permission: 'playground:run',
    component: page(() => import('./pages/AgentLab.js').then((m) => m.AgentLabPage)),
  },
]);
