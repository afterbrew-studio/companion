import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'board:read', title: 'View the task board' },
    { id: 'board:manage', title: 'Manage tasks, workers and board settings' },
  ],
  grants: {
    admin: '*',
    maintainer: ['board:read', 'board:manage'],
    business: ['board:read'],
  },
});
