import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

/**
 * Seeing which endpoints and models an instance runs on is operational
 * awareness a maintainer needs to explain a run; adding one means handing the
 * instance a credential that spends money, which is administration.
 */
export default defineAcl({
  permissions: [
    { id: 'runtime:read', title: 'View model providers and models' },
    { id: 'runtime:manage', title: 'Configure model providers and their credentials' },
  ],
  grants: {
    admin: '*',
    maintainer: ['runtime:read'],
    business: [],
  },
});
