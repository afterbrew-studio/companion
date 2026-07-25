import { defineClientRoutes, lazyView, type RouteProps } from '@companion/core/client';

const list = lazyView(() => import('./pages/Ideas.js'));

export const routes = defineClientRoutes([
  {
    match: { regex: /^\/ideas\/([\w-]+)$/, params: (match) => ({ id: match[1]! }) },
    permission: 'planner:read',
    component: lazyView(async () => {
      const { default: Idea } = await import('./pages/Idea.js');
      return { default: ({ params }: RouteProps): JSX.Element => <Idea key={params.id} id={params.id!} /> };
    }),
  },
  { match: { exact: '/ideas' }, permission: 'planner:read', component: list },
  { match: { prefix: '/proposals' }, permission: 'planner:read', component: list },
]);
