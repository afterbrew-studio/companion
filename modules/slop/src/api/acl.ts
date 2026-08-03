import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'slop:read', title: 'View contribution quality assessments and rules' },
    { id: 'slop:act', title: 'Run assessments and apply/dismiss verdicts' },
    { id: 'slop:manage', title: 'Create and edit quality rules' },
  ],
  grants: {
    admin: '*',
    maintainer: ['slop:read', 'slop:act', 'slop:manage'],
    business: ['slop:read'],
  },
});
