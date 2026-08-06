import { defineManifest } from '@moxxy/companion-core';

/**
 * module-operate — the execution plane: agent runs + the run queue, runner
 * machines (local/remote), runtime adapters, and skills. Its `/exec`
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
      key: 'webhookPublicUrl',
      label: 'Self-managed webhook URL',
      kind: 'text',
      description:
        'Optional public HTTPS base URL that forwards to companion-api (for example https://companion.example.com). HTTP is accepted only on loopback for local development. It takes precedence over the moxxy relay and keeps enterprise delivery on your own infrastructure.',
      default: '',
      max: 500,
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
      key: 'agentGitWrite',
      label: 'Agent repository access',
      kind: 'select',
      description:
        'Whether agent work may write to repositories at all. Refusing makes every agent read-only on every runner: it can still analyse, review and propose, but no clone, worktree or push receives a write credential.',
      default: 'allowed',
      options: [
        { value: 'allowed', label: 'Agents may push to branches' },
        { value: 'refused', label: 'Read-only: agents may never write' },
      ],
    },
    {
      key: 'agentGitHubWrite',
      label: 'Writing to GitHub',
      kind: 'select',
      description:
        'Whether this instance may post comments, labels, reviews and merges. "Only when asked" lets automation analyse and screen continuously while nothing appears under your GitHub identity unless a person clicks apply. Verdicts are always produced and stored either way.',
      default: 'allowed',
      options: [
        { value: 'allowed', label: 'Automation may post on its own' },
        { value: 'attended', label: 'Only when a person asks' },
        { value: 'refused', label: 'Never write to GitHub' },
      ],
    },
    {
      key: 'protectedBranches',
      label: 'Branches agents may never push to',
      kind: 'text',
      description:
        'Comma or newline separated; `*` is the only wildcard. Agent work opens pull requests from its own branches, so this is the backstop for anything that tries to push directly. Clear the field to protect nothing.',
      default: 'main, master, release/*, prod',
      max: 500,
    },
    {
      key: 'maxRunOutputTokens',
      label: 'Output token ceiling per run',
      kind: 'number',
      description:
        'A single run is aborted past this many output tokens. This is the primary runaway guard for goal-mode runs, which are otherwise uncapped upstream.',
      default: 400_000,
      min: 10_000,
      max: 10_000_000,
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
