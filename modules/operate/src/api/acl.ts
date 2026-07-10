import { defineAcl } from '@companion/core/server';
import '../contract/index.js';

/**
 * Mirrors today's ROLE_PERMISSIONS for the execution plane: admin holds all;
 * maintainer drives runs and curates skills but never manages runner machines
 * (instance administration); business gets none of these.
 */
export default defineAcl({
  permissions: [
    { id: 'runs:read', title: 'View agent runs' },
    { id: 'runs:act', title: 'Launch and drive agent runs' },
    { id: 'runners:manage', title: 'Manage runner machines' },
    { id: 'skills:manage', title: 'Manage the skill library' },
  ],
  grants: {
    admin: '*',
    maintainer: ['runs:read', 'runs:act', 'skills:manage'],
  },
});
