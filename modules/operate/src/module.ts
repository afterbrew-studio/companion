import { defineManifest } from '@companion/core';

/**
 * module-operate — the execution plane: agent runs + the run queue, runner
 * machines (local/remote), the moxxy gateway surface, and skills. Its `/exec`
 * entry exports the pure execution primitives the published companion-runner
 * CLI bundles (no store, no kernel, no sqlite).
 */
export default defineManifest({
  id: 'operate',
  title: 'Operate',
  version: '0.1.0',
  dependsOn: ['workspace', 'core'],
  permissions: ['runs:read', 'runs:act', 'runners:manage', 'skills:manage'],
  messages: [
    'event',
    'turn',
    'ask',
    'askResolved',
    'run.changed',
    'runs.changed',
    'queue.changed',
    'runners.changed',
  ],
});
