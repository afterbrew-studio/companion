import { defineAcl } from '@companion/core/server';
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
  ],
  grants: {
    admin: '*',
  },
});
