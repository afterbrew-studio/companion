import { defineClientRoutes, page } from '@moxxy/companion-core/client';

export const routes = defineClientRoutes([
  {
    match: { prefix: '/audit' },
    permission: 'audit:read',
    component: page(() => import('./pages/Audit.js').then((m) => m.AuditPage)),
  },
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
    match: { exact: '/roles' },
    permission: 'users:manage',
    component: page(() => import('./pages/Roles.js').then((m) => m.RolesPage)),
  },
  {
    match: { prefix: '/modules' },
    permission: 'modules:manage',
    component: page(() => import('./pages/Modules.js').then((m) => m.ModulesPage)),
  },
]);
