import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'jira:read', title: 'View Jira links' },
    { id: 'jira:act', title: 'Link and update Jira tickets' },
  ],
  grants: {
    business: [
      'jira:read',
      'jira:act',
    ],
    maintainer: [
      'jira:read',
      'jira:act',
    ],
    admin: [
      'jira:read',
      'jira:act',
    ],
  },
});
