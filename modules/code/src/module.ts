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
  dependsOn: ['operate', 'workspace', 'core', 'integrations'],
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
  messages: [
    'repos.changed',
    'issues.changed',
    'triage.changed',
    'prs.changed',
    'prStatus.changed',
    'pipelines.changed',
    'pipelineRuns.changed',
    'pipelineStep.output',
  ],
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
        'Executable steps require the pipelines:execute permission and a configured container image. They never run directly as the daemon user.',
    },
    {
      key: 'executableSandboxImage',
      label: 'Executable pipeline sandbox image',
      kind: 'text',
      default: '',
      max: 300,
      placeholder: 'ghcr.io/your-org/companion-pipeline-node24@sha256:…',
      description:
        'A pre-pulled, trusted OCI image containing the build tools your pipelines need. Pin a digest. Empty means executable steps fail closed even when the switch above is on.',
    },
    {
      key: 'executableSandboxNetwork',
      label: 'Executable pipeline network',
      kind: 'text',
      default: 'none',
      max: 128,
      description:
        'Defaults to no network. Publishing requires an operator-created Docker network with an egress policy; host/default bridge networks are refused.',
    },
    {
      key: 'reviewRetentionDays',
      label: 'Review history retention',
      kind: 'number',
      description:
        'Days to keep superseded AI review verdicts and their findings. The newest review per pull request is always kept, whatever its age.',
      default: 180,
      min: 7,
      max: 3650,
    },
    {
      key: 'triageRetentionDays',
      label: 'Triage history retention',
      kind: 'number',
      description:
        'Days to keep superseded triage verdicts. The newest verdict per issue is always kept, whatever its age.',
      default: 180,
      min: 7,
      max: 3650,
    },
    {
      key: 'pipelineRunRetentionDays',
      label: 'Pipeline run retention',
      kind: 'number',
      description:
        'Days to keep finished pipeline runs and their step output. The newest run per pull request or issue is always kept, whatever its age.',
      default: 180,
      min: 7,
      max: 3650,
    },
  ],
});
