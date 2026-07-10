import { defineManifest } from '@companion/core';

/**
 * module-plan — the planning/grounding domain: proposals (idea → analyzed →
 * implemented PR), specifications (living behavior docs that ground agent
 * work), and documentation (workspace knowledge, chunk-indexed for retrieval).
 */
export default defineManifest({
  id: 'plan',
  title: 'Plan',
  version: '0.1.0',
  dependsOn: ['code', 'operate', 'workspace', 'core'],
  permissions: [
    'proposals:read',
    'proposals:create',
    'proposals:act',
    'specs:read',
    'specs:manage',
    'docs:read',
    'docs:manage',
  ],
  messages: ['proposals.changed', 'specs.changed', 'docs.changed'],
});
