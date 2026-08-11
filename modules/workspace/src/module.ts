import { defineManifest } from '@moxxy/companion-sdk';

export default defineManifest({
  id: 'workspace',
  title: 'Workspace',
  version: '0.1.0',
  required: true,
  dependsOn: ['core'],
  permissions: ['workspaces:read', 'workspaces:create', 'workspaces:manage', 'reports:read'],
  messages: ['workspaces.changed', 'notifications.changed', 'reports.changed'],
  config: [
    {
      key: 'reportRetentionDays',
      label: 'Report retention',
      kind: 'number',
      description:
        'Days to keep generated reports (digests, stale sweeps, CI analyses, briefings). Nothing else deletes them, so this is the only bound the table has.',
      default: 365,
      min: 7,
      max: 3650,
    },
  ],
});
