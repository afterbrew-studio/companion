import type { ComponentType } from 'react';
import { RequiresRepo } from '@companion/module-code/client';
import { defineClientRoutes, lazyView, type RouteProps } from '@moxxy/companion-sdk/client';

const gated = (load: () => Promise<{ default: ComponentType<RouteProps> }>) =>
  lazyView(async () => {
    const { default: Inner } = await load();
    const Gated = (props: RouteProps): JSX.Element => (
      <RequiresRepo what="Ideas">
        <Inner {...props} />
      </RequiresRepo>
    );
    return { default: Gated };
  });

const list = gated(() => import('./pages/Ideas.js'));

export const routes = defineClientRoutes([
  {
    match: { regex: /^\/ideas\/([\w-]+)$/, params: (match) => ({ id: match[1]! }) },
    permission: 'planner:read',
    component: gated(async () => {
      const { default: Idea } = await import('./pages/Idea.js');
      return { default: ({ params }: RouteProps): JSX.Element => <Idea key={params.id} id={params.id!} /> };
    }),
  },
  { match: { exact: '/ideas' }, permission: 'planner:read', component: list },
  { match: { prefix: '/proposals' }, permission: 'planner:read', component: list },
]);
