import { defineAcl } from '@companion/core/server';
import '../contract/index.js';

/** Mirrors today's ROLE_PERMISSIONS: admin manages all; maintainer reads + creates; business reads. */
export default defineAcl({
  permissions: [
    { id: 'workspaces:read', title: 'View workspaces' },
    { id: 'workspaces:create', title: 'Create private workspaces' },
    { id: 'workspaces:manage', title: 'Manage all workspaces' },
    { id: 'reports:read', title: 'View digests and reports' },
  ],
  grants: {
    admin: '*',
    maintainer: ['workspaces:read', 'workspaces:create', 'reports:read'],
    business: ['workspaces:read'],
  },
});
