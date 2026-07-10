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
  config: [
    {
      key: 'reservedRunnerSlots',
      label: 'Reserved runner slots',
      kind: 'number',
      description:
        'Runner slots kept free from attended chats so automated work (triage, review, fixes) always has room. At least one chat slot always remains.',
      default: 1,
      min: 0,
      max: 64,
    },
    {
      key: 'webhookTunnel',
      label: 'Public webhook delivery',
      kind: 'boolean',
      description:
        'Expose the GitHub webhook receiver through the moxxy proxy relay — no self-managed tunnel needed. The public URL is stable across restarts.',
      default: false,
    },
  ],
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
