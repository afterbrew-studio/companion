import { defineAcl } from '@moxxy-ai/companion-sdk/server';
import '../contract/index.js';

export default defineAcl({
  permissions: [
    { id: 'slop:read', title: 'View AI slop detections and rules' },
    { id: 'slop:act', title: 'Run detections and apply/dismiss verdicts' },
    { id: 'slop:manage', title: 'Create and edit detection rules' },
  ],
  grants: {
    admin: '*',
    maintainer: ['slop:read', 'slop:act', 'slop:manage'],
    business: ['slop:read'],
  },
});
