import { defineClientRoutes, lazyView } from '@companion/core/client';

export const routes = defineClientRoutes([
  { match: { exact: '/board' }, permission: 'board:read', component: lazyView(() => import('./pages/Board.js')) },
]);
