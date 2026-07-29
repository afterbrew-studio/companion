import { defineManifest } from '@moxxy/companion-core';

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
      key: 'unplacedWork',
      label: 'Work no machine accepts',
      kind: 'select',
      description:
        "Where a run goes when no eligible machine's task policy accepts it. The default hands the decision to this machine's own policy, so an allow-list instance refuses visibly instead of quietly running the work here.",
      default: 'policy',
      options: [
        { value: 'policy', label: 'Run here only if this machine allows it' },
        { value: 'local', label: 'Always run here' },
        { value: 'refuse', label: 'Refuse the run' },
      ],
    },
    {
      key: 'webhookTunnel',
      label: 'Public webhook delivery',
      kind: 'boolean',
      description:
        'Expose the GitHub webhook receiver through the moxxy proxy relay — no self-managed tunnel needed. The public URL is stable across restarts.',
      default: false,
    },
    {
      key: 'worktreeRetentionDays',
      label: 'Finished worktree retention',
      kind: 'number',
      description:
        'Days to keep stopped, failed, interrupted, or completed run worktrees. Active and review runs are always protected.',
      default: 3,
      min: 1,
      max: 90,
    },
    {
      key: 'scratchRetentionHours',
      label: 'Finished scratch retention',
      kind: 'number',
      description: 'Hours to keep scratch directories after their run stops. Active runs are always protected.',
      default: 24,
      min: 1,
      max: 720,
    },
    {
      key: 'sessionRetentionDays',
      label: 'Run transcript retention',
      kind: 'number',
      description: 'Days to keep reaped moxxy session history and per-run gateway configuration.',
      default: 30,
      min: 1,
      max: 365,
    },
    {
      key: 'monthlyBudgetUsd',
      label: 'Monthly agent budget (USD)',
      kind: 'number',
      description:
        'Estimated spend this instance may reach in a calendar month before new runs are refused. 0 disables the ceiling. Estimated from provider list prices, so models with no known price do not count towards it.',
      default: 0,
      min: 0,
      max: 1_000_000,
    },
    {
      key: 'userMonthlyBudgetUsd',
      label: 'Monthly budget per person (USD)',
      kind: 'number',
      description:
        "The same ceiling applied to one profile's own runs. 0 disables it. Both ceilings apply: whichever is reached first refuses the run.",
      default: 0,
      min: 0,
      max: 1_000_000,
    },
    {
      key: 'budgetAlertPercent',
      label: 'Budget alert threshold (%)',
      kind: 'number',
      description: 'Raise an inbox notification once a ceiling is this far consumed. Announced once per month per scope.',
      default: 80,
      min: 1,
      max: 100,
    },
  ],
  permissions: ['runs:read', 'runs:act', 'runners:manage', 'runners:connect', 'skills:manage'],
  messages: [
    'event',
    'turn',
    'ask',
    'askResolved',
    'run.changed',
    'runs.changed',
    'queue.changed',
    'runners.changed',
    'task-models.changed',
  ],
});
