import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'planner:read', title: 'View feature planning sessions' },
    { id: 'planner:manage', title: 'Create ideas and review planning results' },
    { id: 'planner:execute', title: 'Create tasks and start agent work from an approved idea' },
  ],
  grants: {
    admin: '*',
    maintainer: ['planner:read', 'planner:manage', 'planner:execute'],
    business: ['planner:read', 'planner:manage', 'planner:execute'],
  },
});
