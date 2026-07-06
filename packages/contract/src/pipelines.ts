/**
 * User-defined PR pipelines. A pipeline is an ordered list of typed steps that
 * runs against a pull request — manually from the PR view, or automatically
 * when a PR opens. Each step kind has its own config shape (discriminated
 * union) and a matching server-side handler registered in the step registry,
 * so adding a step kind = one union member + one handler.
 */

export type PipelineStepKind = 'checks-gate' | 'ai-review' | 'agent' | 'label' | 'comment';

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

export type PipelineStep = ChecksGateStep | AiReviewStep | AgentStep | LabelStep | CommentStep;

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
  readonly name: string;
  readonly description: string;
  readonly steps: ReadonlyArray<PipelineStepSpec>;
  /** Run automatically when a PR opens in any repo of this workspace (webhook). */
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

export type PipelineTrigger = 'manual' | 'pr-opened';

export interface PipelineRunRecord {
  readonly id: string;
  readonly pipelineId: string;
  /** Denormalized so history survives pipeline deletion. */
  readonly pipelineName: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly status: PipelineRunStatus;
  readonly trigger: PipelineTrigger;
  readonly steps: ReadonlyArray<PipelineStepResult>;
  readonly createdAt: number;
  readonly finishedAt: number | null;
}

// ---------- DTOs -------------------------------------------------------------------

export interface SavePipelineRequest {
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
