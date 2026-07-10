import { defineAcl } from '@companion/core/server';
import '../contract/index.js';

/**
 * Mirrors today's ROLE_PERMISSIONS for the automations domain: admin holds
 * all; maintainer configures automations and webhooks day-to-day; business
 * does not. (AI Help routes are 'any' — every signed-in role gets an
 * assistant — so no permission guards them.)
 */
export default defineAcl({
  permissions: [{ id: 'automations:manage', title: 'Configure automations and webhooks' }],
  grants: {
    admin: '*',
    maintainer: ['automations:manage'],
  },
});
