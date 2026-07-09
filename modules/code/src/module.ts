import { defineManifest } from '@companion/core';

/**
 * module-code — the GitHub-facing domain: repositories + the multi-account
 * registry, the issues/PRs sync cache (GitHub stays authoritative), triage,
 * AI reviews + CI checks, fixes (issue → PR), and pipelines.
 */
export default defineManifest({
  id: 'code',
  title: 'Code',
  version: '0.1.0',
  dependsOn: ['operate', 'workspace', 'core'],
  permissions: [
    'repos:read',
    'repos:manage',
    'issues:read',
    'issues:act',
    'prs:read',
    'prs:act',
    'pipelines:read',
    'pipelines:manage',
    'pipelines:run',
    'github:connect',
  ],
  messages: ['repos.changed', 'issues.changed', 'triage.changed', 'prs.changed', 'pipelines.changed', 'pipelineRuns.changed'],
});
