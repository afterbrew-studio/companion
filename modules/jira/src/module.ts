import { defineManifest } from '@moxxy/companion-sdk';

export default defineManifest({
  id: 'jira',
  title: 'Jira',
  version: '0.1.0',
  dependsOn: ['integrations', 'code', 'workspace'],
  autoInstall: true,
  permissions: ['jira:read', 'jira:act'],
  messages: ['jira.changed'],
});
