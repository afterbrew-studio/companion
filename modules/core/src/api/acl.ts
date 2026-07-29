import { defineAcl } from '@moxxy/companion-core/server';
import '../contract/index.js';

/**
 * The capabilities module-core owns and how roles get them. Folded into the
 * live effective grid at boot; disabling this module (it can't — it's required)
 * would remove them. `'*'` grants every permission this module declares.
 */
export default defineAcl({
  permissions: [
    { id: 'users:manage', title: 'Create and manage user accounts' },
    { id: 'settings:manage', title: 'Manage instance settings' },
    { id: 'modules:manage', title: 'Install, enable and configure modules' },
    // Separate from modules:manage on purpose: that one moves switches on code
    // this instance already has, this one puts new code on the host and takes it
    // away again, and restarts the daemon to load it.
    { id: 'modules:deploy', title: 'Add and remove out-of-tree module code on this host' },
    { id: 'audit:read', title: 'Read and export the audit trail' },
  ],
  grants: {
    admin: '*',
  },
});
