import { defineManifest } from '@moxxy/companion-sdk';

/**
 * Optional policy over Operate's single run lifecycle. The module chooses a
 * model profile and records why; Operate still owns placement, execution,
 * budgets and run state.
 */
export default defineManifest({
  id: 'model-router',
  title: 'Model Router',
  version: '0.1.0',
  dependsOn: ['core', 'operate'],
  required: false,
  autoInstall: false,
  messages: ['model-router.changed'],
  permissions: ['model-router:read', 'model-router:manage'],
});
