import { defineManifest } from '@moxxy/companion-sdk';

/**
 * The platform seam for third-party capabilities. This module owns connection
 * metadata, secret references, health and routing; provider modules keep their
 * domain data and register executable adapters while enabled.
 */
export default defineManifest({
  id: 'integrations',
  title: 'Integrations',
  version: '0.1.0',
  dependsOn: ['core', 'workspace'],
  permissions: ['integrations:read', 'integrations:manage', 'integrations:use', 'integrations:self'],
  messages: ['integrations.changed'],
});
