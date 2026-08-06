import { defineAcl } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'integrations:read', title: 'View integration connections and health' },
    { id: 'integrations:manage', title: 'Configure shared integration connections and routing' },
    { id: 'integrations:use', title: 'Use connected third-party capabilities' },
    { id: 'integrations:self', title: 'Configure personal integration destinations' },
  ],
  grants: {
    business: [
      'integrations:read',
      'integrations:self',
    ],
    maintainer: [
      'integrations:read',
      'integrations:use',
      'integrations:self',
    ],
    admin: [
      'integrations:read',
      'integrations:manage',
      'integrations:use',
      'integrations:self',
    ],
  },
});
