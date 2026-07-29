import type { PipelineStepSpec } from './pipelines.js';
import type { PresetStepShorthand, RepoPreset, RepoPresetId } from './index.js';

/**
 * Starting points for a newly connected repository.
 *
 * The switches and the pipeline engine are both good; what was missing was an
 * answer to "I just added a repo, now what". Every automation was off by default
 * and slop detection needed a pipeline assembled by hand, so the most valuable
 * parts of the product were reachable only by someone who already knew the model.
 *
 * A preset is data, not code: adding one is an entry here. It only ever WRITES a
 * configuration a person could have written themselves, so nothing here is
 * privileged and everything stays editable afterwards.
 */
export const REPO_PRESETS: readonly RepoPreset[] = [
  {
    id: 'oss',
    label: 'Open-source project',
    description:
      'Screen incoming pull requests for low-oversight AI output, triage new issues, and get a daily digest. Nothing is posted to GitHub without you.',
    automation: { autoTriage: true, digest: true, staleSweep: true, prGate: false, autoMerge: false },
    pipeline: {
      name: 'Incoming pull request',
      description: 'Slop screen plus an AI review, both landing in Companion for a maintainer to act on.',
      autoRunOnPrOpen: true,
      steps: [
        // Cheapest signal first: a throwaway PR should not spend a review.
        { kind: 'slop-check', threshold: 70 },
        // post:false is the point for a public repo. An AI review appearing under
        // your name on a stranger's first contribution is a reputational act, so
        // the verdict lands here and a human decides whether to publish it.
        { kind: 'ai-review', post: false, failOn: 'never' },
      ],
    },
  },
  {
    id: 'internal',
    label: 'Internal service',
    description:
      'Gate pull requests on CI and an AI review, triage new issues, and auto-merge what is green and approved.',
    automation: { autoTriage: true, digest: true, staleSweep: false, prGate: true, autoMerge: true },
    pipeline: {
      name: 'Merge gate',
      description: 'CI must be green and the AI review must not be asking for changes.',
      autoRunOnPrOpen: true,
      steps: [
        { kind: 'checks-gate', allowPending: false },
        { kind: 'ai-review', post: true, failOn: 'request_changes' },
      ],
    },
  },
  {
    id: 'watch',
    label: 'Watch only',
    description: 'Sync issues and pull requests, run nothing automatically. Everything stays manual.',
    automation: { autoTriage: false, digest: false, staleSweep: false, prGate: false, autoMerge: false },
    pipeline: null,
  },
];

export function findPreset(id: RepoPresetId): RepoPreset | undefined {
  return REPO_PRESETS.find((p) => p.id === id);
}

/**
 * Turn a preset's steps into pipeline specs, dropping any whose module is not
 * enabled here.
 *
 * A preset naming `slop-check` on an instance without module-slop must not fail
 * and must not create a pipeline whose first step errors on every run. Dropping
 * it silently would be worse, so the caller reports what was skipped.
 */
export function resolveSteps(
  preset: RepoPreset,
  isEnabled: (moduleId: string) => boolean,
): { steps: PipelineStepSpec[]; skipped: string[] } {
  const steps: PipelineStepSpec[] = [];
  const skipped: string[] = [];
  for (const step of preset.pipeline?.steps ?? []) {
    if (step.kind === 'slop-check' && !isEnabled('slop')) {
      skipped.push('slop-check');
      continue;
    }
    steps.push(toSpec(step));
  }
  return { steps, skipped };
}

/** Preset step shorthand to the engine's inline spec shape. */
function toSpec(step: PresetStepShorthand): PipelineStepSpec {
  switch (step.kind) {
    case 'slop-check':
      return {
        type: 'inline',
        step: { kind: 'slop-check', name: 'Slop screen', onFailure: 'halt', config: { threshold: step.threshold } },
      };
    case 'ai-review':
      return {
        type: 'inline',
        step: {
          kind: 'ai-review',
          name: 'AI review',
          onFailure: 'continue',
          config: { post: step.post, failOn: step.failOn },
        },
      };
    case 'checks-gate':
      return {
        type: 'inline',
        step: {
          kind: 'checks-gate',
          name: 'CI checks',
          onFailure: 'halt',
          config: { allowPending: step.allowPending },
        },
      };
  }
}
