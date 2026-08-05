import { defineManifest } from '@moxxy/companion-sdk';

/**
 * module-workbench — the human-facing composition layer. Today turns several
 * domain-specific review queues into one ordered list without becoming the
 * owner of any of their data or actions.
 */
export default defineManifest({
  id: 'workbench',
  title: 'Today',
  version: '0.1.0',
  dependsOn: ['core', 'workspace', 'operate', 'code'],
  permissions: ['workbench:read'],
  messages: ['workbench.actions.changed'],
  // Board is optional at runtime. When it is disabled, Today remains useful
  // for run, pull-request and issue decisions.
  consumes: [
    'runs:read',
    'runs:act',
    'prs:read',
    'prs:act',
    'issues:read',
    'issues:act',
    'board:read',
    'board:manage',
    'specs:read',
    'specs:manage',
    'docs:read',
    'docs:manage',
  ],
});
