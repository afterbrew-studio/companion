import { defineClientRoutes, page } from '@companion/core/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/users' },
    permission: 'users:manage',
    component: page(() => import('./pages/Users.js').then((m) => m.UsersPage)),
  },
  // Every signed-in user may edit their own profile — no permission gate.
  {
    match: { prefix: '/profile' },
    component: page(() => import('./pages/Profile.js').then((m) => m.ProfilePage)),
  },
  {
    match: { prefix: '/modules' },
    permission: 'settings:manage',
    component: page(() => import('./pages/Modules.js').then((m) => m.ModulesPage)),
  },
]);
