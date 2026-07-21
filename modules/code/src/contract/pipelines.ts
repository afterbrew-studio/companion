/**
 * User-defined pipelines. A pipeline has a TYPE that decides what it runs
 * against and which steps it may contain:
 *  - 'pr'       → a pull request (CI gate, AI review, agents, labels, comments)
 *  - 'issue'    → an issue (agents, labels, comments)
 *  - 'platform' → the repo itself, no issue/PR payload (agent steps only)
 * Each step kind has its own config shape (discriminated union) and a matching
 * server-side handler; adding a step kind = one union member + one handler.
 */

export type PipelineType = 'pr' | 'issue' | 'platform';

export type PipelineStepKind = 'checks-gate' | 'ai-review' | 'agent' | 'label' | 'comment' | 'slop-check';

/** Which step kinds each pipeline type may contain (payload-driven). */
export const PIPELINE_TYPE_STEPS: Record<PipelineType, readonly PipelineStepKind[]> = {
  pr: ['checks-gate', 'ai-review', 'agent', 'label', 'comment', 'slop-check'],
  issue: ['agent', 'label', 'comment'],
  platform: ['agent'],
};

/** What to do with the rest of the pipeline when this step fails. */
export type StepFailureMode = 'halt' | 'continue';

interface BaseStep {
  /** Display name; defaults to the kind's label in the UI. */
  readonly name: string;
  readonly onFailure: StepFailureMode;
}

/** Gate on the PR's CI pipelines (GitHub checks + statuses). */
export interface ChecksGateStep extends BaseStep {
  readonly kind: 'checks-gate';
  readonly config: {
    /** Treat still-running checks as acceptable instead of failing the gate. */
    readonly allowPending: boolean;
  };
}

/** Run the built-in AI code review against the PR diff. */
export interface AiReviewStep extends BaseStep {
  readonly kind: 'ai-review';
  readonly config: {
    /** Post the review to GitHub when it completes. */
    readonly post: boolean;
    /** When the step itself counts as failed. */
    readonly failOn: 'request_changes' | 'high_risk' | 'never';
  };
}

/** Custom agent step: your prompt, the PR context, a pass/fail verdict. */
export interface AgentStep extends BaseStep {
  readonly kind: 'agent';
  readonly config: {
    readonly prompt: string;
  };
}

/** Add labels to the PR. */
export interface LabelStep extends BaseStep {
  readonly kind: 'label';
  readonly config: {
    readonly labels: ReadonlyArray<string>;
  };
}

/** Post a comment on the PR. Supports {{pr.number}} / {{pr.title}} / {{pr.author}}. */
export interface CommentStep extends BaseStep {
  readonly kind: 'comment';
  readonly config: {
    readonly body: string;
  };
}

/** Gate on AI-slop detection (module-slop, resolved softly at run time). */
export interface SlopCheckStep extends BaseStep {
  readonly kind: 'slop-check';
  readonly config: {
    /** Fail when the verdict's aiLikelihood reaches this (0–100). */
    readonly threshold: number;
  };
}

export type PipelineStep = ChecksGateStep | AiReviewStep | AgentStep | LabelStep | CommentStep | SlopCheckStep;

// ---------- step library (custom reusable steps) -----------------------------------

/**
 * A custom step: a named, workspace-scoped step saved to the library so any
 * pipeline can include it by reference. Editing the definition updates every
 * pipeline that references it; runs snapshot the resolved step, so history
 * stays stable.
 */
export interface StepDefinitionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  /** The underlying executable step (kind + config + default failure mode). */
  readonly step: PipelineStep;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * What a pipeline is composed of: steps written inline, or references into
 * the step library (with optional per-pipeline overrides).
 */
export type PipelineStepSpec =
  | { readonly type: 'inline'; readonly step: PipelineStep }
  | {
      readonly type: 'ref';
      readonly stepDefinitionId: string;
      readonly overrides?: {
        readonly name?: string;
        readonly onFailure?: StepFailureMode;
      };
    };

export interface PipelineRecord {
  readonly id: string;
  readonly workspaceId: string;
  /** What this pipeline runs against; constrains its steps. */
  readonly type: PipelineType;
  readonly name: string;
  readonly description: string;
  readonly steps: ReadonlyArray<PipelineStepSpec>;
  /**
   * Auto-run on the type's opening event (PR opened / issue opened, via
   * webhook). Always false for platform pipelines.
   */
  readonly autoRunOnPrOpen: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------- execution ------------------------------------------------------------

export type PipelineRunStatus = 'running' | 'passed' | 'failed' | 'error';

export type StepResultStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';

export interface PipelineStepResult {
  readonly name: string;
  /** 'unknown' when a library reference could not be resolved. */
  readonly kind: PipelineStepKind | 'unknown';
  readonly status: StepResultStatus;
  readonly summary: string | null;
  /** Longer output (agent verdict detail, review body, …). */
  readonly detail: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export type PipelineTrigger = 'manual' | 'pr-opened' | 'issue-opened';

export interface PipelineRunRecord {
  readonly id: string;
  readonly pipelineId: string;
  /** Denormalized so history survives pipeline deletion. */
  readonly pipelineName: string;
  /** What the run targeted (copied from the pipeline's type at start). */
  readonly target: PipelineType;
  readonly repo: string;
  /** Target number: PR or issue number; 0 for platform runs. */
  readonly prNumber: number;
  readonly status: PipelineRunStatus;
  readonly trigger: PipelineTrigger;
  readonly steps: ReadonlyArray<PipelineStepResult>;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

// ---------- DTOs -------------------------------------------------------------------

export interface SavePipelineRequest {
  readonly type?: PipelineType;
  readonly name: string;
  readonly description?: string;
  readonly steps: ReadonlyArray<PipelineStepSpec>;
  readonly autoRunOnPrOpen?: boolean;
}

export interface SaveStepDefinitionRequest {
  readonly name: string;
  readonly description?: string;
  readonly step: PipelineStep;
}
