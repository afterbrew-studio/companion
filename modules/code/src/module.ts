import { defineManifest } from '@moxxy/companion-sdk';
import { DEFAULT_MAX_PR_REVIEW_TOKENS } from './contract/index.js';

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
    'pipelines:execute',
    'pipelines:author-execute',
  ],
  messages: ['repos.changed', 'issues.changed', 'triage.changed', 'prs.changed', 'pipelines.changed', 'pipelineRuns.changed', 'pipelineStep.output'],
  config: [
    {
      key: 'maxPrReviewTokens',
      label: 'Token ceiling per PR review',
      kind: 'number',
      default: DEFAULT_MAX_PR_REVIEW_TOKENS,
      min: 100_000,
      max: 50_000_000,
      description:
        'Aggregate input + output tokens across every review chunk, finding verifier and summary. Work already in flight may overshoot slightly; it is stopped as soon as the ceiling is observed. Reviews also stop if their runtime cannot report usage.',
    },
    {
      key: 'allowExecutableSteps',
      label: 'Allow executable pipeline steps',
      kind: 'boolean',
      default: false,
      description:
        'Executable steps run arbitrary shell commands as the daemon user. An instance that leaves this off cannot be reached through that path at all. Turning it on also requires the pipelines:execute permission per user.',
    },
  ],
});
