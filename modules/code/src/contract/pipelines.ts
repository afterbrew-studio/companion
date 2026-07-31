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

export type PipelineStepKind =
  | 'checks-gate'
  | 'ai-review'
  | 'agent'
  | 'label'
  | 'comment'
  | 'slop-check'
  | 'executable'
  | 'npm-bootstrap'
  | 'pr-state-gate'
  | 'merge'
  | 'pr-action';

/** Which step kinds each pipeline type may contain (payload-driven). */
export const PIPELINE_TYPE_STEPS: Record<PipelineType, readonly PipelineStepKind[]> = {
  pr: [
    'checks-gate',
    'ai-review',
    'agent',
    'label',
    'comment',
    'slop-check',
    'executable',
    'npm-bootstrap',
    'pr-state-gate',
    'merge',
    'pr-action',
  ],
  issue: ['agent', 'label', 'comment', 'executable'],
  platform: ['agent', 'executable', 'npm-bootstrap'],
};

/** What to do with the rest of the pipeline when this step fails. */
export type StepFailureMode = 'halt' | 'continue';

/**
 * Run this step only when an earlier step said so.
 *
 * Compares one output of a named earlier step. Deliberately not an expression
 * language: the useful cases are "did the gate find conflicts" and "did the
 * detector find packages", and a DSL here would be a second thing to learn and
 * a second thing to get wrong. Anything richer belongs in an agent step.
 *
 * A condition naming a step that has not run yet, or an output it did not
 * produce, evaluates FALSE. Skipping is the safe direction: the alternative is
 * running a repair on a PR whose state nobody established.
 */
export interface StepCondition {
  /** Name of an earlier step in the same pipeline. */
  readonly step: string;
  /** Which of its outputs to read. */
  readonly output: string;
  readonly equals?: string;
  readonly oneOf?: ReadonlyArray<string>;
  readonly not?: string;
}

interface BaseStep {
  /** Display name; defaults to the kind's label in the UI. */
  readonly name: string;
  readonly onFailure: StepFailureMode;
  /** Absent means always run. */
  readonly when?: StepCondition;
  /**
   * Hold the run here until a person confirms, then continue.
   *
   * For a step whose effect is outward-facing or expensive enough that arming
   * the pipeline is not the same as consenting to this particular one: pushing
   * an agent's conflict resolution, publishing, merging. The run stays open
   * meanwhile; a daemon restart marks it interrupted rather than resuming.
   */
  readonly requiresApproval?: boolean;
}

/** Gate on the PR's CI pipelines (GitHub checks + statuses). */
export interface ChecksGateStep extends BaseStep {
  readonly kind: 'checks-gate';
  readonly config: {
    /** Treat still-running checks as acceptable instead of failing the gate. */
    readonly allowPending: boolean;
    /**
     * Also verify, by name, every context the base branch's protection requires.
     *
     * Counting is not enough on its own. A required context missing from the
     * reported list entirely sails past a count, and a suite that was wholly
     * skipped reports zero failures, which reads as green. Both are caught here.
     */
    readonly requireProtectedContexts?: boolean;
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

/**
 * One environment variable a step sets. Visible or hidden, chosen when it is
 * added, and that choice decides where the value lives.
 *
 * **Visible** (`hidden: false`): `value` is stored in the pipeline definition,
 * goes through `{{…}}` templating, travels in an export, and is shown in an
 * import preview. For a registry URL, a flag, a value handed over from an
 * earlier step.
 *
 * **Hidden** (`hidden: true`): the value is written to the module's secret
 * store and only `secretKey` is kept here. It is never returned to a client,
 * never exported, and is redacted from command output, run history and the
 * audit trail. Setting a new value replaces it; there is no way to read one
 * back, which is the same convention as a `kind: 'secret'` config field.
 */
/**
 * Who may use a hidden variable's value.
 *
 * `private` is the default and the safe one: only runs started by the person who
 * supplied the value resolve it. `shared` opens it to the whole workspace and is
 * an explicit act of delegation, not a side effect of someone else editing the
 * pipeline. An instance-wide credential is deliberately not an option: pooling
 * every profile's publish rights into one token is exactly what a hosted
 * deployment must not do.
 */
export type StepSecretVisibility = 'private' | 'shared';

/** Ownership of a hidden variable's value. Never carries the value itself. */
export interface PipelineSecretMeta {
  readonly key: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly visibility: StepSecretVisibility;
  readonly createdAt: number;
}

export interface StepVariable {
  /** Environment variable name, e.g. `NPM_TOKEN`. */
  readonly name: string;
  readonly hidden: boolean;
  /** Hidden variables only. Defaults to `private` when a value is first set. */
  readonly visibility?: StepSecretVisibility;
  /** Hidden variables only, read-only: who supplied the stored value. */
  readonly ownerId?: string;
  /**
   * Visible variables: the stored value. Hidden variables: present ONLY on the
   * way in, when the author is setting a new value; the server moves it to the
   * secret store and never writes it back here.
   */
  readonly value?: string;
  /** Hidden variables: where the value actually lives. Instance-local, so an
   *  export drops it and an import asks for the value again. */
  readonly secretKey?: string;
}

/**
 * Run a shell command in a Companion-owned checkout. Deliberately labelled
 * unsafe in the UI, because it executes arbitrary code as the daemon user.
 *
 * Three things contain it, and all three are load-bearing: the `pipelines:execute`
 * permission (which `maintainer` does NOT hold, unlike `pipelines:manage`), the
 * instance-level `allowExecutableSteps` switch which defaults to off, and the
 * rule that a credential reaches the process only through `secrets` below.
 */
export interface ExecutableStep extends BaseStep {
  readonly kind: 'executable';
  readonly config: {
    /** Run through a shell. Supports the same `{{…}}` templating as comments. */
    readonly command: string;
    /** `pr-worktree` needs a PR target; `clone` is the repo's own checkout. */
    readonly workdir: 'pr-worktree' | 'clone';
    readonly timeoutMs: number;
    /** Environment for this step. See `StepVariable`. */
    readonly variables: ReadonlyArray<StepVariable>;
    /**
     * Extract outputs from the command's stdout+stderr. `pattern` is a regex;
     * its first capture group (or the whole match when it has none) becomes the
     * value of `name`. A pattern that does not match yields no output at all,
     * rather than an empty string that would read as a real answer.
     */
    readonly capture?: ReadonlyArray<{ readonly name: string; readonly pattern: string }>;
    /** Exit codes that still count as passed. Empty or absent means only 0. */
    readonly allowExitCodes?: ReadonlyArray<number>;
  };
}

/**
 * Publish any package this branch adds that the registry does not have yet, and
 * register the repository as its trusted publisher.
 *
 * Its own kind rather than a pair of executable steps, because the ordering and
 * the cross-checks are the whole point and belong in code that cannot be edited
 * away in a config field: publishing is irreversible (npm versions are immutable),
 * and a publish that succeeds while the trust registration fails is the worst
 * state to merge in, since the package now exists so detection goes quiet while
 * CI still cannot release it.
 */
export interface NpmBootstrapStep extends BaseStep {
  readonly kind: 'npm-bootstrap';
  readonly config: {
    /** Prints which packages the registry is missing. Run with NO credential. */
    readonly detectCommand: string;
    /**
     * Regex matching the heading that opens the "needs bootstrap" section. The
     * section runs to the next heading, and `packagePattern` is applied only
     * inside it. Without this the package pattern would also match the
     * already-published list and quietly ask for republishing.
     */
    readonly sectionPattern?: string;
    /** Regex matching one package spec in that output; group 1 is the spec. */
    readonly packagePattern: string;
    /**
     * Regex whose group 1 is the count the detector itself declares. Parsed
     * separately and compared, so a wording change in the detector surfaces as
     * a refusal instead of silently reading as "nothing to publish".
     */
    readonly countPattern: string;
    /**
     * The npm credential, as a hidden variable owned by whoever supplied it.
     * Deliberately NOT a module config key: that would be one token per
     * instance, which on a hosted deployment pools every profile's publish
     * rights into a single credential nobody is accountable for.
     */
    readonly token: StepVariable;
    /** Workflow FILENAME for `npm trust` (not a path); part of npm's identity. */
    readonly workflowFile: string;
    /** Detect and verify, publish nothing. */
    readonly dryRun: boolean;
    readonly timeoutMs: number;
  };
}

/**
 * Gate on the PR being in a mergeable state, with the branch-protection context
 * that decides whether `behind` actually blocks.
 */
export interface PrStateGateStep extends BaseStep {
  readonly kind: 'pr-state-gate';
  readonly config: {
    /** Fail when the PR is still a draft. */
    readonly requireReady: boolean;
    /** Fail unless a human approved on GitHub. */
    readonly requireApproved: boolean;
    /**
     * Fail when the branch is behind its base AND the base requires up-to-date
     * branches. When the base is not strict, `behind` is cosmetic and passes.
     */
    readonly requireUpToDate: boolean;
  };
}

/**
 * Merge the pull request. Last step by construction: it is irreversible and
 * every gate above it exists to decide whether this runs.
 */
export interface MergeStep extends BaseStep {
  readonly kind: 'merge';
  readonly config: {
    readonly method: 'merge' | 'squash' | 'rebase';
    readonly deleteBranch: boolean;
    /**
     * Refuse when the head moved after the run started. Approving a run is
     * approving a specific commit, not a pull request number, and a head that
     * advanced mid-run was never seen by the gates above.
     */
    readonly requirePinnedHead: boolean;
  };
}

/**
 * Perform one of the maintainer actions the PR page offers, as a pipeline step.
 *
 * Its whole point is composition with `when`: "if the state gate found
 * conflicts, run the conflict resolver" needs no new machinery once both exist,
 * and the action vocabulary stays the single one the UI, the gates' remedies
 * and the bulk bar already share.
 */
export interface PrActionStep extends BaseStep {
  readonly kind: 'pr-action';
  readonly config: {
    readonly action: PrActionId;
  };
}

export type PipelineStep =
  | ChecksGateStep
  | PrActionStep
  | AiReviewStep
  | AgentStep
  | LabelStep
  | CommentStep
  | SlopCheckStep
  | ExecutableStep
  | NpmBootstrapStep
  | PrStateGateStep
  | MergeStep;

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

export type StepResultStatus =
  | 'pending'
  | 'running'
  /** Held at a confirmation gate, waiting for a person. */
  | 'awaiting'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'error';

export interface PipelineStepResult {
  readonly name: string;
  /** 'unknown' when a library reference could not be resolved. */
  readonly kind: PipelineStepKind | 'unknown';
  readonly status: StepResultStatus;
  readonly summary: string | null;
  /** Longer output (agent verdict detail, review body, …). */
  readonly detail: string | null;
  /**
   * Named values this step exported for later steps to interpolate as
   * `{{steps.<name>.outputs.<key>}}`. Persisted with the run, so it is visible
   * in history: a secret must never be put here.
   */
  readonly outputs?: Readonly<Record<string, string>>;
  /** Offered when this step failed and something can be done about it. */
  readonly remedies?: ReadonlyArray<StepRemedy>;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

/**
 * An action a maintainer can take on a pull request. One vocabulary, used in
 * three places: the PR page's own buttons, the fix a failed gate suggests, and
 * the operations offered over a selection. Three separate lists would drift.
 */
export type PrActionId =
  | 'pr.rerun-failed'
  | 'pr.rerun-all'
  | 'pr.mark-ready'
  | 'pr.update-branch'
  | 'pr.fix-checks'
  | 'pr.analyze-checks'
  | 'pr.resolve-conflicts'
  | 'pr.address-reviews';

/**
 * What to do about a step that just failed, decided at run time from what the
 * step actually found rather than from a static list per kind. A draft PR and a
 * stale one both fail the same gate and need different buttons.
 */
export interface StepRemedy {
  readonly action: PrActionId;
  readonly label: string;
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

// ---------- export / import ---------------------------------------------------------

/** Bump when the envelope's shape changes incompatibly. */
export const PIPELINE_EXPORT_VERSION = 1;

/**
 * A pipeline as a portable document. Library references are resolved to inline
 * steps on the way out, because a step-definition id means nothing on another
 * instance: an export that carried them would import as a pipeline of dangling
 * references.
 */
export interface PipelineExport {
  readonly version: number;
  readonly exportedAt: number;
  readonly pipeline: {
    readonly type: PipelineType;
    readonly name: string;
    readonly description: string;
    readonly steps: ReadonlyArray<PipelineStep>;
    readonly autoRunOnPrOpen: boolean;
  };
}

/** One step in an import that will run commands, listed before anything is saved. */
export interface ImportedExecutableStep {
  readonly name: string;
  readonly kind: PipelineStepKind;
  /** The command, or the detection command for an npm bootstrap. */
  readonly command: string;
  /** Config keys the step will read secrets from. Never values. */
  readonly secretKeys: ReadonlyArray<string>;
}

/**
 * What an import WOULD do, computed without writing anything. The point is the
 * executable list: importing a pipeline is not running it, so this does not
 * refuse them, it shows them.
 */
export interface ImportPreview {
  readonly name: string;
  readonly type: PipelineType;
  readonly description: string;
  readonly stepCount: number;
  readonly executables: ReadonlyArray<ImportedExecutableStep>;
  /** Secret config keys the pipeline expects to exist here. */
  readonly requiredSecrets: ReadonlyArray<string>;
}

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
