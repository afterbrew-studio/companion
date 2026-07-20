import { defineManifest } from '@companion/core';

export default defineManifest({
  id: 'board',
  title: 'Task Board',
  version: '0.1.0',
  // Hard deps: tasks live on repos (code), execute as agent runs (operate),
  // and scope through workspaces. plan is a SOFT dep (spec attachment via
  // tryGet) so the board works with planning disabled.
  dependsOn: ['workspace', 'code', 'operate'],
  required: false,
  permissions: ['board:read', 'board:manage'],
  messages: ['board.changed'],
});
