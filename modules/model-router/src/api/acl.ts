import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

/** Policy is instance-wide. Maintainers may audit decisions; only admins can
 * change which credentials/models future automation spends against. */
export default defineAcl({
  permissions: [
    { id: 'model-router:read', title: 'View model routing policy and decisions' },
    { id: 'model-router:manage', title: "Manage model routing policy" },
  ],
  grants: {
    admin: '*',
    maintainer: ['model-router:read'],
  },
});
