import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

/**
 * Mirrors today's ROLE_PERMISSIONS for the plan domain: admin holds all;
 * maintainer runs the whole planning board day-to-day; business files
 * proposals (and sees their analysis) plus authors the product grounding —
 * specifications and documentation — that agents work from, but never
 * approves/rejects an implementation (proposals:act stays with maintainers).
 */
export default defineAcl({
  permissions: [
    { id: 'proposals:read', title: 'View change proposals' },
    { id: 'proposals:create', title: 'File proposals and run their analysis' },
    { id: 'proposals:act', title: 'Act on proposals (approve, finish, reject)' },
    { id: 'specs:read', title: 'View specifications' },
    { id: 'specs:manage', title: 'Create and edit specifications' },
    { id: 'docs:read', title: 'View documentation' },
    { id: 'docs:manage', title: 'Create and edit documentation' },
  ],
  grants: {
    admin: '*',
    maintainer: [
      'proposals:read',
      'proposals:create',
      'proposals:act',
      'specs:read',
      'specs:manage',
      'docs:read',
      'docs:manage',
    ],
    business: ['proposals:read', 'proposals:create', 'specs:read', 'specs:manage', 'docs:read', 'docs:manage'],
  },
});
