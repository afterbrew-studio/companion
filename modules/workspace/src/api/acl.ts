import { defineAcl } from '@moxxy-ai/companion-sdk/server';
import '../contract/index.js';

/** Admin has management capabilities, but workspace visibility still follows membership. */
export default defineAcl({
  permissions: [
    { id: 'workspaces:read', title: 'View workspaces' },
    { id: 'workspaces:create', title: 'Create private workspaces' },
    { id: 'workspaces:manage', title: 'Manage accessible workspaces' },
    { id: 'reports:read', title: 'View digests and reports' },
  ],
  grants: {
    admin: '*',
    maintainer: ['workspaces:read', 'workspaces:create', 'reports:read'],
    business: ['workspaces:read'],
  },
});
