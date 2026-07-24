import { defineAcl } from '@companion/core/server';
import '../contract/index.js';

/**
 * The execution plane: every role can see shared runners and connect private
 * machines (runners:connect); shared instance runners stay admin-managed
 * (runners:manage). Maintainers additionally drive runs and curate skills.
 */
export default defineAcl({
  permissions: [
    { id: 'runs:read', title: 'View agent runs' },
    { id: 'runs:act', title: 'Launch and drive agent runs' },
    { id: 'runners:manage', title: 'Manage shared runner machines' },
    { id: 'runners:connect', title: 'Connect personal runner machines' },
    { id: 'skills:manage', title: 'Manage the skill library' },
  ],
  grants: {
    admin: '*',
    maintainer: ['runs:read', 'runs:act', 'runners:connect', 'skills:manage'],
    business: ['runners:connect'],
  },
});
