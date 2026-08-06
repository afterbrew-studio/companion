import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'workbench:read', title: 'View the unified decision queue' },
  ],
  grants: {
    admin: '*',
    maintainer: ['workbench:read'],
    business: ['workbench:read'],
  },
});
