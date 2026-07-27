import { defineManifest } from '@moxxy-ai/companion-sdk';

export default defineManifest({
  id: 'planner',
  title: 'Ideas',
  version: '0.1.0',
  dependsOn: ['core', 'workspace', 'code', 'operate', 'plan', 'board', 'refinement'],
  required: false,
  autoInstall: false,
  permissions: ['planner:read', 'planner:manage', 'planner:execute'],
  messages: ['planner.changed'],
});
