import { defineManifest } from '@moxxy/companion-sdk';

export default defineManifest({
  id: 'workspace',
  title: 'Workspace',
  version: '0.1.0',
  required: true,
  dependsOn: ['core'],
  permissions: ['workspaces:read', 'workspaces:create', 'workspaces:manage', 'reports:read'],
  messages: ['workspaces.changed', 'notifications.changed', 'reports.changed'],
});
