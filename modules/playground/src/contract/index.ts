// Brings the augmentations of the modules playground resolves at runtime:
// operate + workspace (hard deps) and code (soft dep — pipeline preview only).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
import type { PipelineStep, PipelineStepKind, PipelineType, StepFailureMode } from '@companion/module-code/contract';
import type { PlaygroundService } from '../api/playground-service.js';

/**
 * module-playground contract slice — the agent test bench. One permission
 * gates the whole surface: every playground action either spawns a real
 * (read-only-fenced) agent run or inspects run/pipeline configuration.
 * Saved evaluation cases and bounded comparison history are module-owned;
 * mutations broadcast one coarse changed event. Agent transcripts continue to
 * stream through operate's run messages.
 */

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'playground:run': true;
  }
  interface ServerMessageRegistry {
    'playground.changed': Record<never, never>;
  }
  interface ServiceMap {
    playground: PlaygroundService;
  }
}

// ---------- agent playground -------------------------------------------------------

/** POST /api/playground/run — one read-only-fenced one-shot test run. */
export interface PlaygroundRunRequest {
  /** The test input / instructions for the agent. */
  readonly prompt: string;
  /** Run against this connected repo's clone; omit for a scratch directory. */
  readonly repo?: string;
  /** Preload this skill by inlining its content into the prompt. */
  readonly skill?: string;
  readonly timeoutMs?: number;
}

export interface PlaygroundRunResult {
  readonly runId: string;
  /** The final assistant message (markdown); null = the run produced none
   *  (timeout / dead gateway) — never treat that as success. */
  readonly message: string | null;
}

// ---------- saved evaluation cases ------------------------------------------------

export type PlaygroundJsonPrimitive = string | number | boolean | null;

/** Deterministic checks applied to one agent answer after the run settles. */
export interface PlaygroundEvaluationExpectation {
  /** JSON uses the same tolerant extraction boundary as production prompts. */
  readonly responseFormat: 'text' | 'json';
  /** Case-insensitive evidence which must be present in the raw answer. */
  readonly requiredPhrases: ReadonlyArray<string>;
  /** Case-insensitive unsupported or unsafe claims which must stay absent. */
  readonly forbiddenPhrases: ReadonlyArray<string>;
  /** Dot paths which must exist in the extracted JSON, regardless of value. */
  readonly requiredJsonPaths: ReadonlyArray<string>;
  /** Dot path → exact value, or an allowed set of values. */
  readonly expectedJson: Readonly<
    Record<string, PlaygroundJsonPrimitive | ReadonlyArray<PlaygroundJsonPrimitive>>
  >;
  /** null disables the corresponding deterministic resource ceiling. */
  readonly maxDurationMs: number | null;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
}

/** Authored portion shared by create/update and the stored record. */
export interface PlaygroundEvaluationCaseInput {
  readonly name: string;
  readonly description: string;
  readonly prompt: string;
  /** Repo-backed cases are shared inside that repo's workspace; null is private. */
  readonly repo: string | null;
  readonly skill: string | null;
  readonly timeoutMs: number;
  readonly tags: ReadonlyArray<string>;
  /** A failed case is presented as a rollout blocker, not a normal regression. */
  readonly safetyCritical: boolean;
  readonly expectation: PlaygroundEvaluationExpectation;
}

export interface PlaygroundEvaluationCaseRecord extends PlaygroundEvaluationCaseInput {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly ownerId: string;
  /** Optimistic-concurrency and historical-run snapshot version. */
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PlaygroundEvaluationCheck {
  readonly kind:
    | 'response'
    | 'format'
    | 'production_parser'
    | 'required_phrase'
    | 'forbidden_phrase'
    | 'json_path'
    | 'json_value'
    | 'duration'
    | 'input_tokens'
    | 'output_tokens';
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface PlaygroundEvaluationRun {
  readonly id: string;
  readonly caseId: string;
  readonly caseName: string;
  readonly caseRevision: number;
  /** Version of the server-side read-only prompt fence used for this replay. */
  readonly promptVersion: number;
  readonly runId: string | null;
  readonly status: 'passed' | 'failed' | 'error';
  readonly checks: ReadonlyArray<PlaygroundEvaluationCheck>;
  /** Bounded answer snapshot for comparisons; the transcript remains canonical. */
  readonly message: string | null;
  readonly error: string | null;
  readonly durationMs: number;
  /** null means the runtime did not report usage — never silently treated as zero. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly model: string | null;
  readonly createdAt: number;
}

export interface PlaygroundEvaluationSnapshot {
  readonly cases: ReadonlyArray<PlaygroundEvaluationCaseRecord>;
  /** Newest bounded history across the visible cases. */
  readonly runs: ReadonlyArray<PlaygroundEvaluationRun>;
}

/** Client-safe description of one immutable production regression case. */
export interface PlaygroundProductionEvaluationCase {
  readonly id: string;
  readonly adapterId: string;
  readonly adapterLabel: string;
  readonly moduleId: string;
  /** Production task whose model and lane policy the replay inherits. */
  readonly task: string;
  readonly adapterVersion: number;
  /** Hash of the exact prompt produced for this fixture right now. */
  readonly promptFingerprint: string;
  readonly revision: number;
  readonly name: string;
  readonly description: string;
  readonly tags: ReadonlyArray<string>;
  readonly safetyCritical: boolean;
  /** Consecutive current passes needed before this case turns the gate green. */
  readonly requiredPasses: number;
  readonly expectation: PlaygroundEvaluationExpectation;
}

/** Known model/lane configuration plus the runtime which actually answered. */
export interface PlaygroundProductionRunConfiguration {
  /** Hash of the pre-run fields below; setting changes stale previous passes. */
  readonly fingerprint: string;
  readonly task: string;
  readonly taskModelPin: string | null;
  readonly laneRunnerId: string | null;
  readonly laneHarness: string | null;
  readonly laneTaskModel: string | null;
  readonly laneDefaultModel: string | null;
  readonly daemonDefaultModel: string | null;
  readonly actualModel: string | null;
  readonly actualRunnerId: string | null;
  readonly actualHarness: string | null;
}

export interface PlaygroundProductionEvaluationRun {
  readonly id: string;
  readonly caseId: string;
  readonly caseName: string;
  readonly caseRevision: number;
  readonly adapterId: string;
  readonly adapterVersion: number;
  readonly promptFingerprint: string;
  readonly runId: string | null;
  readonly status: 'passed' | 'failed' | 'error' | 'cancelled';
  readonly checks: ReadonlyArray<PlaygroundEvaluationCheck>;
  /** Bounded normalized value returned by the exact production parser. */
  readonly parsedOutput: unknown;
  readonly message: string | null;
  readonly error: string | null;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly model: string | null;
  readonly configuration: PlaygroundProductionRunConfiguration;
  readonly ownerId: string;
  readonly createdAt: number;
}

export type PlaygroundRolloutCaseStatus =
  | 'passed'
  | 'failed'
  | 'error'
  | 'cancelled'
  | 'stale'
  | 'not_run'
  | 'insufficient';

export interface PlaygroundRolloutCaseResult {
  readonly caseId: string;
  readonly status: PlaygroundRolloutCaseStatus;
  readonly safetyCritical: boolean;
  readonly currentPasses: number;
  readonly requiredPasses: number;
  readonly reason: string;
  readonly latestRunId: string | null;
}

/** Server-authoritative decision; never inferred from whichever cards rendered. */
export interface PlaygroundRolloutGate {
  readonly status: 'ready' | 'blocked' | 'incomplete';
  readonly total: number;
  readonly passed: number;
  readonly blockers: number;
  readonly warnings: number;
  readonly stale: number;
  readonly notRun: number;
  readonly insufficient: number;
  readonly cases: ReadonlyArray<PlaygroundRolloutCaseResult>;
}

export interface PlaygroundProductionEvaluationSnapshot {
  /** Immutable, version-controlled cases which exercise exact production seams. */
  readonly cases: ReadonlyArray<PlaygroundProductionEvaluationCase>;
  /** Private-to-viewer replay history for the production corpus. */
  readonly runs: ReadonlyArray<PlaygroundProductionEvaluationRun>;
  /** Current prompt/case/config-aware release decision. */
  readonly rolloutGate: PlaygroundRolloutGate;
  /** In-flight work owned by the viewer; refreshed through playground.changed. */
  readonly active: ReadonlyArray<PlaygroundProductionActiveRun>;
  /** Recent durable release-gate executions for the viewer. */
  readonly suites: ReadonlyArray<PlaygroundProductionEvaluationSuite>;
}

export interface PlaygroundProductionActiveRun {
  readonly caseId: string;
  readonly phase: 'queued' | 'running' | 'evaluating';
  readonly queueId: string | null;
  readonly runId: string | null;
  readonly startedAt: number;
}

/** Durable aggregate resource guard for one production release-gate suite. */
export interface PlaygroundProductionSuiteBudget {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly maxTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Runs with at least one usable cumulative provider-usage snapshot. */
  readonly reportedRuns: number;
  /** Settled runs whose runtime could not provide usable token telemetry. */
  readonly missingRuns: number;
  /** Operate-owned list-price estimate; not presented as an exact provider bill. */
  readonly estimatedCostUsd: number;
  readonly costPartial: boolean;
}

export interface PlaygroundProductionEvaluationSuite {
  readonly id: string;
  readonly ownerId: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly total: number;
  readonly completed: number;
  readonly currentCaseId: string | null;
  readonly currentCaseName: string | null;
  /** Exact execution plan; safety-critical case ids repeat for stability proof. */
  readonly caseIds: ReadonlyArray<string>;
  /** Live aggregate usage and hard-stop limits for the complete execution plan. */
  readonly budget: PlaygroundProductionSuiteBudget;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------- pipeline preview -------------------------------------------------------

/** One step of a pipeline preview: the exact snapshot start() would execute. */
export interface PipelinePreviewStep {
  readonly name: string;
  /** 'unknown' when a library reference no longer resolves. */
  readonly kind: PipelineStepKind | 'unknown';
  readonly onFailure: StepFailureMode | null;
  /** Where the step came from: written inline or referenced from the library. */
  readonly source: 'inline' | 'ref';
  /** The resolved config snapshot; null when the step could not be resolved. */
  readonly config: PipelineStep['config'] | null;
  /** Whether the engine would attempt this step (false after a pre-halt). */
  readonly willRun: boolean;
  /** Why the step will not run, when it won't. */
  readonly note: string | null;
}

/** GET /api/playground/pipeline-preview — evaluation only, zero side effects. */
export interface PipelinePreview {
  readonly pipeline: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly type: PipelineType;
    readonly autoRunOnPrOpen: boolean;
    readonly autoRunOnPrUpdate: boolean;
  };
  readonly target: {
    readonly repo: string;
    readonly prNumber: number;
    readonly title: string;
    readonly author: string;
  };
  readonly steps: ReadonlyArray<PipelinePreviewStep>;
}
