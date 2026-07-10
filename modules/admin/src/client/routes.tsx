import { lazy, type ComponentType } from 'react';
import { defineClientRoutes, type RouteProps } from '@companion/core/client';

/** React.lazy over a named page export, widened to the RouteProps contract. */
const page = (load: () => Promise<ComponentType<RouteProps>>): ComponentType<RouteProps> =>
  lazy(async () => ({ default: await load() }));

export const routes = defineClientRoutes([
  {
    match: { prefix: '/settings' },
    permission: 'settings:manage',
    component: page(() => import('./pages/Settings.js').then((m) => m.SettingsPage)),
  },
]);
