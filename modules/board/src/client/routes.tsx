import { defineClientRoutes, lazyView } from '@moxxy-ai/companion-sdk/client';

export const routes = defineClientRoutes([
  { match: { exact: '/board' }, permission: 'board:read', component: lazyView(() => import('./pages/Board.js')) },
]);
